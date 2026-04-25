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
import { hashValues } from './install-planner.js';
import {
  initShardDir,
  cacheTemplates,
  cacheManifest,
  writeState,
} from './state.js';
import type { AdoptClassification, AdoptPlan } from './adopt-planner.js';

/** Cap on parallel snapshot copies — same budget update-executor uses. */
const SNAPSHOT_CONCURRENCY = 16;

/**
 * One decision per `differs` entry. The diff UI returns this shape; the
 * executor reads it. Two values mirror the spec's two-choice prompt.
 */
export type AdoptResolution = 'keep_mine' | 'use_shard';

/** Map vault-relative path → resolution for every `plan.differs[]` entry. */
export type AdoptResolutions = Record<string, AdoptResolution>;

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
  | 'differs-use-shard';

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
  installedFresh: string[];
  totalManaged: number;
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
 *                             with `rendered_hash = userHash`. No write.
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
    installedFresh: [],
    totalManaged: 0,
  };

  try {
    if (!dryRun) {
      await snapshotForRollback(vaultRoot, plan, resolutions, backupDir!);
      onBackupReady?.(backupDir!);
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
      onFileTouched?.(c.path, true);
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
          'Every `differs` classification needs a `keep_mine` or `use_shard` decision before runAdopt is called.',
        );
      }
      const action: AdoptApplyKind =
        resolution === 'keep_mine' ? 'differs-keep-mine' : 'differs-use-shard';
      onProgress?.({
        kind: 'file',
        index,
        total: totalActions,
        label: c.path,
        outputPath: c.path,
        action,
      });
      if (resolution === 'keep_mine') {
        fileStates[c.path] = buildFileState(c, c.userHash, 'modified');
        onFileTouched?.(c.path, false);
        summary.adoptedMine.push(c.path);
      } else {
        if (!dryRun) {
          await writeVaultFileBuffer(vaultRoot, c.path, c.shardContent);
        }
        fileStates[c.path] = buildFileState(c, c.shardHash, 'managed');
        onFileTouched?.(c.path, false);
        summary.adoptedShard.push(c.path);
      }
    }

    onProgress?.({ kind: 'done', total: totalActions });
    summary.totalManaged = Object.keys(fileStates).length;

    const installedAt = now.toISOString();
    const state: ShardState = {
      schema_version: 1,
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
      await cacheManifest(vaultRoot, manifest, schema);
      await writeValuesFile(vaultRoot, values);
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
 * Snapshot every path the apply phase will overwrite. Only `differs +
 * use_shard` triggers a snapshot — `matches` writes nothing,
 * `differs + keep_mine` writes nothing, and `shard-only` writes to a
 * path that doesn't exist yet (rollback erases via `addedPaths` instead).
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
  backupDir: string,
): Promise<void> {
  const filesBackupDir = path.join(backupDir, 'files');
  await fsp.mkdir(filesBackupDir, { recursive: true });

  const toSnapshot = plan.differs
    .filter((c) => resolutions[c.path] === 'use_shard')
    .map((c) => c.path);

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

  // Cleanup the engine dir in case anything was written: state.json,
  // cached manifest/schema, the templates cache. We never get here on
  // success, so dropping `.shardmind/` is safe — it didn't exist before
  // adopt by virtue of `assertAdoptable`. Best-effort: errors during
  // cleanup are logged into `failures` but don't block.
  try {
    await fsp.rm(path.join(vaultRoot, SHARDMIND_DIR), { recursive: true, force: true });
  } catch (err) {
    failures.push({
      path: SHARDMIND_DIR,
      reason: `cleanup failed: ${reasonOf(err)}`,
    });
  }
  try {
    await fsp.rm(path.join(vaultRoot, VALUES_FILE), { force: true });
  } catch (err) {
    failures.push({ path: VALUES_FILE, reason: `cleanup failed: ${reasonOf(err)}` });
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

