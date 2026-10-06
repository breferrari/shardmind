/**
 * `shardmind install <shard> [folder]` as a UI-free flow (#302). Spec:
 * docs/IMPLEMENTATION.md §4.30 step 9.
 *
 * The whole run, from the flags to the summary, as a function of its input
 * and an `io`: the Ink machine (`use-install-machine.ts`) answers the gate,
 * the wizard and the collision review through `io.ask`, and renders each
 * phase it is told of. The destination was decided before the run
 * (`install-destination.ts`, §4.31).
 */

import type { ShardState } from '../../runtime/types.js';
import { ShardMindError } from '../../runtime/types.js';
import { SHARDMIND_DIR, VALUES_FILE } from '../../runtime/vault-paths.js';
import { resolve as resolveRef } from '../registry.js';
import { readState } from '../state.js';
import { assertShardInstallable } from '../lint-shard.js';
import { checkExternalToolsForRun } from '../external-tools.js';
import { assertSafeVaultPaths } from '../vault-path-guard.js';
import { toPosix } from '../fs-utils.js';
import {
  planOutputs,
  detectCollisions,
  defaultModuleSelections,
  splitByOwnContent,
  staleOutputs,
  detectStale,
  stillFiles,
  type Collision,
} from '../install-planner.js';
import { runInstallTransaction, type BackupRecord, type ProgressEvent } from '../install-executor.js';
import type { InstallDestination } from '../install-destination.js';
import type { HookOutcome } from '../hook-orchestrator.js';
import { prepareShard, type PreparedShard } from './prepare-shard.js';
import { answersWithoutPrompting, loadValuesFile, validateValues, type ValueAnswers } from './values.js';
import { FlowCancelled } from './cancelled.js';
import { runAndHooks, type FlowRunIO } from './run.js';

export interface InstallFlowInput {
  shardRef: string;
  valuesFile: string | undefined;
  yes: boolean;
  /** Invariant 1 mode: schema defaults, no wizard; refuses an existing install without `--force`. */
  defaults: boolean;
  /** Reinstall over an existing install with no gate, and overwrite the user's collisions with no backup (#55). */
  force: boolean;
  dryRun: boolean;
  /** A terminal to prompt on: without one, the flow never asks (#139). */
  interactive: boolean;
  destination: InstallDestination;
  engineVersion: string | undefined;
  /** Aborted when an Ink run is superseded by a newer one. */
  stop?: AbortSignal;
}

/** The shard as the install's questions show it. */
export interface InstallShard extends PreparedShard {
  /** The raw `--values` input (or {}): the wizard tells the user's answers from the defaults. */
  prefillValues: Record<string, unknown>;
  moduleFileCounts: Record<string, number>;
  alwaysIncludedFileCount: number;
  /** The install a reinstall replaces (the gate's Reinstall, or `--force`, #55). */
  previous?: ShardState;
}

export type InstallQuestion =
  | { kind: 'gate'; state: ShardState; shard: InstallShard }
  | { kind: 'values'; shard: InstallShard }
  | { kind: 'collision'; collisions: Collision[]; shard: InstallShard; answers: ValueAnswers };

export type InstallAnswer<Q extends InstallQuestion> = Q extends { kind: 'gate' }
  ? 'reinstall' | 'update' | 'cancel'
  : Q extends { kind: 'values' }
    ? ValueAnswers
    : 'backup' | 'overwrite' | 'cancel';

export type InstallFlowPhase = { kind: 'loading'; message: string } | { kind: 'installing'; shard: InstallShard; answers: ValueAnswers };

export interface InstallFlowIO extends FlowRunIO {
  ask<Q extends InstallQuestion>(question: Q): Promise<InstallAnswer<Q>>;
  phase(phase: InstallFlowPhase): void;
  progress(event: ProgressEvent): void;
}

