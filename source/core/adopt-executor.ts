/**
 * Adopt executor — disk-mutating ops for `shardmind adopt`.
 *
 * Counterpart to `adopt-planner.ts`: the planner classifies, this file
 * applies decisions. Pre-flight guards refuse to run on an already-managed
 * vault (`.shardmind/state.json` present) or a vault that would collide
 * with the engine's values file (`shard-values.yaml` present); both reuse
 * existing typed errors so the install/update/adopt error contracts stay
 * symmetric.
 *
 * For every `differs-use-shard` decision we'd overwrite a user file, the
 * pre-existing bytes are first snapshot-copied to `.shardmind/backups/
 * adopt-<ts>/files/<path>`. If anything between snapshot and final
 * `state.json` write fails, `rollbackAdopt` walks the snapshot back so
 * the user's vault ends up byte-identical to its pre-adopt state. Mirrors
 * `update-executor.ts`'s rollback pattern.
 *
 * Spec: `docs/SHARD-LAYOUT.md §Adopt semantics`. The four classification
 * buckets (`matches`, `differs`, `shard-only`, plus the implicit
 * `user-only` left untouched) map onto five concrete actions here:
 * `matches` → record-only, `differs-keep-mine` → record-user-hash,
 * `differs-use-shard` → snapshot+overwrite, `shard-only` → fresh-write,
 * `user-only` → not enumerated.
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
import {
  SHARDMIND_DIR,
  STATE_FILE,
  VALUES_FILE,
} from '../runtime/vault-paths.js';
import { mapConcurrent, pathExists } from './fs-utils.js';
import { assertSafeVaultPaths } from './vault-path-guard.js';
import { assertRenameTargetFree, moveToFreePath } from './rename-migrations.js';
import { hashValues } from './install-planner.js';
import {
  initShardDir,
  cacheTemplates,
  cacheManifest,
  writeState,
  STATE_SCHEMA_VERSION,
  removeEngineWrites,
} from './state.js';
import { movedFromOf, type AdoptClassification, type AdoptPlan } from './adopt-planner.js';

/** Cap on parallel snapshot copies — same budget update-executor uses. */
const SNAPSHOT_CONCURRENCY = 16;

/**
 * One decision per `differs` entry. The diff UI returns this shape; the
 * executor reads it. Two values mirror the spec's two-choice prompt.
 */
/**
 * One decision per `differs` entry. `keep_mine` / `use_shard` mirror the
 * per-file prompt. `merged` carries the bytes produced by the auto-merge
 * mode's two-way union merge (#120) so the executor can write them without
 * re-running the merge; the machine computes them and supplies the hash.
 */
export type AdoptResolution =
  | 'keep_mine'
  | 'use_shard'
  | { kind: 'merged'; content: Buffer; hash: string };

/** Map vault-relative path → resolution for every `plan.differs[]` entry. */
export type AdoptResolutions = Record<string, AdoptResolution>;

/** A resolution that overwrites the user's file → needs a rollback snapshot. */
function overwritesUserFile(resolution: AdoptResolution | undefined): boolean {
  // `resolution != null` guards the `typeof === 'object'` branch against a
  // null map value (typeof null === 'object') even though the type excludes
  // it — this runs on unvalidated `resolutions[path]` lookups.
  return (
    resolution === 'use_shard' ||
    (resolution != null && typeof resolution === 'object' && resolution.kind === 'merged')
  );
}

