/**
 * Update executor — disk-mutating operations for `shardmind update`.
 *
 * Mirrors install-executor's split: the planner decides, this file acts.
 * Before any writes happen we snapshot every file the plan will touch
 * (and the engine's cache) into a per-run backup directory; if anything
 * fails we walk it back. Commands never see partial state.
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
  MergeStats,
} from '../runtime/types.js';
import { ShardMindError } from '../runtime/types.js';
import { errnoCode, isEnoent } from '../runtime/errno.js';
import { pathExists, mapConcurrent } from './fs-utils.js';
import { hashValues } from './install-planner.js';
import {
  cacheTemplates,
  cacheManifest,
  writeState,
  initShardDir,
} from './state.js';
import {
  SHARDMIND_DIR,
  VALUES_FILE,
  STATE_FILE,
  CACHED_MANIFEST,
  CACHED_SCHEMA,
  CACHED_TEMPLATES,
} from '../runtime/vault-paths.js';
import type {
  UpdatePlan,
  UpdateAction,
  ConflictResolution,
} from './update-planner.js';

/** Cap fan-out when copying snapshot files during rollback preparation. */
const SNAPSHOT_CONCURRENCY = 16;

export interface UpdateRunnerOptions {
  vaultRoot: string;
  plan: UpdatePlan;
  conflictResolutions: Record<string, ConflictResolution>;
  currentState: ShardState;
  newManifest: ShardManifest;
  newSchema: ShardSchema;
  newValues: Record<string, unknown>;
  newSelections: ModuleSelections;
  resolved: ResolvedShard;
  tarballSha256: string;
  newTempDir: string;
  now?: Date;
  dryRun?: boolean;
  onProgress?: (event: UpdateProgressEvent) => void;
  /**
   * Fires exactly once, after the backup directory is created and the
   * snapshot is staged but before any vault mutation happens. The state
   * machine uses this to populate its rollback ref so a mid-write SIGINT
   * can actually roll back — waiting for `runUpdate` to return is too
   * late because Ctrl+C fires while the run is in flight.
   */
  onBackupReady?: (backupDir: string) => void;
  /**
   * Fires after each write with the file's vault-relative path and
   * whether we newly introduced it (as opposed to overwriting an
   * existing on-disk file). Powers the SIGINT rollback's added-paths
   * list so it can erase only files this run created.
   */
  onFileTouched?: (outputPath: string, introduced: boolean) => void;
}

export type UpdateProgressEvent =
  | { kind: 'start'; total: number }
  | { kind: 'file'; index: number; total: number; label: string; outputPath: string; action: UpdateAction['kind'] }
  | { kind: 'done'; total: number };

export interface UpdateResult {
  state: ShardState;
  summary: UpdateSummary;
  backupDir: string | null;
}

export interface UpdateSummary {
  fromVersion: string;
  toVersion: string;
  counts: UpdatePlan['counts'];
  conflictsResolved: number;
  conflictsKeptMine: number;
  conflictsSkipped: number;
  conflictsAcceptedNew: number;
  autoMergeStats: MergeStats;
  wroteFiles: string[];
  deletedFiles: string[];
}

/**
 * Execute an UpdatePlan against a real vault.
 *
 * Flow:
 *   1. Snapshot every path the plan touches (file content + .shardmind/
 *      cache) into `.shardmind/backups/update-<ts>/`.
 *   2. Apply each action in dependency-safe order (deletes last so a new
 *      file at the same path can't collide with the about-to-be-deleted
 *      one).
 *   3. Re-cache manifest/schema/templates, re-write values, write new
 *      state.json.
 *   4. On any exception between step 1 and the final state write, run
 *      rollback: restore snapshots and delete any files we added that
 *      weren't in the pre-run snapshot.
 */