export interface InstallFlowResult {
  kind: 'done';
  manifest: PreparedShard['manifest'];
  vaultRoot: string;
  /** As the user wrote it, or the default name; null in place. */
  folder: string | null;
  fileCount: number;
  durationMs: number;
  backups: BackupRecord[];
  replaced: string[];
  removed: string[];
  keptStale: string[];
  hooks: HookOutcome[];
  dryRun: boolean;
  externalTools: string[];
}

/** What the install moves out of the way, as planned once the answers are in. */
interface InstallPlan {
  /** The user's own content in the way, and a reinstall's untouched files. */
  own: Collision[];
  untouched: Collision[];
  policy: 'backup' | 'overwrite';
  /** The previous install's files this one no longer plans, split by whether the user edited them (#228). */
  stale: Awaited<ReturnType<typeof splitByOwnContent>>;
  /** The collision review stayed open since they were classified (the gate and wizard come before): files may have been edited meanwhile. */
  prompted: boolean;
  externalTools: string[];
}

export async function runInstallFlow(input: InstallFlowInput, io: InstallFlowIO): Promise<InstallFlowResult> {
  const { destination, defaults, force } = input;
  const vaultRoot = destination.root;
  // A folder this run makes is locked by its transaction from the moment it
  // exists, and holds no state (§4.31 step 4).
  const creating = destination.create.length > 0;
  // Before any network call, so a misconfigured invocation fails at once.
  if (defaults && input.valuesFile !== undefined) {
    throw new ShardMindError(
      '--defaults and --values cannot be combined',
      'INSTALL_FLAG_CONFLICT',
      '--defaults uses schema defaults for every value; --values would override them. Drop one of the two flags.',
    );
  }
  // Before state is read: a plan made from a state another run is changing
  // would be stale (#253). --dry-run writes nothing and takes no lock.
  if (!creating && !input.dryRun) io.lock();
  const existing = creating ? null : await readState(vaultRoot);
  if (defaults && existing && !force) {
    throw new ShardMindError(
      `Vault already shardmind-managed (${existing.shard}@${existing.version}); --defaults refuses to overwrite`,
      'INSTALL_DEFAULTS_OVER_EXISTING',
      'Run `shardmind update` to upgrade the existing install in place, or add --force to reinstall from scratch.',
    );
  }

  let prepared: PreparedShard | undefined;
  try {
    prepared = await prepareShard(input.shardRef, {
      resolve: (ref) => resolveRef(ref, { command: 'install' }),
      engineVersion: input.engineVersion,
      onLoading: (message) => io.phase({ kind: 'loading', message }),
      onCleanup: io.onCleanup,
    });
    // A run superseded while it downloaded goes no further.
    if (input.stop?.aborted) throw new FlowCancelled('Superseded by a newer run.');
    const prefill = input.valuesFile ? await loadValuesFile(input.valuesFile, prepared.schema) : {};
    // A template that cannot render fails here, every one listed, before
    // the user answers anything (#35).
    io.phase({ kind: 'loading', message: 'Checking the shard…' });
    await assertShardInstallable(prepared.tempDir, prefill, vaultRoot);
    const { moduleFileCounts, alwaysIncludedFileCount } = await planOutputs(
      prepared.schema,
      prepared.tempDir,
      defaultModuleSelections(prepared.schema),
    );
    let shard: InstallShard = { ...prepared, prefillValues: prefill, moduleFileCounts, alwaysIncludedFileCount };

    if (existing) shard = { ...shard, previous: await reinstallOver(input, io, existing, shard) };
    const answers = await valueAnswers(input, io, shard);
    return await planAndInstall(input, io, shard, answers);
  } finally {
    await prepared?.cleanup().catch(() => {});
  }
}

/**
 * The existing install: `--force` reinstalls over it with no question; the
 * gate is a prompt `--yes` does not answer (overwriting a managed vault is
 * no default to inherit), so without a terminal it refuses.
 */
