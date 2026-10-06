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
 * Every write and move goes through the run's vault transaction
 * (`vault-transaction.ts`, #301): just before it, the user's file is
 * copied to `.shardmind/backups/adopt-<ts>/files/<path>`, or the path is
 * marked introduced. If anything before the final `state.json` write
 * fails, the transaction's rollback puts the vault back as it was.
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
import { errnoCode } from '../runtime/errno.js';
import {
  STATE_FILE,
  VALUES_FILE,
} from '../runtime/vault-paths.js';
import { pathExists } from './fs-utils.js';
import { assertSafeVaultPaths } from './vault-path-guard.js';
import { throwIfCancelled } from './run-cancel.js';
import { assertRenameTargetFree, moveToFreePath } from './rename-migrations.js';
import { hashValues } from './install-planner.js';
import {
  initShardDir,
  cacheTemplates,
  cacheManifest,
  writeState,
  STATE_SCHEMA_VERSION,
} from './state.js';
import { movedFromOf, type AdoptClassification, type AdoptPlan } from './adopt-planner.js';
import { rolledBackError } from './rollback-report.js';
import { beginTransaction } from './vault-transaction.js';
import { wrapWriteError } from './bug-report.js';

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
  /**
   * Aborted on Ctrl+C (#249): checked before every write, so the run stops
   * between two writes with `CANCELLED` and is rolled back once.
   */
  signal?: AbortSignal;
  onProgress?: (event: AdoptProgressEvent) => void;
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
}

export interface AdoptSummary {
  matchedAuto: string[];
  adoptedMine: string[];
  adoptedShard: string[];
  /** Files written by the auto-merge mode's union merge (#120). */
  adoptedMerged: string[];
  /** Files still at the `--from-version` base release, given the shard's bytes (#325). */
  updatedBehind: string[];
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
 * Order of operations (any failure before the final `writeState` runs
 * the transaction's rollback):
 *
 *   1. Pre-flight guards — `assertAdoptable`.
 *   2. Begin the transaction; each write below records itself first
 *      (`recordWrite`).
 *   3. Apply per-classification:
 *        - `matches`        → record managed FileState; no disk write.
 *        - `shard-only`     → write rendered/copied bytes; record
 *                             managed FileState. The path is
 *                             introduced, so a rollback erases only
 *                             what this run wrote.
 *        - `differs` + `keep_mine`  → record `ownership: 'modified'`
 *                             with `rendered_hash = shardHash`. No write.
 *        - `differs` + `merged`     → write the union bytes; record
 *                             `ownership: 'modified'` with
 *                             `rendered_hash = shardHash`.
 *        - `differs` + `use_shard`  → overwrite user file with shard
 *                             bytes; record `ownership: 'managed'`.
 *   4. `commitEngineMetadata`: the engine entries already there set
 *      aside, `initShardDir`, `cacheTemplates`, `cacheManifest`,
 *      `writeValuesFile`, then `writeState` last; then `commit` discards
 *      what was set aside.
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
    signal,
    onProgress,
  } = opts;

  await assertAdoptable(vaultRoot);
  // A file still at the base release takes the shard's bytes, whatever the
  // mode (#325): the user never changed it.
  const behind = new Set(plan.behind.map((c) => c.path));
  const decided: AdoptResolutions = { ...resolutions, ...Object.fromEntries([...behind].map((p) => [p, 'use_shard' as const])) };
  const differing = [...plan.differs, ...plan.behind];
  const moves = plannedMoves(plan);
  // Every path adopt writes or starts tracking, before any of them (#163),
  // and the old paths of the files it moves, checked as writes: a moved link
  // would land at a managed path (#179).
  await assertSafeVaultPaths(vaultRoot, [
    ...[...plan.matches, ...plan.shardOnly, ...differing].map((c) => c.path),
    ...moves.map((m) => m.from),
  ]);
  // A move's new path was free when classified; refuse before any write if
  // something arrived there during the prompts (#179).
  for (const move of moves) await assertRenameTargetFree(vaultRoot, move.from, move.to, 'adopt');

  // Build the writeable-action list once so we know `total` upfront for
  // progress emission. Order: matches → shard-only → differs (the differs
  // bucket fans out into keep_mine vs use_shard inside the loop).
  const totalActions =
    plan.matches.length + plan.shardOnly.length + differing.length;
  onProgress?.({ kind: 'start', total: totalActions });

