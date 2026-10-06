/**
 * The adopt command's run, with no Ink in it (#302). Spec:
 * docs/IMPLEMENTATION.md §4.30 step 3.
 *
 * Fetches the shard, reads the vault as it is, settles each differing file
 * by mode or by asking, writes the engine metadata an install would have
 * produced (`runAdopt`), then runs the shard's hooks. Every question goes
 * through `io.ask`; the Ink machine answers from its prompts, and a headless
 * `--json` run never reaches one (a dry run stops at the plan).
 */

import { ShardMindError } from '../../runtime/types.js';
import { baseOutputHashes, classifyAdoption, partitionBehind, type AdoptBase, type AdoptClassification, type AdoptPlan } from '../adopt-planner.js';
import { twoWayUnionMerge } from '../adopt-merge.js';
import { parseFromVersion, renamesBetween } from '../rename-migrations.js';
import { sha256 } from '../fs-utils.js';
import { resolve as resolveRef } from '../registry.js';
import { DownloadCancelledError } from '../download.js';
import {
  assertAdoptable,
  runAdopt,
  type AdoptProgressEvent,
  type AdoptResolutions,
  type AdoptSummary,
} from '../adopt-executor.js';
import { checkExternalToolsForRun } from '../external-tools.js';
import type { HookOutcome } from '../hook-orchestrator.js';
import { prepareShard, type PreparedShard } from './prepare-shard.js';
import { answersWithoutPrompting, loadValuesFile, validateValues, type ValueAnswers } from './values.js';
import { FlowCancelled } from './cancelled.js';
import { runAndHooks, type FlowRunIO } from './run.js';

/** How the differing files are settled when no per-file answer is given. */
export type AdoptMode = 'keep-all-mine' | 'use-all-theirs' | 'auto-merge' | 'decide-per-file';

/** One file's answer at the per-file prompt. */
export type AdoptFileChoice = 'keep_mine' | 'use_shard';

export interface AdoptFlowInput {
  shardRef: string;
  valuesFile: string | undefined;
  yes: boolean;
  /** `--mode`: settles the differing files without the picker. */
  mode: AdoptMode | undefined;
  /** `--from-version`: the release the vault was cloned from (#179). */
  fromVersion: string | undefined;
  dryRun: boolean;
  /** `--json`: with `--dry-run`, the run returns its plan and stops. */
  json: boolean;
  /** A terminal that can prompt. Without one, the values come from flags or the run refuses. */
  interactive: boolean;
  vaultRoot: string;
  engineVersion: string | undefined;
  /** Aborted when the caller no longer wants the run (a superseded Ink run). */
  stop?: AbortSignal;
}

/** The questions the flow asks, each with the prepared shard and the run so far. */
export type AdoptQuestion =
  | { kind: 'values'; shard: PreparedShard; prefill: Record<string, unknown> }
  | { kind: 'mode'; shard: PreparedShard; answers: ValueAnswers; plan: AdoptPlan }
  | {
      kind: 'per-file';
      shard: PreparedShard;
      answers: ValueAnswers;
      plan: AdoptPlan;
      /** Every file still to decide, in order; `currentIndex` is the one asked. */
      queue: AdoptClassification[];
      currentIndex: number;
      /** The files decided so far. */
      resolutions: AdoptResolutions;
    };

export type AdoptAnswer<Q extends AdoptQuestion> = Q extends { kind: 'values' }
  ? ValueAnswers
  : Q extends { kind: 'mode' }
    ? AdoptMode
    : AdoptFileChoice;

/** What the flow reports as it goes, for a caller that shows it. */
export type AdoptFlowPhase =
  | { kind: 'loading'; message: string }
  | { kind: 'planning'; shard: PreparedShard; answers: ValueAnswers }
  | { kind: 'executing' };

export interface AdoptFlowIO extends FlowRunIO {
  ask<Q extends AdoptQuestion>(question: Q): Promise<AdoptAnswer<Q>>;
  /** A one-line warning for stderr, never stdout: a terminal run and a `--json` run alike (#347). */
  warn(message: string): void;
  phase(phase: AdoptFlowPhase): void;
  progress(event: AdoptProgressEvent): void;
}