async function reinstallOver(input: InstallFlowInput, io: InstallFlowIO, existing: ShardState, shard: InstallShard): Promise<ShardState> {
  if (input.force) return existing;
  if (!input.interactive) {
    throw new ShardMindError(
      `Vault already shardmind-managed (${existing.shard}@${existing.version}); cannot prompt for a choice without an interactive terminal`,
      'INSTALL_GATE_NON_INTERACTIVE',
      'Run `shardmind update` to upgrade in place, or add --force to reinstall from scratch.',
    );
  }
  const choice = await io.ask({ kind: 'gate', state: existing, shard });
  if (choice === 'cancel') throw new FlowCancelled('User cancelled at existing-install gate.');
  if (choice === 'update') {
    throw new FlowCancelled(
      'Existing install preserved. Run `shardmind update` to pick up a newer version, or re-run `install` and pick Reinstall for a fresh start.',
    );
  }
  return existing;
}

/**
 * The answers: without the wizard under `--yes` / `--defaults`, or from a
 * `--values` file when there is no terminal to show the wizard on. A
 * reinstall removes nothing here: its old install is set aside only once
 * the answers are in, so a cancelled wizard leaves it as it was.
 */
async function valueAnswers(input: InstallFlowInput, io: InstallFlowIO, shard: InstallShard): Promise<ValueAnswers> {
  if (input.yes || input.defaults) return answersWithoutPrompting(shard.schema, shard.prefillValues, input.yes);
  if (!input.interactive) {
    // `--values` is a prefill for the wizard; with every answer on disk and
    // no terminal, there is nothing left to prompt for.
    if (input.valuesFile !== undefined) return answersWithoutPrompting(shard.schema, shard.prefillValues, input.yes);
    // Refusing beats installing schema defaults nobody chose (#139).
    throw new ShardMindError(
      'No interactive terminal, and no values were supplied',
      'INSTALL_NON_INTERACTIVE_WITHOUT_VALUES',
      'Pass --values <file> to supply answers, or --yes / --defaults to accept schema defaults deliberately.',
    );
  }
  const given = await io.ask({ kind: 'values', shard });
  return { values: validateValues(shard.schema, given.values), selections: given.selections };
}

async function planAndInstall(input: InstallFlowInput, io: InstallFlowIO, shard: InstallShard, answers: ValueAnswers): Promise<InstallFlowResult> {
  const vaultRoot = input.destination.root;
  const previous = shard.previous ?? null;
  // With the values final, before any prompt or move (#138).
  const externalTools = await checkExternalToolsForRun({ manifest: shard.manifest, values: answers.values, dryRun: input.dryRun });
  // With the values, an `_each` template is planned under the paths it
  // expands to, so a user file at one is a collision like any other (#214).
  const { outputs } = await planOutputs(shard.schema, shard.tempDir, answers.selections, answers.values);
  const plannedPaths = outputs.map((o) => o.outputPath);
  // A reinstall also removes the files the shard no longer has (#228): they
  // go through the guard as deletes. Refused before any prompt or move, so a
  // dry run and the run agree (#163).
  const stalePaths = staleOutputs(previous, plannedPaths);
  await assertSafeVaultPaths(vaultRoot, plannedPaths, stalePaths);
  const [collisions, staleFound] = await Promise.all([detectCollisions(vaultRoot, plannedPaths), detectStale(vaultRoot, stalePaths)]);
  // Only the user's own content is prompted for, backed up or reported; a
  // reinstall's untouched files are simply replaced.
  const { own, untouched } = await splitByOwnContent(collisions, previous);
  const stale = await splitByOwnContent(staleFound, previous);

  const plan: InstallPlan = { own, untouched, policy: 'backup', stale, prompted: false, externalTools };
  if (own.length > 0 && input.force) plan.policy = 'overwrite';
  else if (own.length > 0 && input.interactive && !input.yes && !input.defaults) {
    const action = await io.ask({ kind: 'collision', collisions: own, shard, answers });
    if (action === 'cancel') throw new FlowCancelled('User cancelled at collision review.');
    plan.policy = action;
    plan.prompted = true;
  }
  // Otherwise the user's files are backed up: `--yes`, `--defaults`, or a
  // `--values` run with no terminal to show the review on.
  return execute(input, io, shard, answers, plan);
}

