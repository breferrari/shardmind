/**
 * Install executor — disk-mutating operations.
 *
 * The counterpart to `install-planner.ts`. Functions here write, rename,
 * or delete files in the vault. Read-only enumeration and planning
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
import { errnoCode, isEnoent } from '../runtime/errno.js';
import { resolveModules } from './modules.js';
import { createRenderer, renderFile, buildRenderContext } from './renderer.js';
import {
  initShardDir,
  cacheTemplates,
  cacheManifest,
  writeState,
  STATE_SCHEMA_VERSION,
  removeEngineWrites,
  ENGINE_INSTALL_WRITES,
} from './state.js';
import { sha256, toPosix, pathExists, removePath } from './fs-utils.js';
import { hashValues, type Collision } from './install-planner.js';
import { assertSafeVaultPaths, ENGINE_SHARDMIND_ENTRIES } from './vault-path-guard.js';
import { throwIfCancelled } from './run-cancel.js';
import { attemptRollback, reasonOf, withRollbackFailures, type RollbackFailure } from './rollback-report.js';
import { missingFolders, removeCreatedFolders } from './created-folders.js';
import {
  SHARDMIND_DIR,
  VALUES_FILE,
  STATE_FILE,
  CACHED_MANIFEST,
  CACHED_SCHEMA,
  CACHED_TEMPLATES,
} from '../runtime/vault-paths.js';

export interface BackupRecord {
  originalPath: string;
  backupPath: string;
}

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
   * Fires after each successful write with the vault-relative output path.
   * Used by the command layer to maintain a live rollback list for SIGINT.
   */
  onFileWritten?: (outputPath: string) => void;
  /**
   * Fires before a write with each vault-relative folder (POSIX) the write
   * will create, so a rollback removes only folders this install made and
   * never one the user already had (#215).
   */
  onDirCreated?: (dir: string) => void;
  dryRun?: boolean;
  /**
   * Aborted on Ctrl+C (#249): checked before every write, so the run stops
   * between two writes with `CANCELLED` and is rolled back once.
   */
  signal?: AbortSignal;
}

export interface InstallResult {
  writtenPaths: string[];
  /** Folders this install created, as reported through `onDirCreated`. */
  createdDirs: string[];
  state: ShardState;
  fileCount: number;
}

export type ProgressEvent =
  | { kind: 'start'; total: number }
  | { kind: 'file'; index: number; total: number; label: string; outputPath: string }
  | { kind: 'done'; total: number };

/**
 * Rename each colliding path to `<original>.shardmind-backup-<timestamp>`.
 * Works for both files and directories (fsp.rename handles both).
 * Unique-suffix-appends when the canonical backup name already exists.
 *
 * **Transactional**: if any rename fails, the successful renames from
 * earlier in the loop are walked back (backup → original) before
 * `BACKUP_FAILED` throws. The vault is left byte-identical to its
 * pre-call state so the caller can surface the error without risking
 * that user content has been silently stashed at a `.shardmind-backup-*`
 * path. A rare secondary failure during restore-walk records the path
 * in the thrown error's hint so the user can recover manually — this is
 * the only case where partial-backup state can escape the function, and
 * we keep the user informed instead of hiding it.
 */