export type AdoptFlowResult =
  | { kind: 'plan'; plan: AdoptPlan; mode: AdoptMode | null }
  | {
      kind: 'done';
      shard: PreparedShard;
      summary: AdoptSummary;
      hooks: HookOutcome[];
      externalTools: string[];
      durationMs: number;
      /** With `--from-version`: the base release, and why it could not be read, if so (#325). */
      base?: AdoptBase;
    };


/** Printed once when auto-merge is chosen: it is outside the semver promise (#347). */
export const AUTO_MERGE_EXPERIMENTAL =
  "adopt: auto-merge is experimental. It keeps your lines and the shard's, ignores lines the shard deleted, and can duplicate lines. Review the merged files.";

export async function runAdoptFlow(given: AdoptFlowInput, io: AdoptFlowIO): Promise<AdoptFlowResult> {
  // Refused before the network call: nothing downloaded can fix it. Kept
  // normalized (`v5.1.0` → `5.1.0`) for the renames and the base release.
  const input: AdoptFlowInput =
    given.fromVersion === undefined ? given : { ...given, fromVersion: parseFromVersion(given.fromVersion) };
  const { vaultRoot, dryRun, json, yes, mode } = input;
  // A mode given on the command line is in force from the start, a dry run included.
  if (mode === 'auto-merge') io.warn(AUTO_MERGE_EXPERIMENTAL);
  // `--json` is the plan surface only: executing under it would render
  // nothing and wait at a prompt nobody sees.
  if (json && !dryRun) {
    throw new ShardMindError(
      '--json is only supported together with --dry-run',
      'JSON_REQUIRES_DRY_RUN',
      'Add --dry-run to get the machine-readable plan. Executing with --json is not supported yet — run without --json to execute.',
    );
  }
  // Before the vault is read: a plan made from a vault another run is
  // changing would be stale (#253). Then the guard, before any download.
  if (!dryRun) io.lock();
  await assertAdoptable(vaultRoot);

  let shard: PreparedShard | undefined;
  try {
    shard = await prepareShard(input.shardRef, {
      resolve: (ref) => resolveRef(ref, { command: 'adopt' }),
      engineVersion: input.engineVersion,
      onLoading: (message) => io.phase({ kind: 'loading', message }),
      onCleanup: io.onCleanup,
    });
    // A run superseded while it downloaded goes no further.
    if (input.stop?.aborted) throw new FlowCancelled('Superseded by a newer run.');
    const prefill = input.valuesFile ? await loadValuesFile(input.valuesFile, shard.schema) : {};
    const answers = await valueAnswers(input, io, shard, prefill);
    return await planAndAdopt(input, io, shard, answers, mode, yes);
  } finally {
    await shard?.cleanup().catch(() => {});
  }
}

async function valueAnswers(
  input: AdoptFlowInput,
  io: AdoptFlowIO,
  shard: PreparedShard,
  prefill: Record<string, unknown>,
): Promise<ValueAnswers> {
  if (input.yes) return answersWithoutPrompting(shard.schema, prefill, true);
  // `--json` never prompts: nothing renders under it. It takes the
  // no-terminal path, as a piped run does (#198). There, `--values` holds
  // every answer; without it, refusing beats recording values nobody chose
  // (#139).
  if (!input.interactive || input.json) {
    if (input.valuesFile !== undefined) return answersWithoutPrompting(shard.schema, prefill, false);
    throw new ShardMindError(
      'No interactive terminal, and no values were supplied',
      'ADOPT_NON_INTERACTIVE_WITHOUT_VALUES',
      'Pass --values <file> to supply answers, or --yes to accept schema defaults deliberately.',
    );
  }
  return io.ask({ kind: 'values', shard, prefill });
}