/**
 * What moves out of the way, then the install (#55, #300). `own` holds the
 * user's content: `backup` keeps it as `<path>.shardmind-backup-<stamp>`;
 * `overwrite` sets it aside, restores it if the install fails, and deletes
 * it once the new state is written. A reinstall's old `.shardmind/`,
 * `shard-values.yaml` and untouched files are always set aside that way.
 */
async function execute(
  input: InstallFlowInput,
  io: InstallFlowIO,
  shard: InstallShard,
  answers: ValueAnswers,
  plan: InstallPlan,
): Promise<InstallFlowResult> {
  const { destination, dryRun } = input;
  const vaultRoot = destination.root;
  const previous = shard.previous ?? null;
  const { own, policy, stale } = plan;
  // Classified before a prompt that may have stayed open: a file edited
  // since is the user's now, so check the untouched ones again. With no
  // prompt, nothing changed since.
  const recheck = plan.prompted ? await splitByOwnContent(plan.untouched, previous) : { own: [], untouched: plan.untouched };
  const ownNow = [...own, ...recheck.own];
  const replaced = policy === 'overwrite' ? ownNow.map((c) => c.outputPath) : [];
  // A stale file edited during the prompts is the user's now: kept (#228).
  const staleNow = plan.prompted ? await splitByOwnContent(stale.untouched, previous) : { own: [], untouched: stale.untouched };
  const removed = staleNow.untouched.map((c) => c.outputPath);
  // Only files still there are reported as kept: a folder at the path, or a
  // file deleted meanwhile, is not one the user edited.
  const [keptStale, oldInstall] = await Promise.all([
    stillFiles(vaultRoot, [...stale.own, ...staleNow.own]),
    previous ? detectCollisions(vaultRoot, [SHARDMIND_DIR, VALUES_FILE]) : Promise.resolve([]),
  ]);
  const oldStatePath = oldInstall.find((c) => c.outputPath === SHARDMIND_DIR)?.absolutePath;
  // A stale file whose set-aside copy could not be deleted is still in the
  // vault under its backup name: listed as such, never as removed.
  const removedNow = (left: BackupRecord[]): string[] => {
    const leftPaths = new Set(left.map((r) => toPosix(vaultRoot, r.originalPath)));
    return removed.filter((rel) => !leftPaths.has(rel));
  };

  const start = Date.now();
  io.phase({ kind: 'installing', shard, answers });
  const { result, hooks } = await runAndHooks(
    io,
    (signal) =>
      runInstallTransaction({
        vaultRoot,
        manifest: shard.manifest,
        schema: shard.schema,
        tempDir: shard.tempDir,
        resolved: shard.resolved,
        tarballSha256: shard.tarballSha256,
        values: answers.values,
        selections: answers.selections,
        dryRun,
        signal,
        moveAside: [...oldInstall, ...recheck.untouched, ...staleNow.untouched, ...ownNow],
        keep: new Set(policy === 'backup' ? ownNow.map((c) => c.absolutePath) : []),
        oldStatePath,
        createRoot: destination.create.length > 0 ? { folders: destination.create, lock: io.lock } : undefined,
        onProgress: io.progress,
      }),
    (done) => ({
      command: 'install',
      tempDir: shard.tempDir,
      manifest: shard.manifest,
      schema: shard.schema,
      vaultRoot,
      state: done.state,
      values: answers.values,
      modules: answers.selections,
      newFiles: [],
      // A reinstall removes the files the shard no longer has (#228).
      removedFiles: dryRun ? [] : removedNow(done.left),
      dryRun,
    }),
  );

  const leftBackups = result.left.filter((r) => r.originalPath !== oldStatePath);
  return {
    kind: 'done',
    manifest: shard.manifest,
    vaultRoot,
    folder: destination.folder,
    fileCount: result.fileCount,
    durationMs: Date.now() - start,
    backups: [...result.backups, ...leftBackups],
    replaced,
    removed: dryRun ? removed : removedNow(result.left),
    keptStale,
    hooks,
    dryRun,
    externalTools: plan.externalTools,
  };
}
