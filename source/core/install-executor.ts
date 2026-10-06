/**
 * Install executor — disk-mutating operations.
 *
 * The counterpart to `install-planner.ts`. Functions here write, rename,
 * or delete files in the vault, through the run's vault transaction
 * (`vault-transaction.ts`, #301). Read-only enumeration and planning
 * stays in the planner.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type {
  ShardManifest,
  ShardSchema,
  ShardState,
  FileState,
  ResolvedShard,
  ModuleSelections,
} from '../runtime/types.js';
import { ShardMindError } from '../runtime/types.js';
import { errnoCode } from '../runtime/errno.js';
import { resolveModules } from './modules.js';
import { createRenderer, renderFile, buildRenderContext } from './renderer.js';
import { initShardDir, cacheTemplates, cacheManifest, writeState, STATE_SCHEMA_VERSION } from './state.js';
import { sha256, toPosix } from './fs-utils.js';
import { hashValues, type Collision } from './install-planner.js';
import { assertSafeVaultPaths } from './vault-path-guard.js';
import { rolledBackError } from './rollback-report.js';
import { wrapWriteError } from './bug-report.js';
import { beginTransaction, type BackupRecord, type CreateRoot, type VaultTransaction } from './vault-transaction.js';
import { VALUES_FILE } from '../runtime/vault-paths.js';

export type { BackupRecord } from './vault-transaction.js';

export interface InstallRunnerOptions {
  vaultRoot: string;
  manifest: ShardManifest;
  schema: ShardSchema;
  tempDir: string;
  resolved: ResolvedShard;
  tarballSha256: string;
  values: Record<string, unknown>;
  selections: ModuleSelections;
  onProgress?: (event: ProgressEvent) => void;
  /**
   * The run's transaction (§4.28): every write is recorded on it first, and
   * the engine metadata is committed through it. None in a dry run, or in a
   * test's bare install, which writes the same files without a record.
   */
  tx?: VaultTransaction;
  dryRun?: boolean;
}

export interface InstallResult {
  writtenPaths: string[];
  state: ShardState;
  fileCount: number;
}

export type ProgressEvent =
  | { kind: 'start'; total: number }
  | { kind: 'file'; index: number; total: number; label: string; outputPath: string }
  | { kind: 'done'; total: number };

/**
 * Execute the install pipeline: render + copy + write + cache + state.
 * Each path is recorded on the transaction just before its write, so a
 * write that fails partway is rolled back too (#207); the rollback is the
 * transaction's, run by `runInstallTransaction`.
 */