export interface AdoptRunnerOptions {
  vaultRoot: string;
  manifest: ShardManifest;
  schema: ShardSchema;
  /** Extracted shard tempdir (so `cacheTemplates` can copy from it). */
  tempDir: string;
  resolved: ResolvedShard;
  tarballSha256: string;
  values: Record<string, unknown>;
  selections: ModuleSelections;
  plan: AdoptPlan;
  resolutions: AdoptResolutions;
  now?: Date;
  dryRun?: boolean;
  onProgress?: (event: AdoptProgressEvent) => void;
  /**
   * Fires once after the snapshot is staged, before any vault write.
   * Used by the command machine so a mid-write SIGINT can find the
   * backup dir its rollback handler needs.
   */
  onBackupReady?: (backupDir: string) => void;
  /**
   * Fires once per write or record-only action. `introduced=true` when
   * this run created the on-disk file (shard-only fresh install); the
   * SIGINT rollback erases only those paths. `false` for matches /
   * differs-keep-mine (we didn't write) and differs-use-shard (we
   * overwrote — restore-from-snapshot covers that one).
   */
  onFileTouched?: (outputPath: string, introduced: boolean) => void;
}

export type AdoptApplyKind =
  | 'matches'
  | 'shard-only'
  | 'differs-keep-mine'
  | 'differs-use-shard'
  | 'differs-merged';

export type AdoptProgressEvent =
  | { kind: 'start'; total: number }
  | {
      kind: 'file';
      index: number;
      total: number;
      label: string;
      outputPath: string;
      action: AdoptApplyKind;
    }
  | { kind: 'done'; total: number };

export interface AdoptResult {
  state: ShardState;
  summary: AdoptSummary;
  backupDir: string | null;
}

export interface AdoptSummary {
  matchedAuto: string[];
  adoptedMine: string[];
  adoptedShard: string[];
  /** Files written by the auto-merge mode's union merge (#120). */
  adoptedMerged: string[];
  installedFresh: string[];
  totalManaged: number;
  /** Files moved to a rename migration's new path (`--from-version`, #179). */
  renamedFiles: Array<{ from: string; to: string }>;
}

/**
 * Pre-flight guard. Refuses to run on an already-managed vault.
 * Surfaces typed errors with hints that disambiguate from install
 * (which has its own gate-component disambiguation flow). Adopt is a
 * one-shot retrofit; if state.json is already there, the user wants
 * `shardmind update`.
 */
export async function assertAdoptable(vaultRoot: string): Promise<void> {
  const stateAbs = path.join(vaultRoot, STATE_FILE);
  if (await pathExists(stateAbs)) {
    throw new ShardMindError(
      `Vault is already shardmind-managed: ${stateAbs}`,
      'ADOPT_EXISTING_INSTALL',
      'Use `shardmind update` to upgrade an existing install. To re-adopt, remove `.shardmind/state.json` (and `shard-values.yaml`) first — note that this discards the existing merge-base cache.',
    );
  }
  const valuesAbs = path.join(vaultRoot, VALUES_FILE);
  if (await pathExists(valuesAbs)) {
    throw new ShardMindError(
      `Vault has a stray ${VALUES_FILE} but no .shardmind/state.json — partial adoption state`,
      'VALUES_FILE_COLLISION',
      `Move or remove ${valuesAbs} before adopting. The engine writes this file at adopt-finish; a pre-existing one is an inconsistent state.`,
    );
  }
}

/**
 * Apply an `AdoptPlan` to the user's vault.
 *
 * Order of operations (any failure between snapshot and the final
 * `writeState` triggers `rollbackAdopt`):
 *
 *   1. Pre-flight guards — `assertAdoptable`.
 *   2. Snapshot every `differs-use-shard` path's existing user content
 *      to `.shardmind/backups/adopt-<ts>/files/<path>`. Surface the
 *      backup dir to the caller via `onBackupReady` BEFORE any write.
 *   3. Apply per-classification:
 *        - `matches`        → record managed FileState; no disk write.
 *        - `shard-only`     → write rendered/copied bytes; record
 *                             managed FileState. Track in `addedPaths`
 *                             so SIGINT rollback can erase only what
 *                             this run introduced.
 *        - `differs` + `keep_mine`  → record `ownership: 'modified'`
 *                             with `rendered_hash = shardHash`. No write.
 *        - `differs` + `merged`     → write the union bytes; record
 *                             `ownership: 'modified'` with
 *                             `rendered_hash = shardHash`.
 *        - `differs` + `use_shard`  → overwrite user file with shard
 *                             bytes; record `ownership: 'managed'`.
 *   4. `initShardDir`, `cacheTemplates`, `cacheManifest`,
 *      `writeValuesFile`, `writeState` — engine metadata.
 *
 * Returns `state` + a per-bucket summary the UI / hook layer consume.
 */