export async function backupCollisions(
  collisions: Collision[],
  timestamp: Date = new Date(),
  /** Called after each rename, so an interrupt mid-loop can undo the moves so far (#55). */
  onMoved?: (record: BackupRecord) => void,
  /** Checked before each rename: true stops the loop with the moves made so far (#55). */
  shouldStop?: () => boolean,
): Promise<BackupRecord[]> {
  const stamp = timestamp.toISOString().replace(/:/g, '-').replace(/\..+$/, '');
  const records: BackupRecord[] = [];

  for (const collision of collisions) {
    if (shouldStop?.()) break;
    // Name lookup and rename are both guarded: a lookup that fails (no free
    // name, an I/O error) walks back the moves already made too (#209).
    let backupPath: string;
    try {
      backupPath = await uniqueBackupPath(collision.absolutePath, stamp);
      await fsp.rename(collision.absolutePath, backupPath);
    } catch (err) {
      // Restore the renames we've already done so the vault ends up
      // indistinguishable from its pre-call state. Walk backwards — no
      // ordering dependency here, but matching the deepest-first intuition
      // makes directory-over-file edge cases behave more predictably.
      const orphaned: string[] = [];
      for (let i = records.length - 1; i >= 0; i--) {
        const record = records[i]!;
        try {
          await fsp.rename(record.backupPath, record.originalPath);
        } catch {
          // Secondary failure — user content still exists at backupPath,
          // just not at originalPath. Report it so recovery is possible.
          orphaned.push(record.backupPath);
        }
      }

      const rootMessage = err instanceof Error ? err.message : String(err);
      const hint = orphaned.length > 0
        ? `${rootMessage}. Partial backups could not be restored to: ${orphaned.join(', ')}. Move them back manually before retrying.`
        : `${rootMessage}. Earlier backups were restored; the vault is unchanged. Check permissions on the collision target and retry.`;

      throw new ShardMindError(
        `Could not back up existing ${collision.kind}: ${collision.absolutePath}`,
        'BACKUP_FAILED',
        hint,
      );
    }
    const record = { originalPath: collision.absolutePath, backupPath };
    records.push(record);
    onMoved?.(record);
  }

  return records;
}

/**
 * Move the vault owner's own entries (everything not in
 * `ENGINE_SHARDMIND_ENTRIES`) from a reinstall's old `.shardmind/` into the
 * new one, so a reinstall keeps them (#237). An entry whose name the new
 * folder already has moves under `<name>-<n>`, as `carryOverBackups` does,
 * so nothing is dropped when the old folder is deleted.
 */
export async function carryOverUserEntries(oldStateDir: string, vaultRoot: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fsp.readdir(oldStateDir);
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }
  const own = entries.filter((entry) => !ENGINE_SHARDMIND_ENTRIES.has(entry.toLowerCase()));
  if (own.length === 0) return;
  const to = path.join(vaultRoot, SHARDMIND_DIR);
  await fsp.mkdir(to, { recursive: true });
  for (const entry of own) {
    let target = path.join(to, entry);
    for (let n = 1; await pathExists(target); n++) target = path.join(to, `${entry}-${n}`);
    await fsp.rename(path.join(oldStateDir, entry), target);
  }
}

/**
 * Move the `backups/` of an old `.shardmind/` that a reinstall set aside
 * into the new one, before the old one is deleted (#55). An update's or
 * an adopt's snapshot can be the only copy of the user's earlier files.
 * Entries already in the new `backups/` are kept; an old entry whose
 * name is taken moves under `<name>-<n>`, so nothing is dropped.
 */
export async function carryOverBackups(oldStateDir: string, vaultRoot: string): Promise<void> {
  const from = path.join(oldStateDir, 'backups');
  let entries: string[];
  try {
    entries = await fsp.readdir(from);
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }
  const to = path.join(vaultRoot, SHARDMIND_DIR, 'backups');
  await fsp.mkdir(to, { recursive: true });
  for (const entry of entries) {
    let target = path.join(to, entry);
    for (let n = 1; await pathExists(target); n++) target = path.join(to, `${entry}-${n}`);
    await fsp.rename(path.join(from, entry), target);
  }
}

/**
 * Delete what an install set aside only to restore on failure, once it
 * has succeeded (#55). The old `.shardmind/` (`oldState`) first hands its
 * `backups/` and the vault owner's own entries (#237) to the new one; if
 * that fails it stays set aside, so nothing is lost. Best effort: it never throws, because the install it follows
 * is already committed.
 */