export async function runInstall(opts: InstallRunnerOptions): Promise<InstallResult> {
  const { vaultRoot, manifest, schema, tempDir, resolved, tarballSha256, values, selections, onProgress, tx, dryRun } = opts;

  const resolution = await resolveModules(schema, selections, tempDir);
  // Refuse before the first write, dry run included, if any path would
  // send it through a link or a case-folded name (#163).
  await assertSafeVaultPaths(vaultRoot, [...resolution.render, ...resolution.copy].map((e) => e.outputPath));
  const totalFiles = resolution.render.length + resolution.copy.length;
  const writtenPaths: string[] = [];
  // Every write is recorded first, with the folders it will create, so a
  // rollback removes exactly what this install made (#207, #215, #258), and
  // a Ctrl+C stops the run here (#249).
  const recordWrite = async (rel: string): Promise<void> => {
    // Every path the install planned to replace was moved out of the way, so
    // a file here appeared after planning: refused, never overwritten, since
    // a rollback would then delete it (#301).
    if (tx && (await isFile(path.join(vaultRoot, rel)))) {
      throw new ShardMindError(
        `${rel} appeared after the install was planned`,
        'INSTALL_WRITE_FAILED',
        'A file was created at a path the install writes, after it was planned. Nothing was overwritten. Run shardmind install again to plan around it.',
      );
    }
    await tx?.recordWrite(rel);
    writtenPaths.push(rel);
  };
  const fileStates: Record<string, FileState> = {};

  onProgress?.({ kind: 'start', total: totalFiles });

  const env = createRenderer(tempDir);
  const context = buildRenderContext(manifest, values, selections, undefined, vaultRoot);

  let index = 0;

  for (const entry of resolution.render) {
    index++;
    onProgress?.({
      kind: 'file',
      index,
      total: totalFiles,
      label: entry.outputPath,
      outputPath: entry.outputPath,
    });

    let rendered;
    try {
      rendered = await renderFile(entry, context, env);
    } catch (err) {
      throw wrapRenderError(entry.outputPath, err);
    }

    const files = Array.isArray(rendered) ? rendered : [rendered];
    // An `_each` template's files are named only once rendered (#163).
    if (entry.iterator) await assertSafeVaultPaths(vaultRoot, files.map((f) => f.outputPath));
    for (const file of files) {
      if (!dryRun) {
        await recordWrite(file.outputPath);
        await writeVaultFile(vaultRoot, file.outputPath, file.content);
      }
      fileStates[file.outputPath] = {
        template: toPosix(tempDir, entry.sourcePath),
        rendered_hash: file.hash,
        ownership: 'managed',
        ...(entry.iterator ? { iterator_key: entry.iterator } : {}),
      };
    }
  }

  for (const entry of resolution.copy) {
    index++;
    onProgress?.({
      kind: 'file',
      index,
      total: totalFiles,
      label: entry.outputPath,
      outputPath: entry.outputPath,
    });

    const buffer = await fsp.readFile(entry.sourcePath);
    const hash = sha256(buffer);
    if (!dryRun) {
      await recordWrite(entry.outputPath);
      await writeVaultFile(vaultRoot, entry.outputPath, buffer);
    }
    fileStates[entry.outputPath] = {
      template: toPosix(tempDir, entry.sourcePath),
      rendered_hash: hash,
      ownership: 'managed',
    };
  }

  onProgress?.({ kind: 'done', total: totalFiles });

  const state: ShardState = {
    schema_version: STATE_SCHEMA_VERSION,
    shard: `${manifest.namespace}/${manifest.name}`,
    source: resolved.source,
    version: manifest.version,
    tarball_sha256: tarballSha256,
    installed_at: context.install_date,
    updated_at: context.install_date,
    values_hash: hashValues(values),
    modules: selections,
    files: fileStates,
    // `ref` / `resolvedSha` populate only on ref installs. `JSON.stringify`
    // omits undefined values, so tag installs serialize without those
    // keys at all — preserves forward-compat for pre-#76 readers.
    ref: resolved.ref?.name,
    resolvedSha: resolved.ref?.commit,
  };

  if (!dryRun) {
    // The engine's own `.shardmind/` entries: a rollback removes these, and
    // never `.shardmind/` wholesale, which may hold the user's files
    // (`boundary-ignore`, #190, #215). state.json last, so it is the point of
    // no return, as in update and adopt (#301).
    const beforeState = async (): Promise<void> => {
      await initShardDir(vaultRoot);
      await cacheTemplates(vaultRoot, tempDir);
      await cacheManifest(vaultRoot, manifest, schema, tempDir);
      await writeValuesFile(vaultRoot, values);
      // Introduced only once written: the exclusive write fails on the
      // user's own stray values file, which must survive the rollback.
      tx?.introduced.push(VALUES_FILE);
      writtenPaths.push(VALUES_FILE);
    };
    const writeStateFile = () => writeState(vaultRoot, state);
    if (tx) await tx.commitEngineMetadata({ beforeState, state: writeStateFile });
    else {
      await beforeState();
      await writeStateFile();
    }
  }

  return { writtenPaths, state, fileCount: totalFiles };
}

async function isFile(abs: string): Promise<boolean> {
  return fsp.lstat(abs).then((st) => st.isFile(), () => false);
}

async function writeVaultFile(vaultRoot: string, outputPath: string, content: string | Buffer): Promise<void> {
  const abs = path.join(vaultRoot, outputPath);
  try {
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    // A Buffer goes through untouched, so a binary copy survives.
    if (typeof content === 'string') await fsp.writeFile(abs, content, 'utf-8');
    else await fsp.writeFile(abs, content);
  } catch (err) {
    // An errno keeps its hint (#225, #301).
    throw wrapWriteError('INSTALL_WRITE_FAILED', `Could not write ${outputPath} during install`, err);
  }
}