export async function runAdopt(opts: AdoptRunnerOptions): Promise<AdoptResult> {
  const {
    vaultRoot,
    manifest,
    schema,
    tempDir,
    resolved,
    tarballSha256,
    values,
    selections,
    plan,
    resolutions,
    now = new Date(),
    dryRun = false,
    onProgress,
    onBackupReady,
    onFileTouched,
  } = opts;

  await assertAdoptable(vaultRoot);
  const moves = plannedMoves(plan);
  // Every path adopt writes or starts tracking, before any of them (#163),
  // and the old paths of the files it moves, checked as writes: a moved link
  // would land at a managed path (#179).
  await assertSafeVaultPaths(vaultRoot, [
    ...[...plan.matches, ...plan.shardOnly, ...plan.differs].map((c) => c.path),
    ...moves.map((m) => m.from),
  ]);
  // A move's new path was free when classified; refuse before any write if
  // something arrived there during the prompts (#179).
  for (const move of moves) await assertRenameTargetFree(vaultRoot, move.from, move.to, 'adopt');

  // Build the writeable-action list once so we know `total` upfront for
  // progress emission. Order: matches → shard-only → differs (the differs
  // bucket fans out into keep_mine vs use_shard inside the loop).
  const totalActions =
    plan.matches.length + plan.shardOnly.length + plan.differs.length;
  onProgress?.({ kind: 'start', total: totalActions });

  const backupDir = dryRun ? null : await createBackupDir(vaultRoot, now);
  const addedPaths: string[] = [];

  const fileStates: Record<string, FileState> = {};
  const summary: AdoptSummary = {
    matchedAuto: [],
    adoptedMine: [],
    adoptedShard: [],
    adoptedMerged: [],
    installedFresh: [],
    totalManaged: 0,
    renamedFiles: [],
  };

  try {
    if (!dryRun) {
      await snapshotForRollback(vaultRoot, plan, resolutions, moves, backupDir!);
      onBackupReady?.(backupDir!);
      // A move's new path is introduced by this run, whether it is written or
      // the old file moves there: registered before any write, so a failure or
      // Ctrl+C removes it and the snapshot puts the old file back (#179).
      for (const move of moves) {
        addedPaths.push(move.to);
        onFileTouched?.(move.to, true);
      }
    }

    let index = 0;

    for (const c of plan.matches) {
      index++;
      onProgress?.({
        kind: 'file',
        index,
        total: totalActions,
        label: c.path,
        outputPath: c.path,
        action: 'matches',
      });
      fileStates[c.path] = buildFileState(c, c.shardHash, 'managed');
      onFileTouched?.(c.path, false);
      summary.matchedAuto.push(c.path);
    }

    for (const c of plan.shardOnly) {
      index++;
      onProgress?.({
        kind: 'file',
        index,
        total: totalActions,
        label: c.path,
        outputPath: c.path,
        action: 'shard-only',
      });
      if (c.kind !== 'shard-only') continue; // type narrow
      if (!dryRun) {
        await writeVaultFileBuffer(vaultRoot, c.path, c.shardContent);
        addedPaths.push(c.path);
      }
      fileStates[c.path] = buildFileState(c, c.shardHash, 'managed');
      // `introduced` reflects whether this run actually created the file
      // on disk — false under --dry-run since no write happened. Keeps
      // the SIGINT-rollback `addedPaths` accounting honest under
      // dry-run semantics (where nothing was written, nothing should
      // be erased).
      onFileTouched?.(c.path, !dryRun);
      summary.installedFresh.push(c.path);
    }

    for (const c of plan.differs) {
      index++;
      if (c.kind !== 'differs') continue;
      const resolution = resolutions[c.path];
      if (resolution === undefined) {
        throw new ShardMindError(
          `Missing adopt resolution for ${c.path}`,
          'ADOPT_WRITE_FAILED',
          'Every `differs` classification needs a `keep_mine` / `use_shard` / `merged` resolution before runAdopt is called.',
        );
      }
      const action: AdoptApplyKind =
        resolution === 'keep_mine'
          ? 'differs-keep-mine'
          : resolution === 'use_shard'
            ? 'differs-use-shard'
            : 'differs-merged';
      onProgress?.({
        kind: 'file',
        index,
        total: totalActions,
        label: c.path,
        outputPath: c.path,
        action,
      });
      // Every resolution records the SHARD's hash. Drift reads "disk equals
      // rendered_hash" as engine-owned and unchanged, so recording the
      // user's (or merged) bytes would make the first update overwrite them
      // silently (#150). The shard's hash makes them an edit, three-way
      // merged against the adopt-time cache.
      // A merge whose union is exactly the shard's bytes holds no user line.
      const managed =
        resolution === 'use_shard' || (resolution !== 'keep_mine' && resolution.hash === c.shardHash);
      fileStates[c.path] = buildFileState(c, c.shardHash, managed ? 'managed' : 'modified');
      if (resolution === 'keep_mine') {
        onFileTouched?.(c.path, false);
        summary.adoptedMine.push(c.path);
      } else if (resolution === 'use_shard') {
        if (!dryRun) {
          await writeVaultFileBuffer(vaultRoot, c.path, c.shardContent);
        }
        onFileTouched?.(c.path, false);
        summary.adoptedShard.push(c.path);
      } else {
        // Auto-merge (#120): write the union-merged bytes. The result is
        // user-customized content (it contains the user's lines), so it is
        // recorded at the shard's hash, as `modified` unless the union equals
        // the shard bytes (see above) — exactly like
        // a kept-but-edited managed file. A future `update` three-way-merges
        // it against the cached shard template, which is the proper base.
        if (!dryRun) {
          await writeVaultFileBuffer(vaultRoot, c.path, resolution.content);
        }
        onFileTouched?.(c.path, false);
        summary.adoptedMerged.push(c.path);
      }
    }

    // Finish each move once its new path holds what was decided (#179).
    for (const move of moves) {
      if (!dryRun) await completeMove(vaultRoot, move, resolutions[move.to], addedPaths);
      summary.renamedFiles.push({ from: move.from, to: move.to });
    }

    onProgress?.({ kind: 'done', total: totalActions });
    summary.totalManaged = Object.keys(fileStates).length;

    const installedAt = now.toISOString();
    const state: ShardState = {
      schema_version: STATE_SCHEMA_VERSION,
      shard: `${manifest.namespace}/${manifest.name}`,
      source: resolved.source,
      version: manifest.version,
      tarball_sha256: tarballSha256,
      installed_at: installedAt,
      updated_at: installedAt,
      values_hash: hashValues(values),
      modules: selections,
      files: fileStates,
      ref: resolved.ref?.name,
      resolvedSha: resolved.ref?.commit,
    };

    if (!dryRun) {
      await initShardDir(vaultRoot);
      await cacheTemplates(vaultRoot, tempDir);
      await cacheManifest(vaultRoot, manifest, schema, tempDir);
      await writeValuesFile(vaultRoot, values);
      // Recorded only once written: the exclusive write fails on a values
      // file the user put there mid-adopt, which the rollback must keep.
      addedPaths.push(VALUES_FILE);
      onFileTouched?.(VALUES_FILE, true);
      await writeState(vaultRoot, state);
    }

    return { state, summary, backupDir };
  } catch (err) {
    if (!dryRun && backupDir) {
      try {
        await rollbackAdopt(vaultRoot, backupDir, addedPaths);
      } catch {
        // Don't mask the original failure with a rollback failure.
      }
    }
    throw err;
  }
}