  // The run's snapshot, introduced paths and created folders (#301). A
  // differing file kept as the user's, and a match, are never written.
  const tx = dryRun
    ? null
    : await beginTransaction(vaultRoot, { kind: 'adopt', now, signal, noPriorInstall: true });

  const fileStates: Record<string, FileState> = {};
  const summary: AdoptSummary = {
    matchedAuto: [],
    adoptedMine: [],
    adoptedShard: [],
    adoptedMerged: [],
    updatedBehind: [],
    installedFresh: [],
    totalManaged: 0,
    renamedFiles: [],
  };
  try {
    if (tx) {
      // A move's new path is introduced by this run, whether it is written or
      // the old file moves there, and its old path is snapshotted: both
      // recorded before any write, so a failure or Ctrl+C removes the new
      // path and puts the old file back (#179).
      for (const move of moves) {
        await tx.recordWrite(move.to);
        await tx.recordWrite(move.from);
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
      if (tx) {
        await tx.recordWrite(c.path);
        await writeVaultFileBuffer(vaultRoot, c.path, c.shardContent);
      }
      fileStates[c.path] = buildFileState(c, c.shardHash, 'managed');
      summary.installedFresh.push(c.path);
    }

    for (const c of differing) {
      index++;
      if (c.kind !== 'differs') continue;
      if (!dryRun) throwIfCancelled(signal);
      const resolution = decided[c.path];
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
        summary.adoptedMine.push(c.path);
      } else if (resolution === 'use_shard') {
        if (tx) {
          await tx.recordWrite(c.path);
          await writeVaultFileBuffer(vaultRoot, c.path, c.shardContent);
        }
        (behind.has(c.path) ? summary.updatedBehind : summary.adoptedShard).push(c.path);
      } else {
        // Auto-merge (#120): write the union-merged bytes. The result is
        // user-customized content (it contains the user's lines), so it is
        // recorded at the shard's hash, as `modified` unless the union equals
        // the shard bytes (see above) — exactly like
        // a kept-but-edited managed file. A future `update` three-way-merges
        // it against the cached shard template, which is the proper base.
        if (tx) {
          await tx.recordWrite(c.path);
          await writeVaultFileBuffer(vaultRoot, c.path, resolution.content);
        }
        summary.adoptedMerged.push(c.path);
      }
    }

    // Finish each move once its new path holds what was decided (#179).
    for (const move of moves) {
      if (tx) {
        throwIfCancelled(signal);
        await completeMove(vaultRoot, move, decided[move.to], tx.introduced);
      }
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

    if (tx) {
      await tx.commitEngineMetadata({
        beforeState: async () => {
          await initShardDir(vaultRoot);
          await cacheTemplates(vaultRoot, tempDir);
          await cacheManifest(vaultRoot, manifest, schema, tempDir);
          await writeValuesFile(vaultRoot, values);
          // Recorded only once written: the exclusive write fails on a values
          // file the user put there mid-adopt, which the rollback must keep.
          tx.introduced.push(VALUES_FILE);
        },
        state: () => writeState(vaultRoot, state),
      });
      // Committed: the engine entries a clone of the shard repo carried,
      // set aside by the commit, go. Never throws, so nothing rolls back.
      await tx.commit();
    }

    return { state, summary };
  } catch (err) {
    if (tx) {
      // A file left unrestored is never reported as rolled back (#247).
      throw await rolledBackError(err, () => tx.rollback());
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
  for (const c of [...plan.matches, ...plan.differs, ...plan.behind]) {
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
  introduced: string[],
): Promise<void> {
  try {
    if (!move.matched && overwritesUserFile(resolution)) {
      await fsp.rm(path.join(vaultRoot, move.from), { force: true });
      return;
    }
    // Checked before any write; something may still arrive meanwhile.
    await moveToFreePath(vaultRoot, move.from, move.to, introduced, 'adopt');
  } catch (err) {
    // A refusal from the move keeps its own code; an errno keeps its hint (#225).
    throw wrapWriteError('ADOPT_WRITE_FAILED', `Could not move ${move.from} to ${move.to} during adopt`, err);
  }
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
    throw wrapWriteError('ADOPT_WRITE_FAILED', `Could not write ${outputPath} during adopt`, err);
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
    throw wrapWriteError('ADOPT_WRITE_FAILED', `Could not write ${VALUES_FILE} during adopt`, err);
  }
}