/**
 * `wx` flag: refuse to overwrite an existing file. Catching EEXIST here
 * is the last defense against a stale values file slipping past
 * ExistingInstallGate.
 */
async function writeValuesFile(
  vaultRoot: string,
  values: Record<string, unknown>,
): Promise<void> {
  const abs = path.join(vaultRoot, VALUES_FILE);
  const serialized = stringifyYaml(values, { lineWidth: 0 }).trimEnd() + '\n';
  try {
    await fsp.writeFile(abs, serialized, { encoding: 'utf-8', flag: 'wx' });
  } catch (err) {
    if (errnoCode(err) === 'EEXIST') {
      throw new ShardMindError(
        'shard-values.yaml already exists at the install target',
        'VALUES_FILE_COLLISION',
        'Move or remove shard-values.yaml before re-running install. If `.shardmind/state.json` also exists, run `shardmind update` instead to upgrade the current install in place; without state.json, update throws UPDATE_NO_INSTALL.',
      );
    }
    throw wrapWriteError('INSTALL_WRITE_FAILED', `Could not write ${VALUES_FILE} during install`, err);
  }
}

function wrapRenderError(outputPath: string, err: unknown): ShardMindError {
  if (err instanceof ShardMindError) {
    return err;
  }
  const message = err instanceof Error ? err.message : String(err);
  return new ShardMindError(
    `Template render failed: ${outputPath}`,
    'RENDER_FAILED',
    message,
  );
}

export interface InstallTransactionOptions extends Omit<InstallRunnerOptions, 'tx'> {
  /**
   * Aborted on Ctrl+C (#249): checked before every move and write, so the
   * run stops between two of them with `CANCELLED` and is rolled back once.
   */
  signal?: AbortSignal;
  /**
   * What to move out of the way, in order: a reinstall's old install, the
   * untouched files, the stale ones, the user's own.
   */
  moveAside: Collision[];
  /** Absolute paths kept as backups (the Backup policy); every other move is set aside. */
  keep: ReadonlySet<string>;
  /**
   * When the install makes its own folder (#333): the folder and its
   * missing parents, and the lock to take once it exists. The transaction
   * makes them, and its rollback releases the lock and removes them.
   */
  createRoot?: CreateRoot;
  /** Absolute path of a reinstall's old `.shardmind/`, set aside like the rest. */
  oldStatePath?: string;
}

export interface InstallTransactionResult extends InstallResult {
  /** Kept as `<path>.shardmind-backup-<stamp>` and reported. */
  backups: BackupRecord[];
  /** Set aside, but the commit could not remove them: still in the vault under their backup name. */
  left: BackupRecord[];
}

/**
 * The whole install, as `use-install-machine` runs it, owning its rollback
 * the way `runUpdate` and `runAdopt` do (#300). On its vault transaction
 * (#301): moves `moveAside` out of the way, runs `runInstall`, and once
 * state.json is written commits, discarding what was set aside only to be
 * restored on failure (#55). Before that point a failed move, a failure, or
 * a cancel through `signal` (#249) rolls back every move, every write and
 * every created folder, once; engine entries only once their commit began,
 * so a reinstall's old install is never deleted. After it nothing is rolled
 * back. Spec: docs/IMPLEMENTATION.md §4.11b.
 */
export async function runInstallTransaction(opts: InstallTransactionOptions): Promise<InstallTransactionResult> {
  const { moveAside, keep, oldStatePath, signal, createRoot, ...installOpts } = opts;
  if (opts.dryRun) {
    const result = await runInstall(installOpts);
    return { ...result, backups: [], left: [] };
  }

  const tx = await beginTransaction(opts.vaultRoot, { kind: 'install', noPriorInstall: true, signal, createRoot });
  let result: InstallResult;
  try {
    for (const collision of moveAside) await tx.recordSetAside(collision.absolutePath, keep.has(collision.absolutePath));
    result = await runInstall({ ...installOpts, tx });
  } catch (err) {
    throw await rolledBackError(err, () => tx.rollback());
  }

  // Committed: state.json is on disk, so nothing below rolls back and a
  // cancel is ignored. The old install's backups and the owner's own
  // entries move into the new `.shardmind/` before the rest is removed.
  const { kept, left } = await tx.commit({ oldStatePath });
  return { ...result, backups: kept, left };
}