interface PlannedMove {
  from: string;
  to: string;
  /** A match: nothing writes the new path, so the old file moves there. */
  matched: boolean;
}

function plannedMoves(plan: AdoptPlan): PlannedMove[] {
  const moves: PlannedMove[] = [];
  for (const c of [...plan.matches, ...plan.differs]) {
    const from = movedFromOf(c);
    if (from !== undefined) moves.push({ from, to: c.path, matched: c.kind === 'matches' });
  }
  return moves;
}

/**
 * A match or Keep mine moves the user's file from the old path to the new
 * one; Use the shard's or a merge wrote the new path, so the old file goes.
 */
async function completeMove(
  vaultRoot: string,
  move: PlannedMove,
  resolution: AdoptResolution | undefined,
  addedPaths: string[],
): Promise<void> {
  if (!move.matched && overwritesUserFile(resolution)) {
    await fsp.rm(path.join(vaultRoot, move.from), { force: true });
    return;
  }
  // Checked before any write; something may still arrive meanwhile.
  await moveToFreePath(vaultRoot, move.from, move.to, addedPaths, 'adopt');
}

function buildFileState(
  c: AdoptClassification,
  hash: string,
  ownership: FileState['ownership'],
): FileState {
  return {
    template: c.templateKey,
    rendered_hash: hash,
    ownership,
    ...(c.iteratorKey ? { iterator_key: c.iteratorKey } : {}),
  };
}

