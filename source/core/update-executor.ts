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
import { attemptRollback, reasonOf, withRollbackFailures, type RollbackFailure } from './rollback-report.js';
import { errnoCode, isEnoent } from '../runtime/errno.js';
import { pathExists, mapConcurrent } from './fs-utils.js';
import { pathsTheUpdateTouches } from './update-planner.js';
import { assertSafeVaultPaths } from './vault-path-guard.js';
import {
  assertRenameTargetFree,
  caseJournal,
  folderChanges,
  moveToFreePath,
  renameCaseInPlace,
  sameFile,
  undoCaseHops,
  type CaseJournal,
} from './rename-migrations.js';
import { hashValues } from './install-planner.js';
import {
  cacheTemplates,
  cacheManifest,
  writeState,
  initShardDir,
  STATE_SCHEMA_VERSION,
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
  /**
   * `--adopt-preexisting` (#61): a preexisting add-collision the user keeps
   * is tracked as their modified copy instead of being left untracked.
   */
  adoptPreexisting?: boolean;
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
   * list so it can erase only files this run created. A rename's new
   * path (#178) fires once before the write pass, after it was checked
   * free.
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
  /**
   * Subset of `wroteFiles`: paths whose state.files membership is *new*
   * after this update — i.e. `UpdateAction.kind === 'add'`. Excludes
   * `overwrite`, `auto_merge`, `conflict accept_new`, and
   * `restore_missing` (the file was already managed; user had deleted
   * it on disk). Source for `HookContext.newFiles`. See
   * docs/SHARD-LAYOUT.md §Hooks, state, and re-hash semantics for the
   * additive-principle invariant the hook ctx encodes.
   */
  addedFiles: string[];
  /**
   * Paths whose existing bytes were swapped wholesale for the shard's: an
   * `overwrite` of an engine-owned file, or a conflict resolved
   * `accept_new`. Not `auto_merge` (merged), `restore_missing` (the file
   * was absent) or `add`. The update summary lists these by path, since a
   * count cannot tell "replaced" from "left byte-identical" (#153).
   * Populated in dry run too.
   */
  replacedFiles: string[];
  /**
   * Preexisting add-collisions the user kept (keep mine / skip) and that
   * stay untracked, so the next update raises them again. Empty when the
   * run sets `adoptPreexisting` (#61).
   */
  keptUntracked: string[];
  /** Files a rename migration moved, old path → new path (#178). */
  renamedFiles: Array<{ from: string; to: string }>;
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
    adoptPreexisting = false,
    onProgress,
    onBackupReady,
    onFileTouched,
  } = opts;

  // Checked again at write time (#163): planning may have been a while
  // ago, behind prompts. Before the snapshot or any write, dry run included.
  const touched = pathsTheUpdateTouches(plan.actions);
  await assertSafeVaultPaths(vaultRoot, touched.writes, touched.deletes, touched.caseRenames);
  // A rename's new path was free when planned; refuse before any write if
  // something arrived there during the prompts (#178).
  for (const action of plan.actions) {
    if (action.renamedFrom !== undefined) await assertRenameTargetFree(vaultRoot, action.renamedFrom, action.path, 'update');
  }

  const backupDir = dryRun ? null : await createBackupDir(vaultRoot, now);
  const addedPaths: string[] = [];
  // In-place case renames (#169, #195), journaled so any rollback undoes them.
  const journal = backupDir === null ? undefined : caseJournal(backupDir);
  const folderMoves = folderChangesOf(touched.caseRenames);

  try {
    if (!dryRun) {
      await snapshotForRollback(vaultRoot, plan, backupDir!);
      await recordFolders(vaultRoot, touched, folderMoves, backupDir!);
      // Surface the backup dir to the caller before any writes happen
      // so a mid-write SIGINT can find it. Doing this after snapshot
      // means the directory actually contains the restore data the
      // rollback handler will need.
      onBackupReady?.(backupDir!);
    }

    // A rename's new path is introduced by this run, whichever pass fills it:
    // registered once, before any write, so a failure or Ctrl+C mid-pass
    // removes it (#178).
    if (!dryRun) {
      for (const action of plan.actions) {
        if (action.renamedFrom === undefined) continue;
        addedPaths.push(action.path);
        onFileTouched?.(action.path, true);
      }
    }

    // A folder whose case the release changes is renamed in place before any
    // file is written, where the filesystem folds case (#195): files the user
    // keeps in it move with it. Elsewhere the paired files move one by one.
    const renamedFolders = new Set<string>();
    if (!dryRun) {
      for (const move of folderMoves) {
        if (await renameCaseInPlace(vaultRoot, move.from, move.to, null, journal)) renamedFolders.add(move.from);
      }
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
      addedFiles: [],
      replacedFiles: [],
      keptUntracked: [],
      renamedFiles: [],
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
        adoptPreexisting,
        onProgress,
        onFileTouched,
        index: ++index,
        total: progressTotal,
      });
    }
    const written = new Set(summary.wroteFiles);
    for (const action of plan.actions) {
      if (action.renamedFrom === undefined) continue;
      await completeRename(action, action.renamedFrom, {
        written,
        vaultRoot,
        nextFiles,
        summary,
        addedPaths,
        dryRun,
        journal,
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
    // An old folder spelling the moves vacated, where it is a folder of its
    // own (a case-sensitive filesystem): removed once empty, never with the
    // user's files in it (#195).
    if (!dryRun) {
      for (const move of [...folderMoves].reverse()) {
        if (renamedFolders.has(move.from)) continue;
        await fsp.rmdir(path.join(vaultRoot, move.from)).catch(() => {});
      }
    }

    onProgress?.({ kind: 'done', total: progressTotal });

    const nextState: ShardState = {
      schema_version: STATE_SCHEMA_VERSION,
      shard: `${newManifest.namespace}/${newManifest.name}`,
      source: resolved.source,
      version: newManifest.version,
      tarball_sha256: tarballSha256,
      installed_at: currentState.installed_at,
      updated_at: now.toISOString(),
      values_hash: hashValues(newValues),
      modules: newSelections,
      files: nextFiles,
      // `resolved.ref` always reflects the *freshly resolved* SHA on
      // ref installs (the update machine reconstructs the ref source
      // string from `currentState.ref` before calling `resolve`), so
      // a bumped branch HEAD always advances `state.resolvedSha` here.
      // Tag installs leave both keys absent on disk per JSON.stringify
      // dropping undefined values.
      ref: resolved.ref?.name,
      resolvedSha: resolved.ref?.commit,
      // Carry the prior bootstrap fingerprint forward. The hook orchestrator
      // overwrites it only when `bootstrap` actually re-runs (fingerprint
      // changed); a no-rerun update must not silently drop it. JSON.stringify
      // omits the key when undefined (shard never declared a fingerprint).
      bootstrap_fingerprint: currentState.bootstrap_fingerprint,
    };

    if (!dryRun) {
      await initShardDir(vaultRoot);
      await cacheTemplates(vaultRoot, newTempDir);
      await cacheManifest(vaultRoot, newManifest, newSchema, newTempDir);
      await writeValuesFile(vaultRoot, newValues);
      await writeState(vaultRoot, nextState);
    }

    return { state: nextState, summary, backupDir };
  } catch (err) {
    if (!dryRun && backupDir) {
      // A file left unrestored is never reported as rolled back (#247).
      const failures = await attemptRollback(() => rollbackUpdate(vaultRoot, backupDir, addedPaths));
      throw withRollbackFailures(err, failures);
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
  adoptPreexisting: boolean;
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
      // No write. A modified file the merge left alone is re-recorded at
      // the new render's hash, so its baseline tracks the template the
      // cache now holds.
      if (action.rebaseline) {
        const { renderedHash, ownership } = action.rebaseline;
        ctx.nextFiles[action.path] = buildFileState(action.rebaseline, renderedHash, ownership);
      }
      return;
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
        // A rename's new path is registered before the write pass (#178).
        if (action.renamedFrom === undefined) {
          if (introduced) ctx.addedPaths.push(action.path);
          ctx.onFileTouched?.(action.path, introduced);
        }
      }
      ctx.nextFiles[action.path] = buildFileState(action, action.renderedHash, 'managed');
      ctx.summary.wroteFiles.push(action.path);
      // Per the spec's "newly added in the new version" semantics, only
      // genuine `add` actions count toward `HookContext.newFiles`.
      // `overwrite` and `restore_missing` were already in state.files
      // (overwrite: managed; restore_missing: managed-but-deleted-on-
      // disk), so a hook's additive-only restriction (Invariant 3) does
      // not apply to those paths.
      if (action.kind === 'add') {
        ctx.summary.addedFiles.push(action.path);
      } else if (action.kind === 'overwrite') {
        ctx.summary.replacedFiles.push(action.path);
      }
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
      // Record the new render as the baseline, never the merged bytes: they
      // hold the user's lines, and drift would read them as engine-owned
      // (#150). A merge that produced exactly the new render is managed.
      ctx.nextFiles[action.path] = buildFileState(action, action.baselineHash, action.ownership);
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
        if (!ctx.dryRun) {
          // Copy-origin: writeAction copies the bytes; a UTF-8 write of
          // `newContent` mangles binary (#63).
          await writeAction(ctx.vaultRoot, { ...action, content: action.newContent });
        }
        ctx.nextFiles[action.path] = buildFileState(action, action.newContentHash, 'managed');
        ctx.summary.wroteFiles.push(action.path);
        // The other replacement besides `overwrite`; see `UpdateSummary.replacedFiles`.
        ctx.summary.replacedFiles.push(action.path);
        ctx.summary.conflictsAcceptedNew++;
      } else {
        // keep_mine / skip: leave the user's file on disk. For a
        // preexisting-untracked add collision, the user's file stays
        // UNTRACKED — we never silently adopt content they didn't opt in
        // to manage. For the standard modified-file conflict, track as
        // modified at the NEW RENDER's hash: recording the user's hash
        // would make the next drift read their bytes as engine-owned and
        // overwrite them silently (#150).
        if (action.preexisting && !ctx.adoptPreexisting && resolution !== 'keep_and_track') {
          // Left untracked; it will be raised again next update (#61).
          delete ctx.nextFiles[action.path];
          ctx.summary.keptUntracked.push(action.path);
        } else {
          // A modified file — or the user's own file at a newly added path,
          // tracked as their modified copy by --adopt-preexisting or by
          // "Keep mine and track it" for this file (#165).
          ctx.nextFiles[action.path] = buildFileState(action, action.newContentHash, 'modified');
        }
        if (resolution === 'keep_mine' || resolution === 'keep_and_track') ctx.summary.conflictsKeptMine++;
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

/**
 * The state entry for a file the update tracks. `renderedHash` is the
 * engine's baseline (`docs/SHARD-LAYOUT.md §Re-hash + state`): the bytes
 * the engine produced, never the user's.
 */
function buildFileState(
  source: { templateKey: string | null; iteratorKey?: string },
  renderedHash: string,
  ownership: FileState['ownership'],
): FileState {
  return {
    template: source.templateKey,
    rendered_hash: renderedHash,
    ownership,
    ...(source.iteratorKey ? { iterator_key: source.iteratorKey } : {}),
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

/**
 * Finish a rename migration's move once the write pass is done (#178). An
 * action that wrote its new path leaves the old file to delete; one that
 * wrote nothing (no change, a volatile file, a conflict kept as mine or
 * skipped) moves the old file across. The state entry moves with it, and
 * the new path counts as added so a rollback removes it.
 */
async function completeRename(
  action: UpdateAction,
  from: string,
  ctx: {
    vaultRoot: string;
    nextFiles: Record<string, FileState>;
    summary: UpdateSummary;
    addedPaths: string[];
    dryRun: boolean;
    /** The paths the write pass wrote. */
    written: ReadonlySet<string>;
    journal?: CaseJournal;
  },
): Promise<void> {
  const to = action.path;
  // What the write pass did, not a re-derivation of it.
  const wroteNewPath = ctx.written.has(to);
  if (!ctx.dryRun) {
    // A case-only rename on a case-folding filesystem wrote into the old
    // file itself: unlinking the old path would delete the new content, so
    // it is renamed in place (#169).
    if (wroteNewPath) {
      if (!(await renameCaseInPlace(ctx.vaultRoot, from, to, ctx.addedPaths, ctx.journal))) {
        await fsp.rm(path.join(ctx.vaultRoot, from), { force: true });
      }
    }
    // Checked at the top of the run; something may still arrive during the
    // write pass. A volatile file the user deleted has no file to move.
    else await moveToFreePath(ctx.vaultRoot, from, to, ctx.addedPaths, 'update', ctx.journal);
  }
  // An action that wrote or re-recorded the new path set its own entry;
  // otherwise the old entry moves across, under the new template keys.
  const previous = ctx.nextFiles[from];
  if (ctx.nextFiles[to] === undefined && previous !== undefined) {
    const keys = action.renamedKeys;
    ctx.nextFiles[to] = keys
      ? {
          ...previous,
          template: keys.templateKey,
          ...(keys.iteratorKey === undefined ? {} : { iterator_key: keys.iteratorKey }),
        }
      : previous;
  }
  delete ctx.nextFiles[from];
  ctx.summary.renamedFiles.push({ from, to });
}

/** The distinct folders the case-only pairs rename (#195), shallowest first. */
function folderChangesOf(pairs: ReadonlyArray<readonly [string, string]>): Array<{ from: string; to: string }> {
  const byFrom = new Map<string, { from: string; to: string }>();
  for (const [from, to] of pairs) for (const move of folderChanges(from, to)) byFrom.set(move.from, move);
  return [...byFrom.values()].sort((a, b) => a.from.split('/').length - b.from.split('/').length);
}

const FOLDERS_FILE = 'folders.json';

/**
 * Record, before any write, which folders on the way to every path the run
 * touches already exist, so a rollback removes the ones the run created
 * (`<backupDir>/folders.json`). On a case-folding filesystem a folder under
 * another spelling counts as existing.
 */
async function recordFolders(
  vaultRoot: string,
  touched: ReturnType<typeof pathsTheUpdateTouches>,
  folderMoves: ReadonlyArray<{ from: string; to: string }>,
  backupDir: string,
): Promise<void> {
  const folders = new Set<string>();
  const addFolders = (rel: string, includeLast: boolean) => {
    const segments = rel.split('/');
    for (let i = 1; i < segments.length + (includeLast ? 1 : 0); i++) folders.add(segments.slice(0, i).join('/'));
  };
  for (const rel of [...touched.writes, ...touched.deletes]) addFolders(rel, false);
  for (const move of folderMoves) addFolders(move.to, true);
  const created = await mapConcurrent([...folders], SNAPSHOT_CONCURRENCY, async (rel) =>
    (await pathExists(path.join(vaultRoot, rel))) ? null : rel,
  );
  await fsp.writeFile(
    path.join(backupDir, FOLDERS_FILE),
    JSON.stringify(created.filter((rel): rel is string => rel !== null)),
    'utf-8',
  );
}

/** Remove the folders the run created that are empty again, deepest first. */
async function removeCreatedFolders(vaultRoot: string, backupDir: string): Promise<void> {
  let created: string[];
  try {
    created = JSON.parse(await fsp.readFile(path.join(backupDir, FOLDERS_FILE), 'utf-8')) as string[];
  } catch {
    return;
  }
  created.sort((a, b) => b.split('/').length - a.split('/').length);
  for (const rel of created) await fsp.rmdir(path.join(vaultRoot, rel)).catch(() => {});
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
    // A rename deletes or moves its old path, and fills its new one (#178).
    if (action.renamedFrom !== undefined) {
      toSnapshot.add(action.renamedFrom);
      toSnapshot.add(action.path);
    }
  }
  // A case-only rename's two paths can be one file (#169): back it up once,
  // under its old name, which a rollback restores.
  for (const [from, to] of pathsTheUpdateTouches(plan.actions).caseRenames) {
    if (await sameFile(vaultRoot, from, to)) toSnapshot.delete(to);
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

  // Put back the old spelling of every file or folder renamed in place by
  // case (#169, #195). Either order with the restore below gives the same
  // tree on a case-folding filesystem (mutation-checked against the folder
  // rollback tests in tests/integration/update-renames.test.ts); undo-first
  // is chosen for readability.
  failures.push(...(await undoCaseHops(vaultRoot, backupDir)));

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

  // Folders the run created (a rename's new folder on a case-sensitive
  // filesystem, #195), once nothing is left in them.
  await removeCreatedFolders(vaultRoot, backupDir);

  return failures;
}

async function restoreTree(
  srcRoot: string,
  destRoot: string,
  failures: RollbackFailure[],
): Promise<void> {
  if (!(await pathExists(srcRoot))) return;
  // Never throws: an unreadable snapshot folder is a failure like any
  // other, and the ones collected so far must reach the user (#247).
  const walk = async (dir: string): Promise<string[]> => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      failures.push({ path: path.relative(srcRoot, dir) || '.', reason: `readdir failed: ${reasonOf(err)}`, backup: dir });
      return [];
    }
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
      // The update's snapshot is never removed, so `abs` is still there.
      failures.push({ path: rel, reason: `restore failed: ${reasonOf(err)}`, backup: abs });
    }
  }
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
  action: { path: string; content: string; copyFromSourcePath?: string },
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
