/**
 * Update executor — disk-mutating operations for `shardmind update`.
 *
 * Mirrors install-executor's split: the planner decides, this file acts.
 * The run's vault transaction (`vault-transaction.ts`, #301) snapshots the
 * engine's cache when it begins and each file just before it is written,
 * deleted or moved; if anything fails it walks the run back. Commands never
 * see partial state.
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
import { rolledBackError } from './rollback-report.js';
import { beginTransaction, type SnapshotTransaction } from './vault-transaction.js';
import { pathsTheUpdateTouches } from './update-planner.js';
import { assertSafeVaultPaths } from './vault-path-guard.js';
import { throwIfCancelled } from './run-cancel.js';
import {
  assertRenameTargetFree,
  folderChanges,
  moveToFreePath,
  renameCaseInPlace,
} from './rename-migrations.js';
import { hashValues } from './install-planner.js';
import {
  cacheTemplates,
  cacheManifest,
  writeState,
  initShardDir,
  STATE_SCHEMA_VERSION,
} from './state.js';
import { VALUES_FILE } from '../runtime/vault-paths.js';
import type {
  UpdatePlan,
  UpdateAction,
  ConflictResolution,
} from './update-planner.js';
import { wrapWriteError } from './bug-report.js';

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
   * Aborted on Ctrl+C (#249): checked before every write, so the run stops
   * between two writes with `CANCELLED` and is rolled back once.
   */
  signal?: AbortSignal;
  /**
   * `--adopt-preexisting` (#61): a preexisting add-collision the user keeps
   * is tracked as their modified copy instead of being left untracked.
   */
  adoptPreexisting?: boolean;
  onProgress?: (event: UpdateProgressEvent) => void;
  /**
   * Fires exactly once, after the backup directory is created and the
   * engine cache snapshotted, before any vault mutation happens. Progress
   * only: the rollback is runUpdate's own, in its catch, and a Ctrl+C
   * reaches it through `signal` (#249).
   */
  onBackupReady?: (backupDir: string) => void;
  /**
   * Fires after each write with the file's vault-relative path and
   * whether the run introduced it (nothing was there when it was
   * recorded): the same list runUpdate's own rollback erases, so a caller can see exactly which files this run created. A rename's new
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
  /** Resolved in the user's editor (#50). */
  conflictsEdited: number;
  autoMergeStats: MergeStats;
  wroteFiles: string[];
  deletedFiles: string[];
  /**
   * Subset of `wroteFiles`: paths whose state.files membership is *new*
   * after this update — i.e. `UpdateAction.kind === 'add'`. Excludes
   * `overwrite`, `auto_merge`, `conflict accept_new`, and
   * `restore_missing` (the file was already managed; user had deleted
   * it on disk). Also excludes a preexisting add-collision the user kept
   * and tracked (`keep_and_track`, `--adopt-preexisting`): its bytes are
   * the user's, not new shard output. Source for `HookContext.newFiles`. See
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
 *   1. Begin the vault transaction: `.shardmind/backups/update-<ts>/`,
 *      with the engine cache snapshotted.
 *   2. Apply each action in dependency-safe order (deletes last so a new
 *      file at the same path can't collide with the about-to-be-deleted
 *      one), recording each path just before it is touched.
 *   3. Re-cache manifest/schema/templates, re-write values, then write
 *      the new state.json last (`commitEngineMetadata`).
 *   4. On any exception before the state write, the transaction's
 *      rollback undoes the run: case renames, introduced paths, the
 *      snapshot, the engine cache, the folders it created.
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
    signal,
    adoptPreexisting = false,
    onProgress,
    onBackupReady,
    onFileTouched,
  } = opts;

  // Every conflict must arrive decided (#292). The machine resolves each
  // pending conflict before it writes, so a missing one is a caller bug:
  // refuse it before anything is snapshotted or written, and never choose
  // for the user. Adopt's executor has the same guard.
  for (const action of plan.actions) {
    if (action.kind === 'conflict' && !Object.hasOwn(conflictResolutions, action.path)) {
      throw new ShardMindError(
        `Missing update resolution for ${action.path}`,
        'UPDATE_WRITE_FAILED',
        'Every pending conflict needs a resolution before runUpdate is called. This is a shardmind bug: please report it.',
      );
    }
  }

  // Checked again at write time (#163): planning may have been a while
  // ago, behind prompts. Before the snapshot or any write, dry run included.
  const touched = pathsTheUpdateTouches(plan.actions);
  await assertSafeVaultPaths(vaultRoot, touched.writes, touched.deletes, touched.caseRenames);
  // A rename's new path was free when planned; refuse before any write if
  // something arrived there during the prompts (#178).
  for (const action of plan.actions) {
    if (action.renamedFrom !== undefined) await assertRenameTargetFree(vaultRoot, action.renamedFrom, action.path, 'update');
  }

  // The engine cache is snapshotted here; each vault file just before the
  // run writes, deletes or moves onto it (§4.28).
  const tx = dryRun
    ? null
    : await beginTransaction(vaultRoot, { kind: 'update', now, signal, noPriorInstall: false });
  const folderMoves = folderChangesOf(touched.caseRenames);

  try {
    if (tx) {
      // Before any write. Progress only: the rollback is this run's own
      // catch (#249).
      onBackupReady?.(tx.dir);
      // A rename's new path is introduced by this run, whichever pass fills
      // it, and its old file is snapshotted: recorded once, before any write,
      // so a failure or Ctrl+C mid-pass removes the one and restores the
      // other (#178).
      for (const action of plan.actions) {
        if (action.renamedFrom === undefined) continue;
        await tx.recordMove(action.renamedFrom, action.path);
        onFileTouched?.(action.path, true);
      }
    }

    // A folder whose case the release changes is renamed in place before any
    // file is written, where the filesystem folds case (#195): files the user
    // keeps in it move with it. Elsewhere the paired files move one by one.
    const renamedFolders = new Set<string>();
    if (tx) {
      for (const move of folderMoves) {
        await tx.recordFolder(move.to);
        if (await renameFolderCase(vaultRoot, move, tx)) renamedFolders.add(move.from);
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
      conflictsEdited: 0,
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
      if (!dryRun) throwIfCancelled(signal);
      await applyWriteAction(action, {
        vaultRoot,
        conflictResolutions,
        nextFiles,
        summary,
        tx,
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
      if (!dryRun) throwIfCancelled(signal);
      await completeRename(action, action.renamedFrom, {
        written,
        vaultRoot,
        nextFiles,
        summary,
        tx,
      });
    }
    for (const action of plan.actions) {
      if (!isDeleteAction(action)) continue;
      if (!dryRun) throwIfCancelled(signal);
      await applyDeleteAction(action, {
        vaultRoot,
        nextFiles,
        summary,
        tx,
        onProgress,
        index: ++index,
        total: progressTotal,
      });
    }
    // An old folder spelling the moves vacated, where it is a folder of its
    // own (a case-sensitive filesystem): removed once empty, never with the
    // user's files in it (#195).
    if (tx) {
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

    if (tx) {
      await tx.commitEngineMetadata({
        beforeState: async () => {
          await initShardDir(vaultRoot);
          await cacheTemplates(vaultRoot, newTempDir);
          await cacheManifest(vaultRoot, newManifest, newSchema, newTempDir);
          await writeValuesFile(vaultRoot, newValues);
        },
        state: () => writeState(vaultRoot, nextState),
      });
    }

    return { state: nextState, summary, backupDir: tx?.dir ?? null };
  } catch (err) {
    // A file left unrestored is never reported as rolled back (#247).
    if (tx) throw await rolledBackError(err, () => tx.rollback());
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
  /** The run's transaction; null in a dry run, which writes nothing. */
  tx: SnapshotTransaction | null;
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
  tx: SnapshotTransaction | null;
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
      if (ctx.tx) {
        // A file already there (an untracked user file at an added path, a
        // file the previous install didn't record) is snapshotted, so a
        // rollback restores it; a path with nothing there is introduced, so
        // a rollback removes it.
        await ctx.tx.recordWrite(action.path);
        await writeAction(ctx.vaultRoot, action);
        // A rename's new path is reported before the write pass (#178).
        if (action.renamedFrom === undefined) ctx.onFileTouched?.(action.path, ctx.tx.introduced.includes(action.path));
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
      if (ctx.tx) {
        await ctx.tx.recordWrite(action.path);
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
      // Checked present for every conflict before the run started (#292).
      const resolution = ctx.conflictResolutions[action.path]!;
      ctx.onProgress?.({
        kind: 'file',
        index: ctx.index,
        total: ctx.total,
        label: action.path,
        outputPath: action.path,
        action: action.kind,
      });
      if (typeof resolution === 'object') {
        // Edited in the user's editor (#50): their text, written as text
        // (an edit is never offered for a binary file), and tracked as
        // their modified copy at the shard's hash, the §4.7 baseline (#150).
        if (ctx.tx) {
          await ctx.tx.recordWrite(action.path);
          await writeAction(ctx.vaultRoot, { path: action.path, content: resolution.content });
        }
        ctx.nextFiles[action.path] = buildFileState(action, action.newContentHash, 'modified');
        ctx.summary.wroteFiles.push(action.path);
        ctx.summary.conflictsEdited++;
      } else if (resolution === 'accept_new') {
        if (ctx.tx) {
          await ctx.tx.recordWrite(action.path);
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
  if (ctx.tx) {
    await ctx.tx.recordWrite(action.path);
    await removeVaultFile(ctx.vaultRoot, action.path);
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
// Renames
// ---------------------------------------------------------------------------

/**
 * Finish a rename migration's move once the write pass is done (#178). An
 * action that wrote its new path leaves the old file to delete; one that
 * wrote nothing (no change, a volatile file, a conflict kept as mine or
 * skipped) moves the old file across. The state entry moves with it; both
 * paths were recorded before the write pass (`recordMove`), so a rollback
 * removes the new one and restores the old.
 */
async function completeRename(
  action: UpdateAction,
  from: string,
  ctx: {
    vaultRoot: string;
    nextFiles: Record<string, FileState>;
    summary: UpdateSummary;
    /** The run's transaction; null in a dry run. */
    tx: SnapshotTransaction | null;
    /** The paths the write pass wrote. */
    written: ReadonlySet<string>;
  },
): Promise<void> {
  const to = action.path;
  // What the write pass did, not a re-derivation of it.
  const wroteNewPath = ctx.written.has(to);
  const tx = ctx.tx;
  if (tx) {
    try {
      // A case-only rename on a case-folding filesystem wrote into the old
      // file itself: unlinking the old path would delete the new content, so
      // it is renamed in place (#169).
      if (wroteNewPath) {
        if (!(await renameCaseInPlace(ctx.vaultRoot, from, to, tx.introduced, tx.journal))) {
          await fsp.rm(path.join(ctx.vaultRoot, from), { force: true });
        }
      }
      // Checked at the top of the run; something may still arrive during the
      // write pass. A volatile file the user deleted has no file to move.
      else await moveToFreePath(ctx.vaultRoot, from, to, tx.introduced, 'update', tx.journal);
    } catch (err) {
      // A refusal keeps its own code; an errno keeps its hint (#225).
      throw wrapWriteError('UPDATE_WRITE_FAILED', `Could not move ${from} to ${to} during update`, err);
    }
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

// ---------------------------------------------------------------------------
// Low-level file ops
// ---------------------------------------------------------------------------

/** A delete action's removal; an errno keeps its hint (#225). */
async function removeVaultFile(vaultRoot: string, rel: string): Promise<void> {
  try {
    await fsp.rm(path.join(vaultRoot, rel), { force: true });
  } catch (err) {
    throw wrapWriteError('UPDATE_WRITE_FAILED', `Could not delete ${rel} during update`, err);
  }
}

/** A folder renamed in place by case (#195); an errno keeps its hint (#225). */
async function renameFolderCase(vaultRoot: string, move: { from: string; to: string }, tx: SnapshotTransaction): Promise<boolean> {
  try {
    return await renameCaseInPlace(vaultRoot, move.from, move.to, null, tx.journal);
  } catch (err) {
    throw wrapWriteError('UPDATE_WRITE_FAILED', `Could not rename ${move.from} to ${move.to} during update`, err);
  }
}

async function writeFile(vaultRoot: string, outputPath: string, content: string): Promise<void> {
  const abs = path.join(vaultRoot, outputPath);
  try {
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, 'utf-8');
  } catch (err) {
    throw wrapWriteError('UPDATE_WRITE_FAILED', `Could not write ${outputPath} during update`, err);
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
    throw wrapWriteError('UPDATE_WRITE_FAILED', `Could not write ${action.path} during update`, err);
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
    // Any errno, not only EACCES: a full disk keeps its hint too (#225).
    throw wrapWriteError('UPDATE_WRITE_FAILED', `Could not write ${VALUES_FILE}`, err);
  }
}