async function createBackupDir(vaultRoot: string, now: Date): Promise<string> {
  const stamp = now.toISOString().replace(/:/g, '-').replace(/\..+$/, '');
  const backupDir = path.join(vaultRoot, SHARDMIND_DIR, 'backups', `adopt-${stamp}`);
  await fsp.mkdir(backupDir, { recursive: true });
  return backupDir;
}

/**
 * Snapshot every path the apply phase will overwrite — `differs + use_shard`
 * and `differs + merged` (auto-merge) both replace existing user bytes.
 * `matches` writes nothing, `differs + keep_mine` writes nothing, and
 * `shard-only` writes to a path that doesn't exist yet (rollback erases via
 * `addedPaths` instead).
 *
 * Tolerates ENOENT defensively: a `differs-use-shard` path whose user
 * file vanished between plan-time and execute-time is unusual but not
 * fatal — the snapshot just captures nothing and the apply phase still
 * writes the shard bytes.
 */
async function snapshotForRollback(
  vaultRoot: string,
  plan: AdoptPlan,
  resolutions: AdoptResolutions,
  moves: readonly PlannedMove[],
  backupDir: string,
): Promise<void> {
  const filesBackupDir = path.join(backupDir, 'files');
  await fsp.mkdir(filesBackupDir, { recursive: true });

  const toSnapshot = [
    ...plan.differs.filter((c) => overwritesUserFile(resolutions[c.path])).map((c) => c.path),
    // A moved file leaves its old path (#179).
    ...moves.map((m) => m.from),
  ];

  await mapConcurrent(toSnapshot, SNAPSHOT_CONCURRENCY, async (rel) => {
    const src = path.join(vaultRoot, rel);
    const dst = path.join(filesBackupDir, rel);
    try {
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await fsp.copyFile(src, dst);
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
  });
}

export interface AdoptRollbackFailure {
  path: string;
  reason: string;
}

/**
 * Restore from an adopt snapshot. Best-effort: per-file failures are
 * collected and returned so the command layer can surface them rather
 * than silently swallowing — telling the user "rolled back" while bytes
 * remain stale is worse than telling them "rollback partially failed,
 * here's what's still wrong".
 */
export async function rollbackAdopt(
  vaultRoot: string,
  backupDir: string,
  addedPaths: string[],
): Promise<AdoptRollbackFailure[]> {
  const failures: AdoptRollbackFailure[] = [];

  // Erase newly-introduced files first so a restore can't spuriously
  // succeed by landing on top of a brand-new file we wrote.
  for (const rel of addedPaths) {
    try {
      await fsp.rm(path.join(vaultRoot, rel), { force: true });
    } catch (err) {
      failures.push({ path: rel, reason: `unlink failed: ${reasonOf(err)}` });
    }
  }

  // Restore each snapshotted file. The snapshot tree mirrors the vault
  // shape, so a recursive walk + per-file copy is enough. Skip the
  // existence pre-check and let the first `readdir` ENOENT-tolerate —
  // if the snapshot dir is missing (e.g. failure before snapshotForRollback
  // finished), the walk is a no-op rather than a TOCTOU race against a
  // stat that lies the moment we read it.
  const filesDir = path.join(backupDir, 'files');
  const stack: string[] = [filesDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // ENOENT on the root is the "no snapshot" case — silent skip;
      // ENOENT on a subdir is a vanished mid-walk dir — also tolerable.
      // Anything else (EACCES, EBUSY, …) is a real failure.
      if (isEnoent(err)) continue;
      failures.push({ path: dir, reason: `readdir failed: ${reasonOf(err)}` });
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      const rel = path.relative(filesDir, full);
      const dst = path.join(vaultRoot, rel);
      try {
        await fsp.mkdir(path.dirname(dst), { recursive: true });
        await fsp.copyFile(full, dst);
      } catch (err) {
        failures.push({ path: rel, reason: `restore failed: ${reasonOf(err)}` });
      }
    }
  }

  // Remove what the adopt wrote under `.shardmind/` (state.json, the cached
  // manifest and schema, the templates cache, this run's snapshot) and
  // nothing else: `assertAdoptable` allows a `.shardmind/` without
  // state.json, which may hold the vault owner's own files (`boundary-ignore`,
  // #190, #243). The folder itself goes only if that leaves it empty. The
  // snapshot is kept when a restore from it failed: it then holds the only
  // copy of those files. `shard-values.yaml` is in `addedPaths` once the
  // adopt has written it, and was removed with them above.
  const restoreFailed = failures.some((f) => f.reason.startsWith('restore failed'));
  for (const failure of await removeEngineWrites(vaultRoot, {
    snapshotDir: restoreFailed ? null : backupDir,
    removeEmptyDir: true,
  })) {
    failures.push({ path: failure.path, reason: `cleanup failed: ${failure.reason}` });
  }

  return failures;
}

function reasonOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function writeVaultFileBuffer(
  vaultRoot: string,
  outputPath: string,
  content: Buffer,
): Promise<void> {
  const abs = path.join(vaultRoot, outputPath);
  try {
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content);
  } catch (err) {
    throw new ShardMindError(
      `Could not write ${outputPath} during adopt`,
      'ADOPT_WRITE_FAILED',
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function writeValuesFile(
  vaultRoot: string,
  values: Record<string, unknown>,
): Promise<void> {
  // `wx` flag: refuse to overwrite an existing values file. The
  // assertAdoptable guard already rejected this case, but the flag is
  // a belt-and-braces second defense against a values file that
  // appeared between guard and write (race window: user dropping
  // shard-values.yaml into the dir mid-adopt). Adopt mirrors install
  // here — both treat shard-values.yaml as engine-owned.
  const abs = path.join(vaultRoot, VALUES_FILE);
  const serialized = stringifyYaml(values, { lineWidth: 0 }).trimEnd() + '\n';
  try {
    await fsp.writeFile(abs, serialized, { encoding: 'utf-8', flag: 'wx' });
  } catch (err) {
    if (errnoCode(err) === 'EEXIST') {
      throw new ShardMindError(
        `${VALUES_FILE} appeared mid-adopt`,
        'VALUES_FILE_COLLISION',
        'A shard-values.yaml file appeared at the vault root between the pre-adopt guard and the engine write. Move it aside and re-run adopt.',
      );
    }
    throw new ShardMindError(
      `Could not write ${VALUES_FILE} during adopt`,
      'ADOPT_WRITE_FAILED',
      err instanceof Error ? err.message : String(err),
    );
  }
}