export async function discardSetAside(
  setAside: BackupRecord[],
  oldState: BackupRecord | undefined,
  vaultRoot: string,
): Promise<BackupRecord[]> {
  // What could not be removed is still there under its backup name, and is
  // returned so the summary lists it rather than calling it removed (#228).
  const left: BackupRecord[] = [];
  for (const record of setAside) {
    if (record === oldState) {
      try {
        await carryOverBackups(record.backupPath, vaultRoot);
        await carryOverUserEntries(record.backupPath, vaultRoot);
      } catch {
        left.push(record);
        continue;
      }
    }
    try {
      await removePath(record.backupPath);
    } catch {
      left.push(record);
    }
  }
  return left;
}

async function uniqueBackupPath(absolutePath: string, stamp: string): Promise<string> {
  const base = `${absolutePath}.shardmind-backup-${stamp}`;
  if (!(await pathExists(base))) return base;
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base}.${i}`;
    if (!(await pathExists(candidate))) return candidate;
  }
  throw new ShardMindError(
    `Could not find a unique backup name for ${absolutePath}`,
    'BACKUP_FAILED',
    'Too many existing backups with the same timestamp — clean up old .shardmind-backup-* files and retry.',
  );
}

/**
 * Move backup files back to their original paths. Used during rollback
 * after a failed install so the user's pre-install content comes back
 * intact. Best-effort per entry — individual failures are reported but
 * don't abort the rest of the restore.
 */
export async function restoreBackups(
  records: BackupRecord[],
): Promise<{ restored: BackupRecord[]; failed: Array<BackupRecord & { reason: string }> }> {
  const restored: BackupRecord[] = [];
  const failed: Array<BackupRecord & { reason: string }> = [];

  for (const record of records) {
    try {
      // Remove whatever the partial install wrote at the original path,
      // then move the backup back.
      await removePath(record.originalPath);
      await fsp.rename(record.backupPath, record.originalPath);
      restored.push(record);
    } catch (err) {
      failed.push({
        ...record,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { restored, failed };
}

/**
 * Execute the install pipeline: render + copy + write + cache + state.
 * Returns writtenPaths, but a caller that rolls back on failure must collect
 * paths through `onFileWritten`: when this throws, the return value never
 * arrives (#207). Each path is reported just before its write, so a write
 * that fails partway is rolled back too.
 */
export async function runInstall(opts: InstallRunnerOptions): Promise<InstallResult> {
  const { vaultRoot, manifest, schema, tempDir, resolved, tarballSha256, values, selections, onProgress, onFileWritten, onDirCreated, dryRun, signal } = opts;

  const resolution = await resolveModules(schema, selections, tempDir);
  // Refuse before the first write, dry run included, if any path would
  // send it through a link or a case-folded name (#163).
  await assertSafeVaultPaths(vaultRoot, [...resolution.render, ...resolution.copy].map((e) => e.outputPath));
  const totalFiles = resolution.render.length + resolution.copy.length;
  const writtenPaths: string[] = [];
  const createdDirs: string[] = [];
  // Report a path before its write, with every folder the write will create,
  // so a rollback removes exactly what this install made (#207, #215, #258).
  // A folder an earlier write created exists by then, so it is never
  // reported twice.
  const folderSeen = new Map<string, boolean>();
  const recordWrite = async (rel: string): Promise<void> => {
    // Every write is recorded first, so this is the one place to stop (#249).
    throwIfCancelled(signal);
    for (const dir of await missingFolders(vaultRoot, [rel], { seen: folderSeen })) {
      createdDirs.push(dir);
      onDirCreated?.(dir);
    }
    writtenPaths.push(rel);
    onFileWritten?.(rel);
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
      await writeVaultFileBuffer(vaultRoot, entry.outputPath, buffer);
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
    // The engine's own `.shardmind/` entries, each recorded like any other
    // write: a rollback removes these and never `.shardmind/` wholesale,
    // which may hold the user's files (`boundary-ignore`, #190, #215).
    await recordWrite(toPosixRel(CACHED_TEMPLATES));
    await initShardDir(vaultRoot);
    await cacheTemplates(vaultRoot, tempDir);
    await recordWrite(toPosixRel(CACHED_MANIFEST));
    await recordWrite(toPosixRel(CACHED_SCHEMA));
    await cacheManifest(vaultRoot, manifest, schema, tempDir);
    await recordWrite(toPosixRel(STATE_FILE));
    await writeState(vaultRoot, state);
    // Recorded only once written: the exclusive write fails on the user's
    // own stray values file, which must survive the rollback.
    await writeValuesFile(vaultRoot, values);
    writtenPaths.push(VALUES_FILE);
    onFileWritten?.(VALUES_FILE);
  }

  return { writtenPaths, createdDirs, state, fileCount: totalFiles };
}

/**
 * Roll back a partial install: remove every path it wrote (the engine's
 * `.shardmind/` entries included), then the folders it created, then
 * restore any backups. Removes only what this install made: never
 * `.shardmind/` wholesale, and never a folder the user already had (#215).
 * Best-effort: it never throws. It returns what it could not undo (#247):
 * each backup it could not move back, with where that backup still is,
 * each file it wrote but could not remove, and each folder it created that
 * `rmdir` refused for a reason other than holding files (#258), so the
 * caller reports the rollback as incomplete.
 *
 * `createdDirs` is what `runInstall` reported through `onDirCreated`; only
 * those folders are removed, and only when empty.
 */
export async function rollbackInstall(
  vaultRoot: string,
  writtenPaths: string[],
  backups: BackupRecord[],
  createdDirs: string[],
): Promise<RollbackFailure[]> {
  const deepestFirst = (paths: Iterable<string>) =>
    [...paths].sort((a, b) => toPosixRel(b).split('/').length - toPosixRel(a).split('/').length);

  // The engine's own entries are `removeEngineWrites`' (below), not unlinked here.
  const failures: RollbackFailure[] = [];
  const files = new Set(writtenPaths.map(toPosixRel));
  for (const rel of ENGINE_INSTALL_WRITES) files.delete(toPosixRel(rel));
  for (const rel of deepestFirst(files)) {
    const abs = path.join(vaultRoot, rel);
    try {
      // unlink, not a recursive remove: a folder the user put at a planned
      // file path is theirs, and unlink leaves it alone.
      await fsp.unlink(abs);
    } catch (err) {
      if (isEnoent(err)) continue;
      // A folder is the user's (above). Anything else is the install's file,
      // still there, and is reported (#247).
      const isFolder = await fsp.lstat(abs).then((st) => st.isDirectory(), () => false);
      if (!isFolder) failures.push({ path: rel, reason: `unlink failed: ${reasonOf(err)}` });
    }
  }
  // The engine's own entries go whether or not they were recorded: a Ctrl+C
  // rollback snapshots the lists while `runInstall` may still be writing
  // them. Shared with adopt's rollback (#243); nothing else under
  // `.shardmind/` is touched, and the folder itself is left to `createdDirs`.
  for (const failure of await removeEngineWrites(vaultRoot, { removeEmptyDir: false })) {
    failures.push({ path: failure.path, reason: `cleanup failed: ${failure.reason}` });
  }

  // The folders it created, once empty again; one holding the user's files
  // stays (#215, #258).
  failures.push(...(await removeCreatedFolders(vaultRoot, createdDirs)));

  // Restore any backups last, so they land on paths that have been
  // freed by the file removal above.
  const { failed } = await restoreBackups(backups);
  for (const f of failed) {
    failures.push({
      path: toPosixRel(path.relative(vaultRoot, f.originalPath)),
      reason: `restore failed: ${f.reason}`,
      backup: f.backupPath,
    });
  }
  return failures;
}

/** A vault-relative path in POSIX form, whichever separator it was built with. */
function toPosixRel(rel: string): string {
  return rel.split(path.sep).join('/');
}

async function writeVaultFile(
  vaultRoot: string,
  outputPath: string,
  content: string,
): Promise<void> {
  const abs = path.join(vaultRoot, outputPath);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, 'utf-8');
}

async function writeVaultFileBuffer(
  vaultRoot: string,
  outputPath: string,
  content: Buffer,
): Promise<void> {
  const abs = path.join(vaultRoot, outputPath);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content);
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
    throw err;
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

export interface InstallTransactionOptions extends Omit<InstallRunnerOptions, 'onFileWritten' | 'onDirCreated'> {
  /**
   * What to move out of the way, in order: a reinstall's old install, the
   * untouched files, the stale ones, the user's own.
   */
  moveAside: Collision[];
  /** Absolute paths kept as backups (the Backup policy); every other move is set aside. */
  keep: ReadonlySet<string>;
  /** Absolute path of a reinstall's old `.shardmind/`, set aside like the rest. */
  oldStatePath?: string;
}

export interface InstallTransactionResult extends InstallResult {
  /** Kept as `<path>.shardmind-backup-<stamp>` and reported. */
  backups: BackupRecord[];
  /** Set aside, but `discardSetAside` could not remove them: still in the vault under their backup name. */
  left: BackupRecord[];
}

/** The errors a transaction threw after rolling back (`installRolledBack`). */
const rolledBack = new WeakSet<object>();

/** Whether the transaction that threw `err` rolled the vault back, for the error view's line. */
export function installRolledBack(err: unknown): boolean {
  return typeof err === 'object' && err !== null && rolledBack.has(err);
}

/**
 * The whole install, as `use-install-machine` runs it, owning its rollback
 * the way `runUpdate` and `runAdopt` do (#300). Moves `moveAside` out of the
 * way, runs `runInstall`, and once state.json is written discards what was
 * set aside only to be restored on failure (#55). Before that point a
 * failure, or a cancel through `signal` (#249), rolls back every write,
 * every created folder and every move, once; after it nothing is rolled
 * back. A move that fails puts the earlier moves back itself
 * (`backupCollisions`), and a cancel before the first move has nothing to
 * undo: a rollback then would delete a reinstall's old `.shardmind/`.
 * Spec: docs/IMPLEMENTATION.md §4.11b.
 */
export async function runInstallTransaction(opts: InstallTransactionOptions): Promise<InstallTransactionResult> {
  const { moveAside, keep, oldStatePath, ...installOpts } = opts;
  if (opts.dryRun) {
    const result = await runInstall(installOpts);
    return { ...result, backups: [], left: [] };
  }

  const moved: BackupRecord[] = [];
  const written: string[] = [];
  const createdDirs: string[] = [];
  // A failed move puts the earlier ones back itself, so it is not rolled back.
  await backupCollisions(moveAside, undefined, (record) => moved.push(record), () => opts.signal?.aborted ?? false);
  // Cancelled before anything moved: nothing to undo.
  if (moved.length === 0) throwIfCancelled(opts.signal);

  let result: InstallResult;
  try {
    throwIfCancelled(opts.signal);
    result = await runInstall({
      ...installOpts,
      onFileWritten: (outputPath) => written.push(outputPath),
      onDirCreated: (dir) => createdDirs.push(dir),
    });
  } catch (err) {
    const thrown = withRollbackFailures(
      err,
      await attemptRollback(() => rollbackInstall(opts.vaultRoot, written, moved, createdDirs)),
    );
    if (typeof thrown === 'object' && thrown !== null) rolledBack.add(thrown);
    throw thrown;
  }

  // Committed: state.json is on disk, so nothing below rolls back and a
  // cancel is ignored. The old install's backups and the owner's own
  // entries move into the new `.shardmind/` before the rest is removed.
  const setAside = moved.filter((m) => !keep.has(m.originalPath));
  const oldState = moved.find((m) => m.originalPath === oldStatePath);
  const left = await discardSetAside(setAside, oldState, opts.vaultRoot);
  return { ...result, backups: moved.filter((m) => keep.has(m.originalPath)), left };
}