export async function runUpdate(opts: UpdateRunnerOptions): Promise<UpdateResult> {
  const {
    vaultRoot,
    plan,
    conflictResolutions,
    currentState,
    newManifest,
    newSchema,
    newValues,
    newSelections,
    resolved,
    tarballSha256,
    newTempDir,
    now = new Date(),
    dryRun = false,
    onProgress,
    onBackupReady,
    onFileTouched,
  } = opts;

  const backupDir = dryRun ? null : await createBackupDir(vaultRoot, now);
  const addedPaths: string[] = [];

  try {
    if (!dryRun) {
      await snapshotForRollback(vaultRoot, plan, backupDir!);
      // Surface the backup dir to the caller before any writes happen
      // so a mid-write SIGINT can find it. Doing this after snapshot
      // means the directory actually contains the restore data the
      // rollback handler will need.
      onBackupReady?.(backupDir!);
    }

    // Every action that emits an `onProgress 'file'` event counts toward
    // `total` — including conflicts resolved as keep_mine/skip that emit
    // progress but don't actually write. Counting only write-actions
    // would under-count total and let `index` overshoot 100% on the
    // progress bar.
    const progressTotal = plan.actions.filter(actionEmitsProgress).length;
    onProgress?.({ kind: 'start', total: progressTotal });

    const nextFiles: Record<string, FileState> = { ...currentState.files };
    const summary: UpdateSummary = {
      fromVersion: currentState.version,
      toVersion: newManifest.version,
      counts: plan.counts,
      conflictsResolved: 0,
      conflictsKeptMine: 0,
      conflictsSkipped: 0,
      conflictsAcceptedNew: 0,
      autoMergeStats: { linesUnchanged: 0, linesAutoMerged: 0 },
      wroteFiles: [],
      deletedFiles: [],
    };

    // Two-pass: writes first, deletes second. Writes use mkdir -p so they
    // can create parents. Deletes after means a rename-style move (delete
    // + add at a different path) won't clobber a new file.
    let index = 0;
    for (const action of plan.actions) {
      if (isDeleteAction(action)) continue;
      await applyWriteAction(action, {
        vaultRoot,
        conflictResolutions,
        nextFiles,
        summary,
        addedPaths,
        dryRun,
        onProgress,
        onFileTouched,
        index: ++index,
        total: progressTotal,
      });
    }
    for (const action of plan.actions) {
      if (!isDeleteAction(action)) continue;
      await applyDeleteAction(action, {
        vaultRoot,
        nextFiles,
        summary,
        dryRun,
        onProgress,
        index: ++index,
        total: progressTotal,
      });
    }

    onProgress?.({ kind: 'done', total: progressTotal });

    const nextState: ShardState = {
      schema_version: 1,
      shard: `${newManifest.namespace}/${newManifest.name}`,
      source: resolved.source,
      version: newManifest.version,
      tarball_sha256: tarballSha256,
      installed_at: currentState.installed_at,
      updated_at: now.toISOString(),
      values_hash: hashValues(newValues),
      modules: newSelections,
      files: nextFiles,
    };

    if (!dryRun) {
      await initShardDir(vaultRoot);
      await cacheTemplates(vaultRoot, newTempDir);
      await cacheManifest(vaultRoot, newManifest, newSchema);
      await writeValuesFile(vaultRoot, newValues);
      await writeState(vaultRoot, nextState);
    }

    return { state: nextState, summary, backupDir };
  } catch (err) {
    if (!dryRun && backupDir) {
      let rollbackFailures: RollbackFailure[] = [];
      try {
        rollbackFailures = await rollbackUpdate(vaultRoot, backupDir, addedPaths);
      } catch {
        // Rollback itself crashed — swallow and fall through to rethrow
        // the original so we never mask the root-cause failure.
      }
      if (rollbackFailures.length > 0) {
        // Surface partial-rollback detail in a NEW error rather than
        // mutating `err.message`. Mutation throws on frozen/sealed
        // third-party errors (a rare but real case for wrapped native
        // errors) and compounds if the same error is caught again
        // further up the stack and logged twice. Preserve the code when
        // we can so command-layer code-based branching still works;
        // attach the failures list and the original as `cause`.
        const summary = rollbackFailures
          .slice(0, 5)
          .map((f) => `  - ${f.path}: ${f.reason}`)
          .join('\n');
        const more = rollbackFailures.length > 5
          ? `\n  …and ${rollbackFailures.length - 5} more`
          : '';
        const baseMessage = err instanceof Error ? err.message : String(err);
        const wrapped = err instanceof ShardMindError
          ? new ShardMindError(
              `${baseMessage}\nRollback incomplete (${rollbackFailures.length} files):\n${summary}${more}`,
              err.code,
              err.hint,
            )
          : new ShardMindError(
              `${baseMessage}\nRollback incomplete (${rollbackFailures.length} files):\n${summary}${more}`,
              'UPDATE_WRITE_FAILED',
              'The update failed AND the rollback could not restore every snapshot. Check the listed paths manually.',
            );
        (wrapped as Error & { rollbackFailures?: RollbackFailure[] }).rollbackFailures =
          rollbackFailures;
        (wrapped as Error & { cause?: unknown }).cause = err;
        throw wrapped;
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Write / delete application
// ---------------------------------------------------------------------------

interface ApplyContext {
  vaultRoot: string;
  conflictResolutions: Record<string, ConflictResolution>;
  nextFiles: Record<string, FileState>;
  summary: UpdateSummary;
  addedPaths: string[];
  dryRun: boolean;
  onProgress: ((event: UpdateProgressEvent) => void) | undefined;
  onFileTouched?: (outputPath: string, introduced: boolean) => void;
  index: number;
  total: number;
}

interface DeleteContext {
  vaultRoot: string;
  nextFiles: Record<string, FileState>;
  summary: UpdateSummary;
  dryRun: boolean;
  onProgress: ((event: UpdateProgressEvent) => void) | undefined;
  index: number;
  total: number;
}

async function applyWriteAction(action: UpdateAction, ctx: ApplyContext): Promise<void> {
  switch (action.kind) {
    case 'noop':
    case 'skip_volatile':
      // No write. Planner still recorded these for reporting counts.
      return;
    case 'keep_as_user':
      // User chose "keep my edits (untrack)". The file stays on disk,
      // but we remove it from state.files so the engine no longer
      // considers it managed on future updates.
      delete ctx.nextFiles[action.path];
      return;
    case 'delete':
      // Handled in delete pass.
      return;
    case 'overwrite':
    case 'add':
    case 'restore_missing': {
      ctx.onProgress?.({
        kind: 'file',
        index: ctx.index,
        total: ctx.total,
        label: action.path,
        outputPath: action.path,
        action: action.kind,
      });
      if (!ctx.dryRun) {
        // For `add` / `restore_missing`, the path is expected to be
        // absent. If it happens to exist (an untracked user file at a
        // colliding path, or a file the previous install didn't record),
        // the snapshot-for-rollback pass already captured it — so a
        // rollback restores the original instead of leaving our content
        // in place. Rollback's added-paths list only erases paths that
        // were NEWLY introduced by this run, so we check disk first to
        // decide which list to update.
        const introduced =
          action.kind !== 'overwrite' && !(await pathExists(path.join(ctx.vaultRoot, action.path)));
        await writeAction(ctx.vaultRoot, action);
        if (introduced) ctx.addedPaths.push(action.path);
        ctx.onFileTouched?.(action.path, introduced);
      }
      ctx.nextFiles[action.path] = buildFileState(action, 'managed');
      ctx.summary.wroteFiles.push(action.path);
      return;
    }
    case 'auto_merge': {
      ctx.onProgress?.({
        kind: 'file',
        index: ctx.index,
        total: ctx.total,
        label: action.path,
        outputPath: action.path,
        action: action.kind,
      });
      if (!ctx.dryRun) {
        await writeFile(ctx.vaultRoot, action.path, action.content);
      }
      ctx.nextFiles[action.path] = buildFileState(action, 'modified');
      ctx.summary.wroteFiles.push(action.path);
      ctx.summary.autoMergeStats.linesUnchanged += action.stats.linesUnchanged;
      ctx.summary.autoMergeStats.linesAutoMerged += action.stats.linesAutoMerged;
      return;
    }
    case 'conflict': {
      const resolution = ctx.conflictResolutions[action.path] ?? 'keep_mine';
      ctx.onProgress?.({
        kind: 'file',
        index: ctx.index,
        total: ctx.total,
        label: action.path,
        outputPath: action.path,
        action: action.kind,
      });
      if (resolution === 'accept_new') {
        if (!ctx.dryRun) await writeFile(ctx.vaultRoot, action.path, action.newContent);
        ctx.nextFiles[action.path] = {
          template: action.templateKey,
          rendered_hash: action.newContentHash,
          ownership: 'managed',
          ...(action.iteratorKey ? { iterator_key: action.iteratorKey } : {}),
        };
        ctx.summary.wroteFiles.push(action.path);
        ctx.summary.conflictsAcceptedNew++;
      } else {
        // keep_mine / skip: leave the user's file on disk. `theirsHash`
        // was captured at plan time so we don't need to re-read + rehash
        // here. For a preexisting-untracked add collision, the user's
        // file stays UNTRACKED — we never silently adopt content they
        // didn't opt in to manage. For the standard modified-file
        // conflict, track as modified so next drift picks up their
        // version.
        if (action.preexisting) {
          delete ctx.nextFiles[action.path];
        } else {
          ctx.nextFiles[action.path] = {
            template: action.templateKey,
            rendered_hash: action.theirsHash,
            ownership: 'modified',
            ...(action.iteratorKey ? { iterator_key: action.iteratorKey } : {}),
          };
        }
        if (resolution === 'keep_mine') ctx.summary.conflictsKeptMine++;
        else ctx.summary.conflictsSkipped++;
      }
      ctx.summary.conflictsResolved++;
      return;
    }
  }
}

async function applyDeleteAction(action: UpdateAction, ctx: DeleteContext): Promise<void> {
  if (action.kind !== 'delete') return;
  ctx.onProgress?.({
    kind: 'file',
    index: ctx.index,
    total: ctx.total,
    label: action.path,
    outputPath: action.path,
    action: 'delete',
  });
  if (!ctx.dryRun) {
    await fsp.rm(path.join(ctx.vaultRoot, action.path), { force: true });
  }
  delete ctx.nextFiles[action.path];
  ctx.summary.deletedFiles.push(action.path);
}

function buildFileState(
  action:
    | Extract<UpdateAction, { kind: 'overwrite' | 'add' | 'restore_missing' }>
    | Extract<UpdateAction, { kind: 'auto_merge' }>,
  ownership: FileState['ownership'],
): FileState {
  return {
    template: action.templateKey,
    rendered_hash: action.renderedHash,
    ownership,
    ...(action.iteratorKey ? { iterator_key: action.iteratorKey } : {}),
  };
}

function isDeleteAction(action: UpdateAction): boolean {
  return action.kind === 'delete';
}

/**
 * Whether an action emits an `onProgress` event during application.
 * Every `conflict` emits progress even if its resolution is
 * `keep_mine`/`skip` (no disk write), so we use this to compute the
 * progress `total` — otherwise `index` could exceed `total` and the
 * progress bar would overshoot 100%.
 */
function actionEmitsProgress(action: UpdateAction): boolean {
  switch (action.kind) {
    case 'overwrite':
    case 'auto_merge':
    case 'add':
    case 'restore_missing':
    case 'delete':
    case 'conflict':
      return true;
    case 'noop':
    case 'skip_volatile':
    case 'keep_as_user':
      return false;
  }
}

// ---------------------------------------------------------------------------
// Snapshot + rollback
// ---------------------------------------------------------------------------

/**
 * Create a unique per-run backup directory under `.shardmind/backups/`.
 *
 * The timestamp retains milliseconds so updates in the same wall-clock
 * second don't collide. A numeric suffix is probed afterward as a final
 * guard against clock rewinds, coarse filesystem mtime granularity, and
 * two concurrent `shardmind update` invocations that happen to hit the
 * exact same millisecond. Pattern mirrors `install-executor.uniqueBackupPath`.
 */
export async function createBackupDir(vaultRoot: string, now: Date): Promise<string> {
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  const base = path.join(vaultRoot, SHARDMIND_DIR, 'backups', `update-${stamp}`);
  for (let i = 0; i < 1000; i++) {
    const candidate = i === 0 ? base : `${base}-${i}`;
    try {
      await fsp.mkdir(candidate, { recursive: false });
      // recursive:false surfaces EEXIST, which is the collision signal.
      // Still need to create any missing parents; do that above the loop.
      return candidate;
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'ENOENT') {
        // Parent directories don't exist yet. Create them, then retry.
        await fsp.mkdir(path.dirname(base), { recursive: true });
        i--;
        continue;
      }
      if (code !== 'EEXIST') throw err;
    }
  }
  throw new ShardMindError(
    `Could not allocate a unique update backup directory under ${SHARDMIND_DIR}/backups/`,
    'UPDATE_WRITE_FAILED',
    'Too many recent updates with the same timestamp — clean up old update-* directories and retry.',
  );
}

async function snapshotForRollback(
  vaultRoot: string,
  plan: UpdatePlan,
  backupDir: string,
): Promise<void> {
  // `add` is included here too: in the normal flow the path does not
  // exist on disk, so `copyOptional` ENOENTs and does nothing. But if
  // the user has created an untracked file at the same path (e.g. an
  // orphan a previous install didn't capture), snapshotting here means
  // a rollback can restore it instead of leaving the user with our
  // overwritten content.
  const toSnapshot = new Set<string>();
  for (const action of plan.actions) {
    switch (action.kind) {
      case 'overwrite':
      case 'auto_merge':
      case 'delete':
      case 'conflict':
      case 'restore_missing':
      case 'add':
        toSnapshot.add(action.path);
        break;
      case 'noop':
      case 'skip_volatile':
      case 'keep_as_user':
        break;
    }
  }

  const filesBackupDir = path.join(backupDir, 'files');
  const cacheBackupDir = path.join(backupDir, 'cache');
  await Promise.all([
    fsp.mkdir(filesBackupDir, { recursive: true }),
    fsp.mkdir(cacheBackupDir, { recursive: true }),
  ]);

  // Copy snapshots with bounded concurrency. ENOENT is expected for
  // `missing` entries and any uninitialized cache file — tolerate both.
  await Promise.all([
    mapConcurrent([...toSnapshot], SNAPSHOT_CONCURRENCY, (rel) =>
      copyOptional(path.join(vaultRoot, rel), path.join(filesBackupDir, rel)),
    ),
    mapConcurrent(
      [STATE_FILE, CACHED_MANIFEST, CACHED_SCHEMA, VALUES_FILE],
      SNAPSHOT_CONCURRENCY,
      (rel) => copyOptional(path.join(vaultRoot, rel), path.join(cacheBackupDir, rel)),
    ),
    (async () => {
      const templatesSrc = path.join(vaultRoot, CACHED_TEMPLATES);
      try {
        await fsp.cp(templatesSrc, path.join(cacheBackupDir, CACHED_TEMPLATES), {
          recursive: true,
        });
      } catch (err) {
        if (!isEnoent(err)) throw err;
      }
    })(),
  ]);
}

async function copyOptional(src: string, dst: string): Promise<void> {
  try {
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.copyFile(src, dst);
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
}

export interface RollbackFailure {
  path: string;
  reason: string;
}

/**
 * Restore from a snapshot. Returns a list of per-file failures so the
 * caller can surface them — silently swallowing rollback errors would
 * tell the user "rollback done" while the vault sat in a partially-
 * restored state. Best-effort across every file: one failure does not
 * abort the rest of the restore.
 */
export async function rollbackUpdate(
  vaultRoot: string,
  backupDir: string,
  addedPaths: string[],
): Promise<RollbackFailure[]> {
  const failures: RollbackFailure[] = [];

  // Remove anything we newly introduced first so the restore-step can't
  // spuriously "succeed" by landing a snapshot on top of a brand-new file.
  for (const rel of addedPaths) {
    try {
      await fsp.rm(path.join(vaultRoot, rel), { force: true });
    } catch (err) {
      failures.push({ path: rel, reason: `unlink failed: ${reasonOf(err)}` });
    }
  }

  const filesDir = path.join(backupDir, 'files');
  await restoreTree(filesDir, vaultRoot, failures);

  const cacheDir = path.join(backupDir, 'cache');
  await restoreTree(cacheDir, vaultRoot, failures);

  return failures;
}

async function restoreTree(
  srcRoot: string,
  destRoot: string,
  failures: RollbackFailure[],
): Promise<void> {
  if (!(await pathExists(srcRoot))) return;
  const walk = async (dir: string): Promise<string[]> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await walk(full)));
      else out.push(full);
    }
    return out;
  };
  const files = await walk(srcRoot);
  for (const abs of files) {
    const rel = path.relative(srcRoot, abs);
    const dst = path.join(destRoot, rel);
    try {
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await fsp.copyFile(abs, dst);
    } catch (err) {
      failures.push({ path: rel, reason: `restore failed: ${reasonOf(err)}` });
    }
  }
}

function reasonOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Low-level file ops
// ---------------------------------------------------------------------------

async function writeFile(vaultRoot: string, outputPath: string, content: string): Promise<void> {
  const abs = path.join(vaultRoot, outputPath);
  try {
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, 'utf-8');
  } catch (err) {
    throw new ShardMindError(
      `Could not write ${outputPath} during update`,
      'UPDATE_WRITE_FAILED',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Write an action's content to the vault. Dispatches on
 * `copyFromSourcePath`: copy-origin actions (binary assets, scripts,
 * anything outside the Nunjucks render pipeline) get byte-copied so
 * non-UTF-8 content survives round-trip; text-origin actions get the
 * UTF-8 write. Without this split, a shard that ships a PNG would
 * have its bytes mangled the first time an update touched the file.
 */
async function writeAction(
  vaultRoot: string,
  action:
    | Extract<UpdateAction, { kind: 'overwrite' }>
    | Extract<UpdateAction, { kind: 'add' }>
    | Extract<UpdateAction, { kind: 'restore_missing' }>,
): Promise<void> {
  const abs = path.join(vaultRoot, action.path);
  try {
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    if (action.copyFromSourcePath) {
      await fsp.copyFile(action.copyFromSourcePath, abs);
    } else {
      await fsp.writeFile(abs, action.content, 'utf-8');
    }
  } catch (err) {
    throw new ShardMindError(
      `Could not write ${action.path} during update`,
      'UPDATE_WRITE_FAILED',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Overwrite `shard-values.yaml`. The install executor uses `wx` to
 * refuse existing files on a fresh install; update unconditionally
 * replaces the file because we're writing the post-migration shape
 * back. Not an atomic rename — if the process dies mid-write, the
 * snapshot-based rollback is what restores the previous content.
 */
async function writeValuesFile(
  vaultRoot: string,
  values: Record<string, unknown>,
): Promise<void> {
  const abs = path.join(vaultRoot, VALUES_FILE);
  const serialized = stringifyYaml(values, { lineWidth: 0 }).trimEnd() + '\n';
  try {
    await fsp.writeFile(abs, serialized, 'utf-8');
  } catch (err) {
    if (errnoCode(err) === 'EACCES') {
      throw new ShardMindError(
        `Could not write ${VALUES_FILE}`,
        'UPDATE_WRITE_FAILED',
        'Check filesystem permissions on the vault directory.',
      );
    }
    throw err;
  }
}