async function planAndAdopt(
  input: AdoptFlowInput,
  io: AdoptFlowIO,
  shard: PreparedShard,
  given: ValueAnswers,
  mode: AdoptMode | undefined,
  yes: boolean,
): Promise<AdoptFlowResult> {
  const values = validateValues(shard.schema, given.values, 'answers');
  const answers: ValueAnswers = { values, selections: given.selections };

  // With the values final, before the plan and any diff prompt (#138).
  const externalTools = await checkExternalToolsForRun({ manifest: shard.manifest, values, dryRun: input.dryRun });
  io.phase({ kind: 'planning', shard, answers });
  const classified = await classifyAdoption({
    vaultRoot: input.vaultRoot,
    schema: shard.schema,
    manifest: shard.manifest,
    tempDir: shard.tempDir,
    values,
    selections: answers.selections,
    // Rename migrations since the cloned release (#179).
    renames:
      input.fromVersion === undefined ? undefined : renamesBetween(shard.manifest.migrations, input.fromVersion, shard.manifest.version),
  });
  // The release the vault was cloned from, rendered as this run renders the
  // target: a differing file still at it was never changed (#325). Fetched
  // only when a file differs, the one case it can change.
  const base =
    input.fromVersion === undefined || classified.differs.length === 0
      ? undefined
      : await loadBase(input.fromVersion, input, io, shard, answers);
  const plan: AdoptPlan = base
    ? { ...(base.hashes ? partitionBehind(classified, base.hashes) : classified), base: base.info }
    : classified;

  // `--json --dry-run` is the agent's decision step: the per-file plan,
  // before any mode is resolved, since choosing `--mode` is what it informs.
  // Returned even when nothing differs, so a caller always gets one (#139).
  if (input.json && input.dryRun) return { kind: 'plan', plan, mode: mode ?? null };

  const resolutions = plan.differs.length === 0 ? {} : await resolveDiffers(io, shard, answers, plan, mode, yes);
  return execute(input, io, shard, answers, plan, resolutions, externalTools);
}

/**
 * The `--from-version` base release's output hashes (#325): fetched as the
 * target was, rendered with this run's values and selections. A base that
 * cannot be resolved, downloaded, parsed or rendered leaves the run as it
 * was before #325, with the reason in the plan.
 */
async function loadBase(
  version: string,
  input: AdoptFlowInput,
  io: AdoptFlowIO,
  shard: PreparedShard,
  answers: ValueAnswers,
): Promise<{ hashes?: Map<string, string>; info: AdoptBase }> {
  let base: PreparedShard | undefined;
  try {
    if (input.stop?.aborted) throw new FlowCancelled('Superseded by a newer run.');
    base = await prepareShard(`${shard.resolved.source}@${version}`, {
      resolve: (ref) => resolveRef(ref, { command: 'adopt' }),
      // Never rendered into the vault: an engine range that no longer fits
      // is no reason to give up the comparison.
      engineVersion: undefined,
      onLoading: (message) => io.phase({ kind: 'loading', message }),
      // A Ctrl+C during the base download removes both downloads (#57).
      onCleanup: (cleanup) =>
        io.onCleanup(async () => {
          await Promise.allSettled([cleanup(), shard.cleanup()]);
        }),
      parseMessage: `Reading ${version}, the release the vault was cloned from…`,
    });
    if (input.stop?.aborted) throw new FlowCancelled('Superseded by a newer run.');
    const hashes = await baseOutputHashes({
      schema: base.schema,
      manifest: base.manifest,
      tempDir: base.tempDir,
      values: answers.values,
      selections: answers.selections,
      vaultRoot: input.vaultRoot,
    });
    return { hashes, info: { version } };
  } catch (err) {
    // A Ctrl+C or a superseded run is not a missing base: the run stops.
    if (err instanceof FlowCancelled || err instanceof DownloadCancelledError) throw err;
    return { info: { version, unavailable: err instanceof Error ? err.message : String(err) } };
  } finally {
    await base?.cleanup().catch(() => {});
    // The base's registration replaced the target's (the adapters keep one):
    // a later Ctrl+C removes the target's download again.
    io.onCleanup(shard.cleanup);
  }
}

