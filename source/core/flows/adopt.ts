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
import { classifyAdoption, type AdoptClassification, type AdoptPlan } from '../adopt-planner.js';
import { twoWayUnionMerge } from '../adopt-merge.js';
import { parseFromVersion, renamesBetween } from '../rename-migrations.js';
import { sha256 } from '../fs-utils.js';
import { buildValuesValidator } from '../schema.js';
import {
  assertAdoptable,
  runAdopt,
  type AdoptProgressEvent,
  type AdoptResolutions,
  type AdoptSummary,
} from '../adopt-executor.js';
import { checkExternalToolsForRun } from '../external-tools.js';
import { runHooks, type HookOutcome, type HookRunUi } from '../hook-orchestrator.js';
import { prepareShard, type PreparedShard } from './prepare-shard.js';
import { answersWithoutPrompting, loadValuesFile, type ValueAnswers } from './values.js';

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

export interface AdoptFlowIO {
  ask<Q extends AdoptQuestion>(question: Q): Promise<AdoptAnswer<Q>>;
  phase(phase: AdoptFlowPhase): void;
  progress(event: AdoptProgressEvent): void;
  /** The hooks' phase and output; the flow supplies the signal. */
  hooks: Omit<HookRunUi, 'signal'>;
  /** The vault lock, taken before the vault is read (#253); not under --dry-run. */
  takeLock(): void;
  /** The temp dir's cleanup, as soon as it exists (#57). */
  onCleanup(cleanup: () => Promise<void>): void;
  /** The abort for the run; aborted already if a Ctrl+C came first (#249). */
  newRunAbort(): AbortController;
  /** The run in flight: a Ctrl+C aborts it and waits for its rollback. */
  onRun(abort: AbortController, run: Promise<unknown>): void;
  /** state.json is written: a Ctrl+C no longer rolls back. */
  onCommitted(): void;
  /** The hooks' abort while they run, or null once they are done. */
  onHookAbort(abort: AbortController | null): void;
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
    };

/** A prompt the user cancelled: the run ends, nothing written. */
export class FlowCancelled extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'FlowCancelled';
    this.reason = reason;
  }
}

/** The errors the executor threw after rolling the vault back. */
const rolledBack = new WeakSet<object>();

/** Whether the run that threw `err` rolled the vault back, for the error view's line. */
export function adoptRolledBack(err: unknown): boolean {
  return typeof err === 'object' && err !== null && rolledBack.has(err);
}

export async function runAdoptFlow(input: AdoptFlowInput, io: AdoptFlowIO): Promise<AdoptFlowResult> {
  const { vaultRoot, dryRun, json, yes, mode } = input;
  // `--json` is the plan surface only: executing under it would render
  // nothing and wait at a prompt nobody sees.
  if (json && !dryRun) {
    throw new ShardMindError(
      '--json is only supported together with --dry-run',
      'JSON_REQUIRES_DRY_RUN',
      'Add --dry-run to get the machine-readable plan. Executing with --json is not supported yet — run without --json to execute.',
    );
  }
  // Refused before the network call: nothing downloaded can fix it.
  if (input.fromVersion !== undefined) parseFromVersion(input.fromVersion);
  // Before the vault is read: a plan made from a vault another run is
  // changing would be stale (#253). Then the guard, before any download.
  if (!dryRun) io.takeLock();
  await assertAdoptable(vaultRoot);

  let shard: PreparedShard | undefined;
  try {
    shard = await prepareShard(input.shardRef, {
      command: 'adopt',
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
  const values = buildValuesValidator(shard.schema).parse(given.values) as Record<string, unknown>;
  const answers: ValueAnswers = { values, selections: given.selections };

  // With the values final, before the plan and any diff prompt (#138).
  const externalTools = await checkExternalToolsForRun({ manifest: shard.manifest, values, dryRun: input.dryRun });
  io.phase({ kind: 'planning', shard, answers });
  const plan = await classifyAdoption({
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

  // `--json --dry-run` is the agent's decision step: the per-file plan,
  // before any mode is resolved, since choosing `--mode` is what it informs.
  // Returned even when nothing differs, so a caller always gets one (#139).
  if (input.json && input.dryRun) return { kind: 'plan', plan, mode: mode ?? null };

  const resolutions = plan.differs.length === 0 ? {} : await resolveDiffers(io, shard, answers, plan, mode, yes);
  return execute(input, io, shard, answers, plan, resolutions, externalTools);
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
  const abort = io.newRunAbort();
  const run = runAdopt({
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
    signal: abort.signal,
    onProgress: io.progress,
  });
  io.onRun(abort, run);
  let result;
  try {
    result = await run;
  } catch (err) {
    // runAdopt rolled the vault back before throwing (a dry run wrote nothing).
    if (!input.dryRun && typeof err === 'object' && err !== null) rolledBack.add(err);
    throw err;
  }
  // state.json is on disk: past the point of no return, so a Ctrl+C during
  // the hooks can't walk the adopt back.
  io.onCommitted();

  // Adopt runs the install-side slots: bootstrap, then personalize (skipped
  // under Invariant 2), or a lone legacy post-install. newFiles is the
  // freshly installed shard-only set.
  const hookAbort = new AbortController();
  io.onHookAbort(hookAbort);
  let hooks: HookOutcome[];
  try {
    const hookRun = await runHooks(
      {
        command: 'adopt',
        tempDir: shard.tempDir,
        manifest: shard.manifest,
        schema: shard.schema,
        vaultRoot: input.vaultRoot,
        state: result.state,
        values: answers.values,
        modules: answers.selections,
        newFiles: result.summary.installedFresh,
        removedFiles: [],
        dryRun: input.dryRun,
      },
      { ...io.hooks, signal: hookAbort.signal },
    );
    hooks = hookRun.outcomes;
  } finally {
    io.onHookAbort(null);
  }

  return { kind: 'done', shard, summary: result.summary, hooks, externalTools, durationMs: Date.now() - start };
}
