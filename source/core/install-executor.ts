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
import { errnoCode } from '../runtime/errno.js';
import { resolveModules } from './modules.js';
import { createRenderer, renderFile, buildRenderContext } from './renderer.js';
import {
  initShardDir,
  cacheTemplates,
  cacheManifest,
  writeState,
} from './state.js';
import { sha256, toPosix, pathExists } from './fs-utils.js';
import { hashValues, type Collision } from './install-planner.js';
import { SHARDMIND_DIR, VALUES_FILE } from '../runtime/vault-paths.js';

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
): Promise<BackupRecord[]> {
  const stamp = timestamp.toISOString().replace(/:/g, '-').replace(/\..+$/, '');
  const records: BackupRecord[] = [];

  for (const collision of collisions) {
    const backupPath = await uniqueBackupPath(collision.absolutePath, stamp);
    try {
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
    records.push({ originalPath: collision.absolutePath, backupPath });
  }

  return records;
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
      await fsp.rm(record.originalPath, { recursive: true, force: true });
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
 * Returns writtenPaths so the caller can roll back on later failure.
 */
export async function runInstall(opts: InstallRunnerOptions): Promise<InstallResult> {
  const { vaultRoot, manifest, schema, tempDir, resolved, tarballSha256, values, selections, onProgress, onFileWritten, dryRun } = opts;

  const resolution = await resolveModules(schema, selections, tempDir);
  const totalFiles = resolution.render.length + resolution.copy.length;
  const writtenPaths: string[] = [];
  const fileStates: Record<string, FileState> = {};

  onProgress?.({ kind: 'start', total: totalFiles });

  const env = createRenderer(tempDir);
  const context = buildRenderContext(manifest, values, selections);

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
    for (const file of files) {
      if (!dryRun) {
        await writeVaultFile(vaultRoot, file.outputPath, file.content);
        writtenPaths.push(file.outputPath);
        onFileWritten?.(file.outputPath);
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
      await writeVaultFileBuffer(vaultRoot, entry.outputPath, buffer);
      writtenPaths.push(entry.outputPath);
      onFileWritten?.(entry.outputPath);
    }
    fileStates[entry.outputPath] = {
      template: toPosix(tempDir, entry.sourcePath),
      rendered_hash: hash,
      ownership: 'managed',
    };
  }

  onProgress?.({ kind: 'done', total: totalFiles });

  const state: ShardState = {
    schema_version: 1,
    shard: `${manifest.namespace}/${manifest.name}`,
    source: resolved.source,
    version: manifest.version,
    tarball_sha256: tarballSha256,
    installed_at: context.install_date,
    updated_at: context.install_date,
    values_hash: hashValues(values),
    modules: selections,
    files: fileStates,
  };

  if (!dryRun) {
    await initShardDir(vaultRoot);
    await cacheTemplates(vaultRoot, tempDir);
    await cacheManifest(vaultRoot, manifest, schema);
    await writeState(vaultRoot, state);
    await writeValuesFile(vaultRoot, values);
    writtenPaths.push(VALUES_FILE);
    onFileWritten?.(VALUES_FILE);
  }

  return { writtenPaths, state, fileCount: totalFiles };
}

/**
 * Roll back a partial install. Removes written files, cleans up empty
 * parent directories, deletes .shardmind/ if present, and restores any
 * backups. Best-effort — errors during rollback are swallowed because
 * the primary failure is already being reported.
 */
export async function rollbackInstall(
  vaultRoot: string,
  writtenPaths: string[],
  backups: BackupRecord[] = [],
): Promise<void> {
  const sortedByDepth = [...writtenPaths].sort(
    (a, b) => b.split('/').length - a.split('/').length,
  );
  for (const rel of sortedByDepth) {
    try {
      await fsp.unlink(path.join(vaultRoot, rel));
    } catch {
      // already gone
    }
  }

  // Remove empty parent directories (best-effort, deepest first)
  const dirs = new Set<string>();
  for (const rel of writtenPaths) {
    let dir = path.dirname(rel);
    while (dir && dir !== '.' && dir !== '/') {
      dirs.add(dir);
      dir = path.dirname(dir);
    }
  }
  const sortedDirs = [...dirs].sort((a, b) => b.split('/').length - a.split('/').length);
  for (const rel of sortedDirs) {
    try {
      await fsp.rmdir(path.join(vaultRoot, rel));
    } catch {
      // non-empty or already gone
    }
  }

  try {
    await fsp.rm(path.join(vaultRoot, SHARDMIND_DIR), { recursive: true, force: true });
  } catch {
    // ignore
  }

  // Restore any backups last, so they land on paths that have been
  // freed by the file removal above.
  if (backups.length > 0) {
    await restoreBackups(backups);
  }
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