/**
 * Every differing file's resolution: by mode (`--mode`, `keep-all-mine`
 * under `--yes`, or the picker), then each file still to decide by asking.
 */
async function resolveDiffers(
  io: AdoptFlowIO,
  shard: PreparedShard,
  answers: ValueAnswers,
  plan: AdoptPlan,
  mode: AdoptMode | undefined,
  yes: boolean,
): Promise<AdoptResolutions> {
  // `--yes` is keep-all-mine: the user's bytes are the safe default for a
  // retroactive adoption.
  const given = mode ?? (yes ? 'keep-all-mine' : undefined);
  const selected = given ?? (await io.ask({ kind: 'mode', shard, answers, plan }));
  // A mode given on the command line settles conflicts without a prompt.
  const interactive = given === undefined;
  // Chosen in the picker; a --mode auto-merge warned when the run started.
  if (interactive && selected === 'auto-merge') io.warn(AUTO_MERGE_EXPERIMENTAL);

  if (selected === 'keep-all-mine' || selected === 'use-all-theirs') {
    const decision: AdoptFileChoice = selected === 'keep-all-mine' ? 'keep_mine' : 'use_shard';
    return Object.fromEntries(plan.differs.map((c) => [c.path, decision]));
  }

  const resolutions: AdoptResolutions = {};
  let queue: AdoptClassification[] = plan.differs;
  if (selected === 'auto-merge') {
    // Two-way union each differing file: those without a conflict take the
    // merged bytes; the conflicting ones are left to decide.
    queue = [];
    for (const c of plan.differs) {
      if (c.kind !== 'differs') continue;
      const merged = twoWayUnionMerge(c.userContent, c.shardContent, c.isBinary);
      if (merged.hasConflict) queue.push(c);
      else resolutions[c.path] = { kind: 'merged', content: merged.content, hash: sha256(merged.content) };
    }
    if (!interactive) {
      // No prompt: a conflict keeps the user's bytes, and shows in the
      // summary's adoptedMine bucket.
      for (const c of queue) resolutions[c.path] = 'keep_mine';
      return resolutions;
    }
  }

  for (let currentIndex = 0; currentIndex < queue.length; currentIndex++) {
    const choice = await io.ask({ kind: 'per-file', shard, answers, plan, queue, currentIndex, resolutions: { ...resolutions } });
    resolutions[queue[currentIndex]!.path] = choice;
  }
  return resolutions;
}

async function execute(
  input: AdoptFlowInput,
  io: AdoptFlowIO,
  shard: PreparedShard,
  answers: ValueAnswers,
  plan: AdoptPlan,
  resolutions: AdoptResolutions,
  externalTools: string[],
): Promise<AdoptFlowResult> {
  const start = Date.now();
  io.phase({ kind: 'executing' });
  const { result, hooks } = await runAndHooks(
    io,
    (signal) =>
      runAdopt({
        vaultRoot: input.vaultRoot,
        manifest: shard.manifest,
        schema: shard.schema,
        tempDir: shard.tempDir,
        resolved: shard.resolved,
        tarballSha256: shard.tarballSha256,
        values: answers.values,
        selections: answers.selections,
        plan,
        resolutions,
        dryRun: input.dryRun,
        signal,
        onProgress: io.progress,
      }),
    // Adopt runs the install-side slots: bootstrap, then personalize (skipped
    // under Invariant 2). newFiles is the
    // freshly installed shard-only set.
    (done) => ({
      command: 'adopt',
      tempDir: shard.tempDir,
      manifest: shard.manifest,
      schema: shard.schema,
      vaultRoot: input.vaultRoot,
      state: done.state,
      values: answers.values,
      modules: answers.selections,
      newFiles: done.summary.installedFresh,
      removedFiles: [],
      dryRun: input.dryRun,
    }),
  );

  return {
    kind: 'done',
    shard,
    summary: result.summary,
    hooks,
    externalTools,
    durationMs: Date.now() - start,
    ...(plan.base ? { base: plan.base } : {}),
  };
}
