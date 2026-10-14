/**
 * The update command's run, with no Ink in it (#302). Spec:
 * docs/IMPLEMENTATION.md §4.30 step 6.
 *
 * Reads the install, resolves and fetches the new release, migrates the
 * values, asks for what the new release needs (new required values, new
 * optional modules, removed files the user edited, each conflict), writes
 * the update (`runUpdate`) and runs the shard's hooks. Every question goes
 * through `io.ask`; the Ink machine answers from its prompts, and a
 * headless `--json` run never reaches one (it refuses or stops at the plan).
 *
 * A vault holding several shards (#407) runs that for each shard in turn,
 * the base first, each from its own values, cache and `state.json` entry;
 * the first failure stops the run, the shards before it kept (R3).
 */

import path from 'node:path';
import type {
  ShardManifest,
  ShardSchema,
  ShardState,
  ResolvedShard,
  ModuleSelections,
  ModuleDefinition,
  MigrationChange,
  VaultState,
} from '../../runtime/types.js';
import { ShardMindError } from '../../runtime/types.js';
import { SHARD_SCHEMA_FILE } from '../../runtime/vault-paths.js';
import { SINGLE_SHARD_SCHEMA_VERSION, shardStateOf } from '../../runtime/state-schema.js';
import { resolve as resolveRef } from '../registry.js';
import { primeLatestVersion } from '../update-check.js';
import { parseSchema } from '../schema.js';
import { readVaultState, shardLayout, writeShardEntry, type ShardLayout } from '../state.js';
import { detectDrift, foreignPathsOf, type DriftOptions } from '../drift.js';
import { ownedPaths, ownedConflicts, listOwned } from '../ownership.js';
import { DownloadCancelledError } from '../download.js';
import { applyMigrations } from '../migrator.js';
import { loadValuesYaml } from '../values-io.js';
import { toPosix } from '../fs-utils.js';
import {
  computeSchemaAdditions,
  mergeModuleSelections,
  removedFilesNeedingDecision,
  planUpdate,
  renderNewShard,
  type UpdatePlan,
  type ConflictResolution,
  type NewFilePlan,
} from '../update-planner.js';
import { applyRenames, renamesBetween, type AppliedRenames } from '../rename-migrations.js';
import { runUpdate, type UpdateProgressEvent, type UpdateSummary, type UpdateTarget } from '../update-executor.js';
import { checkExternalToolsForRun } from '../external-tools.js';
import { buildRenderContext } from '../renderer.js';
import { runHooks, type HookOutcome, type HookRunPlan } from '../hook-orchestrator.js';
import { prepareShard } from './prepare-shard.js';
import { validateValues } from './values.js';
import { FlowCancelled } from './cancelled.js';
import { runAndHooks, runHookPhase, type FlowRunIO } from './run.js';

export interface UpdateFlowInput {
  vaultRoot: string;
  /** `update <namespace>/<name>` (#407): that shard only. Every shard when absent. */
  shard?: string;
  yes: boolean;
  dryRun: boolean;
  /** `--json`: with `--dry-run`, the run returns its plan and stops. */
  json: boolean;
  /** `--release <v>`: pin to an exact tag. */
  release: string | undefined;
  /** `--include-prerelease`: widen latest-release resolution to every release. */
  includePrerelease: boolean;
  /** `--adopt-preexisting` (#61): track a kept add-collision as the user's modified copy. */
  adoptPreexisting: boolean;
  /** `--skip-hooks` (#199): run no hook; each declared one is reported skipped. */
  skipHooks: boolean;
  engineVersion: string | undefined;
  /** Aborted when the caller no longer wants the run (a superseded Ink run). */
  stop?: AbortSignal;
}

/** The shard an update runs on (#407): one of the vault's, with its own files. */
export interface ShardTarget {
  /** Its index in `state.json`'s `shards[]`; 0 is the base. */
  index: number;
  state: ShardState;
  /** Its cache folder (merge base) and values file. */
  layout: ShardLayout;
  /** The vault's state as read for this shard: the other shards' files, for ownership and drift. */
  vault: VaultState;
  /** `<namespace>/<name>` on a vault holding several shards, which heads its prompts; undefined on one. */
  label: string | undefined;
}

/** The install, the new release, and the values migrated to it. */
export interface UpdateContext {
  target: ShardTarget;
  state: ShardState;
  oldSchema: ShardSchema;
  resolved: ResolvedShard;
  newManifest: ShardManifest;
  newSchema: ShardSchema;
  newTempDir: string;
  newTarballSha: string;
  cleanup: () => Promise<void>;
  oldValues: Record<string, unknown>;
  migratedValues: Record<string, unknown>;
  migrationApplied: MigrationChange[];
  migrationWarnings: string[];
  newRequiredKeys: string[];
  newOptionalModules: Array<{ id: string; def: ModuleDefinition }>;
}

export type UpdateQuestion =
  | { kind: 'new-values'; ctx: UpdateContext }
  | { kind: 'new-modules'; ctx: UpdateContext; values: Record<string, unknown> }
  | {
      kind: 'removed-files';
      ctx: UpdateContext;
      values: Record<string, unknown>;
      selections: ModuleSelections;
      paths: string[];
      newFilePlan: NewFilePlan;
    }
  | {
      kind: 'conflict';
      ctx: UpdateContext;
      plan: UpdatePlan;
      values: Record<string, unknown>;
      selections: ModuleSelections;
      currentIndex: number;
      /** The conflicts decided so far. */
      resolutions: Record<string, ConflictResolution>;
    };

export type UpdateAnswer<Q extends UpdateQuestion> = Q extends { kind: 'new-values' }
  ? Record<string, unknown>
  : Q extends { kind: 'new-modules' }
    ? Record<string, 'included' | 'excluded'>
    : Q extends { kind: 'removed-files' }
      ? Record<string, 'delete' | 'keep'>
      : ConflictResolution;

export type UpdateFlowPhase = { kind: 'loading'; message: string } | { kind: 'writing' };

export interface UpdateFlowIO extends FlowRunIO {
  ask<Q extends UpdateQuestion>(question: Q): Promise<UpdateAnswer<Q>>;
  phase(phase: UpdateFlowPhase): void;
  progress(event: UpdateProgressEvent): void;
}

/** One shard's update: what a vault with one shard's update returns. */
export type ShardUpdateResult =
  /**
   * `hooks`: the bootstrap a `--skip-hooks` run owes, run (or previewed, or
   * skipped again) by the up-to-date run (#199); usually none.
   */
  | {
      kind: 'up-to-date';
      manifest: ShardManifest;
      state: ShardState;
      hooks: HookOutcome[];
      externalTools: string[];
      durationMs: number;
    }
  | { kind: 'plan'; plan: UpdatePlan }
  | {
      kind: 'done';
      summary: UpdateSummary;
      migrationWarnings: string[];
      hooks: HookOutcome[];
      durationMs: number;
      /** Vault-relative POSIX path of the pre-update snapshot; null in a dry run. */
      backupDir: string | null;
      externalTools: string[];
      /** What was planned and how each conflict was settled: the --json result (#348). */
      plan: UpdatePlan;
      resolutions: Record<string, ConflictResolution>;
    };

/** How one shard of several ended (#407): its result, the error that stopped the run, or not reached. */
export type ShardRun =
  | { shard: string; result: ShardUpdateResult }
  | { shard: string; error: unknown }
  | { shard: string; skipped: 'not-reached' };

/** A vault with one shard: its result. Several: each covered shard's run, in order (#407). */
export type UpdateFlowResult = ShardUpdateResult | { kind: 'shards'; runs: ShardRun[] };


export async function runUpdateFlow(input: UpdateFlowInput, io: UpdateFlowIO): Promise<UpdateFlowResult> {
  const { vaultRoot, dryRun } = input;
  // Before the state is read: a plan made from a state another run is
  // changing would be stale (#253). One lock for every shard.
  if (!dryRun) io.lock();
  io.phase({ kind: 'loading', message: 'Reading install state…' });
  const { vault, indexes } = await readUpdateTargets(vaultRoot, input);
  if (vault.shards.length === 1) return runShardUpdate(input, io, targetOf(vault, 0));

  // R3: in install order, each on its own transaction; the first failure
  // stops the run, the shards before it kept, the ones after not tried.
  const runs: ShardRun[] = [];
  let failed = false;
  for (const index of indexes) {
    const shard = vault.shards[index]!.shard;
    if (failed) {
      runs.push({ shard, skipped: 'not-reached' });
      continue;
    }
    try {
      // The shards before this one wrote state.json: its entry and the
      // other shards' files are read again.
      const current = runs.length === 0 ? vault : ((await readVaultState(vaultRoot)) ?? throwNoInstall());
      runs.push({ shard, result: await runShardUpdate(input, io, targetOf(current, index)) });
    } catch (err) {
      // A cancel ends the whole run, as on one shard; it is no shard's failure.
      if (endsTheRun(err)) throw err;
      runs.push({ shard, error: err });
      failed = true;
    }
  }
  return { kind: 'shards', runs };
}

/** One shard's update: steps 2-9 of §4.30 step 6, with its target's files. */
async function runShardUpdate(input: UpdateFlowInput, io: UpdateFlowIO, target: ShardTarget): Promise<ShardUpdateResult> {
  const { vaultRoot, dryRun } = input;
  const { state, layout } = target;
  const source = sourceOf(state, input.release);

  let cleanup: (() => Promise<void>) | undefined;
  // Waited on before the run returns: a headless run exits right after its
  // document, which would cut the write short.
  let priming: Promise<void> | undefined;
  try {
    const shard = await prepareShard(source, {
      engineVersion: input.engineVersion,
      onLoading: (message) => io.phase({ kind: 'loading', message }),
      onCleanup: (c) => {
        cleanup = c;
        io.onCleanup(c);
      },
      resolve: async (ref) => {
        const resolved = await resolveRefForUpdate(ref, { includePrerelease: input.includePrerelease });
        // The update-check cache stores "latest stable" for the status
        // command: primed only when the run resolved through that policy.
        if (!state.ref && !input.release && !input.includePrerelease) {
          // Each shard keeps its own update-check cache (#406).
          const cacheDir = target.index === 0 ? undefined : layout.cacheDir;
          priming = primeLatestVersion(vaultRoot, state.source, resolved.version, undefined, cacheDir).catch(() => {});
        }
        return resolved;
      },
      parseMessage: 'Parsing new manifest and schema…',
    });

    // A ref install resolved without a ref descriptor would read as
    // `undefined === undefined`, a stale vault taken for up to date.
    if (state.ref && !shard.resolved.ref) {
      throw new ShardMindError(
        `Internal: ref install resolved without a ref descriptor (state.ref='${state.ref}')`,
        'REGISTRY_NETWORK',
        'This is a bug. Please report — the registry should always return ResolvedShard.ref for ref-shaped sources.',
      );
    }
    // An overlay's paths are named after it: a release under another name
    // cannot carry them (#407). The base keeps none under its name.
    const newName = `${shard.manifest.namespace}/${shard.manifest.name}`;
    if (target.index > 0 && newName !== state.shard) {
      throw new ShardMindError(
        `${state.shard}'s release ${shard.manifest.version} is named ${newName}`,
        'UPDATE_SHARD_RENAMED',
        `This vault keeps ${state.shard}'s cache, values and logs under its name. Pin its last release under that name (\`shardmind update ${state.shard} --release <v>\`), or ask its author whether the rename was meant.`,
      );
    }
    // A ref install is up to date at the same commit; a tag install at the
    // same version and tarball (a retagged release runs through the merge).
    const upToDate = state.ref
      ? state.resolvedSha === shard.resolved.ref?.commit
      : shard.manifest.version === state.version && shard.tarballSha256 === state.tarball_sha256;
    if (upToDate) {
      const startedAt = Date.now();
      // Nothing to update, but a bootstrap a --skip-hooks run skipped is
      // owed (#199, ruling (c)): run it on the shard just fetched, after the
      // same checks a run makes before its hooks. A dry run previews it;
      // under --skip-hooks it is reported skipped and stays owed.
      if (state.bootstrap_pending !== true) {
        return { kind: 'up-to-date', manifest: shard.manifest, state, hooks: [], externalTools: [], durationMs: 0 };
      }
      const current = await loadCurrentValues(vaultRoot, layout.valuesFile);
      // Under --skip-hooks no hook runs, so nothing is checked for one.
      let values = current;
      let externalTools: string[] = [];
      if (!input.skipHooks) {
        io.phase({ kind: 'loading', message: 'Checking values and tools for the pending bootstrap…' });
        values = validateValues(shard.schema, current, 'vault');
        externalTools = await checkExternalToolsForRun({ manifest: shard.manifest, values, dryRun });
      }
      const hookPlan: HookRunPlan = {
        command: 'update',
        tempDir: shard.tempDir,
        manifest: shard.manifest,
        schema: shard.schema,
        vaultRoot,
        state,
        values,
        modules: state.modules,
        // No release is applied: there is no version this run updates from.
        previousVersion: undefined,
        newFiles: [],
        removedFiles: [],
        dryRun,
        skipHooks: input.skipHooks,
        upToDate: true,
        ...hookTarget(vaultRoot, target),
      };
      // A dry run writes nothing, so there is no committed run to guard.
      const hooks = dryRun ? (await runHooks(hookPlan, io.hooks)).outcomes : await runHookPhase(io, hookPlan);
      return { kind: 'up-to-date', manifest: shard.manifest, state, hooks, externalTools, durationMs: Date.now() - startedAt };
    }

    io.phase({ kind: 'loading', message: 'Loading current values…' });
    const oldValues = await loadCurrentValues(vaultRoot, layout.valuesFile);
    const oldSchema = await loadCachedSchema(vaultRoot, state, layout.cacheDir);
    io.phase({ kind: 'loading', message: 'Applying migrations…' });
    const migration = applyMigrations(oldValues, state.version, shard.manifest.version, shard.schema.migrations);
    const additions = computeSchemaAdditions(shard.schema, state.modules, migration.values);
    const ctx: UpdateContext = {
      target,
      state,
      oldSchema,
      resolved: shard.resolved,
      newManifest: shard.manifest,
      newSchema: shard.schema,
      newTempDir: shard.tempDir,
      newTarballSha: shard.tarballSha256,
      cleanup: shard.cleanup,
      oldValues,
      migratedValues: migration.values,
      migrationApplied: migration.applied,
      migrationWarnings: migration.warnings,
      newRequiredKeys: additions.newRequiredKeys,
      newOptionalModules: additions.newOptionalModules,
    };
    // A run superseded while it downloaded goes no further.
    if (input.stop?.aborted) throw new FlowCancelled('Superseded by a newer run.');

    const { values, selections, pendingModules } = await valuesAndModules(input, io, ctx);
    return await planAndUpdate(input, io, ctx, values, selections, pendingModules);
  } finally {
    await Promise.allSettled([priming, cleanup?.()]);
  }
}

/** The values and module selections the update installs with. */
async function valuesAndModules(
  input: UpdateFlowInput,
  io: UpdateFlowIO,
  ctx: UpdateContext,
): Promise<{ values: Record<string, unknown>; selections: ModuleSelections; pendingModules: string[] }> {
  if (input.yes) {
    if (ctx.newRequiredKeys.length > 0) {
      throw new ShardMindError(
        `Missing required values for --yes: ${ctx.newRequiredKeys.join(', ')}`,
        'VALUES_MISSING',
        `Drop --yes and answer interactively, or add the missing keys to ${ctx.target.layout.valuesFile} first.`,
      );
    }
    const selections = mergeModuleSelections(
      ctx.state.modules,
      ctx.newSchema,
      Object.fromEntries(ctx.newOptionalModules.map((m) => [m.id, 'included'])),
    );
    return { values: validateValues(ctx.newSchema, ctx.migratedValues, 'vault'), selections, pendingModules: [] };
  }

  let given = ctx.migratedValues;
  if (ctx.newRequiredKeys.length > 0) {
    if (input.json) {
      throw jsonNeedsAnswers(
        `new required values (${ctx.newRequiredKeys.join(', ')})`,
        `Add them to ${ctx.target.layout.valuesFile}; --yes cannot supply new required values either.`,
      );
    }
    given = { ...ctx.migratedValues, ...(await io.ask({ kind: 'new-values', ctx })) };
  }
  const values = validateValues(ctx.newSchema, given, 'vault');

  if (ctx.newOptionalModules.length === 0) {
    return { values, selections: mergeModuleSelections(ctx.state.modules, ctx.newSchema, {}), pendingModules: [] };
  }
  if (input.json) {
    // The modules question cannot be asked: carried as pending with --yes's
    // answer (include them), so the removed-files check runs too and one
    // refusal names every decision (#230).
    const pendingModules = ctx.newOptionalModules.map((m) => m.id);
    const selections = mergeModuleSelections(
      ctx.state.modules,
      ctx.newSchema,
      Object.fromEntries(pendingModules.map((id) => [id, 'included'])),
    );
    return { values, selections, pendingModules };
  }
  const choices = await io.ask({ kind: 'new-modules', ctx, values });
  return { values, selections: mergeModuleSelections(ctx.state.modules, ctx.newSchema, choices), pendingModules: [] };
}

async function planAndUpdate(
  input: UpdateFlowInput,
  io: UpdateFlowIO,
  ctx: UpdateContext,
  values: Record<string, unknown>,
  selections: ModuleSelections,
  pendingModules: string[],
): Promise<ShardUpdateResult> {
  const { vaultRoot } = input;
  // With the values final, before the removed-files question, the render
  // and any conflict question (#138).
  const externalTools = await checkExternalToolsForRun({ manifest: ctx.newManifest, values, dryRun: input.dryRun });
  // The new shard rendered once, threaded through to the planner.
  const renderContext = buildRenderContext(ctx.newManifest, values, selections, undefined, vaultRoot);
  const [drift, newFilePlan] = await Promise.all([
    detectDrift(vaultRoot, ctx.state, driftOptions(ctx.target)),
    renderNewShard(ctx.newSchema, ctx.newTempDir, selections, renderContext),
  ]);
  const newPaths = new Set(newFilePlan.outputs.map((o) => o.outputPath));
  // One owner per file (R2): before any question, dry run included.
  assertNotOwned(ctx.target, [...newPaths]);
  // A renamed file is planned at its new path, so it is not offered as
  // removed (#178).
  let renamed: AppliedRenames | undefined = await resolveRenames(vaultRoot, ctx, drift, newFilePlan);
  const removedModified = removedFilesNeedingDecision(renamed.drift, newPaths);

  if (input.json) {
    // Every decision a --json run cannot ask about, named in one refusal,
    // so following its hint decides nothing unannounced.
    const pending: Array<{ decision: string; answer: string }> = [];
    if (pendingModules.length > 0) {
      pending.push({ decision: `new optional modules (${pendingModules.join(', ')})`, answer: 'include the new modules' });
    }
    if (removedModified.length > 0 && !input.yes) {
      pending.push({ decision: `removed files you edited (${removedModified.join(', ')})`, answer: 'keep the removed files' });
    }
    if (pending.length > 0) {
      throw jsonNeedsAnswers(
        pending.map((p) => p.decision).join(' and '),
        `Add --yes to ${pending.map((p) => p.answer).join(' and ')}, or run without --json to choose.`,
      );
    }
  }
  let removedDecisions: Record<string, 'delete' | 'keep'> = {};
  if (removedModified.length > 0 && !input.yes) {
    removedDecisions = await io.ask({ kind: 'removed-files', ctx, values, selections, paths: removedModified, newFilePlan });
    // The answer took time: drift and renames are read again.
    renamed = undefined;
  }

  io.phase({ kind: 'loading', message: 'Planning update…' });
  const applied =
    renamed ?? (await resolveRenames(vaultRoot, ctx, await detectDrift(vaultRoot, ctx.state, driftOptions(ctx.target)), newFilePlan));
  const plan = await planUpdate({
    vault: {
      root: vaultRoot,
      state: applied.state,
      drift: applied.drift,
      movedFrom: applied.movedFrom,
      cacheDir: ctx.target.layout.cacheDir,
    },
    values: { old: ctx.oldValues, new: values },
    newShard: { schema: ctx.newSchema, selections, tempDir: ctx.newTempDir, renderContext, filePlan: newFilePlan },
    removedFileDecisions: removedDecisions,
  });

  // `--json --dry-run` is the read-only decision step: the per-file plan,
  // before any conflict is asked, since the conflicts are what it reports (#139).
  if (input.json && input.dryRun) return { kind: 'plan', plan };

  const resolutions: Record<string, ConflictResolution> = {};
  for (let currentIndex = 0; currentIndex < plan.pendingConflicts.length; currentIndex++) {
    const pc = plan.pendingConflicts[currentIndex]!;
    // --yes keeps the user's copy of each conflict, and so does a real --json
    // run, which never prompts (#348): keeping loses nothing.
    resolutions[pc.path] = input.yes || input.json
      ? 'keep_mine'
      : await io.ask({ kind: 'conflict', ctx, plan, values, selections, currentIndex, resolutions: { ...resolutions } });
  }

  return execute(input, io, ctx, plan, values, selections, resolutions, externalTools);
}

async function execute(
  input: UpdateFlowInput,
  io: UpdateFlowIO,
  ctx: UpdateContext,
  plan: UpdatePlan,
  values: Record<string, unknown>,
  selections: ModuleSelections,
  resolutions: Record<string, ConflictResolution>,
  externalTools: string[],
): Promise<ShardUpdateResult> {
  const { vaultRoot, dryRun } = input;
  const start = Date.now();
  io.phase({ kind: 'writing' });
  const { result, hooks } = await runAndHooks(
    io,
    (signal) =>
      runUpdate({
        vaultRoot,
        plan,
        conflictResolutions: resolutions,
        currentState: ctx.state,
        newManifest: ctx.newManifest,
        newSchema: ctx.newSchema,
        newValues: values,
        newSelections: selections,
        resolved: ctx.resolved,
        tarballSha256: ctx.newTarballSha,
        newTempDir: ctx.newTempDir,
        dryRun,
        adoptPreexisting: input.adoptPreexisting,
        target: updateTarget(ctx.target),
        signal,
        onProgress: io.progress,
      }),
    // Bootstrap only if its fingerprint changed, then post-update. A dry run
    // reports deferred outcomes without spawning.
    (done) => ({
      command: 'update',
      tempDir: ctx.newTempDir,
      manifest: ctx.newManifest,
      schema: ctx.newSchema,
      vaultRoot,
      state: done.state,
      values,
      modules: selections,
      previousVersion: ctx.state.version,
      newFiles: done.summary.addedFiles,
      removedFiles: done.summary.deletedFiles,
      dryRun,
      skipHooks: input.skipHooks,
      ...hookTarget(vaultRoot, ctx.target),
    }),
  );

  return {
    kind: 'done',
    summary: result.summary,
    migrationWarnings: ctx.migrationWarnings,
    hooks,
    durationMs: Date.now() - start,
    backupDir: result.backupDir ? toPosix(vaultRoot, result.backupDir) : null,
    externalTools,
    plan,
    resolutions,
  };
}

/** The rename migrations between the installed and the new version, applied to state and drift (#178). */
function resolveRenames(vaultRoot: string, ctx: UpdateContext, drift: Awaited<ReturnType<typeof detectDrift>>, newFilePlan: NewFilePlan) {
  return applyRenames({
    vaultRoot,
    state: ctx.state,
    drift,
    renames: renamesBetween(ctx.newManifest.migrations, ctx.state.version, ctx.newManifest.version),
    newPaths: new Set(newFilePlan.outputs.map((o) => o.outputPath)),
  });
}

/**
 * The vault and the shards the run covers, in order (#407): every shard,
 * or the one named (`UPDATE_SHARD_UNKNOWN`, matched exactly). Refused
 * before any network call: no install (`UPDATE_NO_INSTALL`), an overlay
 * name with no layout (`STATE_CORRUPT`), `--release` on a bare run of
 * several shards, and flags that cannot combine for any covered shard
 * (`UPDATE_FLAG_CONFLICT`).
 */
export async function readUpdateTargets(
  vaultRoot: string,
  opts: { shard?: string; release?: string; includePrerelease?: boolean } = {},
): Promise<{ vault: VaultState; indexes: number[] }> {
  const vault = await readVaultState(vaultRoot);
  if (!vault) throwNoInstall();
  const names = vault.shards.map((s) => s.shard);
  let indexes = names.map((_, i) => i);
  if (opts.shard !== undefined) {
    const at = names.indexOf(opts.shard);
    if (at === -1) {
      throw new ShardMindError(
        `This vault holds no shard named ${opts.shard}`,
        'UPDATE_SHARD_UNKNOWN',
        `It holds ${names.join(', ')}. Name one of them, or run \`shardmind update\` to update every shard.`,
      );
    }
    indexes = [at];
  } else if (names.length > 1 && opts.release) {
    throw new ShardMindError(
      '--release cannot pin every shard of a vault holding several',
      'UPDATE_FLAG_CONFLICT',
      `A tag belongs to one shard's releases. Name the shard: \`shardmind update <namespace>/<name> --release ${opts.release}\` (this vault holds ${names.join(', ')}).`,
    );
  }
  for (const i of indexes) {
    layoutOf(vault, i);
    assertFlagsCompatible({
      stateRef: vault.shards[i]!.ref ?? null,
      release: opts.release,
      includePrerelease: opts.includePrerelease ?? false,
    });
  }
  return { vault, indexes };
}

/**
 * The first shard the run covers and the source to resolve it from (the
 * base on a bare run). `state.ref` re-resolves the tracked ref; `--release`
 * pins a tag; otherwise the recorded source's latest stable release.
 */
export async function readUpdateTarget(
  vaultRoot: string,
  opts: { shard?: string; release?: string; includePrerelease?: boolean } = {},
): Promise<{ state: ShardState; source: string }> {
  const { vault, indexes } = await readUpdateTargets(vaultRoot, opts);
  const { state } = targetOf(vault, indexes[0]!);
  return { state, source: sourceOf(state, opts.release) };
}

function sourceOf(state: ShardState, release: string | undefined): string {
  return state.ref ? `${state.source}#${state.ref}` : release ? `${state.source}@${release}` : state.source;
}

/** Shard `index` of `vault` as an update target. */
function targetOf(vault: VaultState, index: number): ShardTarget {
  const entry = vault.shards[index]!;
  return {
    index,
    state: shardStateOf(entry, SINGLE_SHARD_SCHEMA_VERSION),
    layout: layoutOf(vault, index),
    vault,
    label: vault.shards.length > 1 ? entry.shard : undefined,
  };
}

/** The shard's layout; an overlay name a hand edit broke has none (`STATE_CORRUPT`). */
function layoutOf(vault: VaultState, index: number): ShardLayout {
  const name = vault.shards[index]!.shard;
  const layout = shardLayout(name, index);
  if (layout === null) {
    throw new ShardMindError(
      `state.json names an overlay '${name}', which is not <namespace>/<name>`,
      'STATE_CORRUPT',
      'Its cache and values files are named after it, so it cannot be updated. Fix the name in .shardmind/state.json, or remove that entry.',
    );
  }
  return layout;
}

/** Drift for the target: its own cache, and the other shards' files never its orphans (#406). */
function driftOptions(target: ShardTarget): DriftOptions {
  if (target.label === undefined) return {};
  const states = target.vault.shards.map((entry) => shardStateOf(entry, SINGLE_SHARD_SCHEMA_VERSION));
  return { cacheDir: target.layout.cacheDir, foreign: foreignPathsOf(states, target.index) };
}

/** The executor's target: where this shard's engine files go. */
function updateTarget(target: ShardTarget): UpdateTarget {
  return { index: target.index, layout: target.layout, composed: target.label !== undefined };
}

/** The hooks' part on a vault with several shards: its entry written back, an overlay's logs in its folder. */
function hookTarget(vaultRoot: string, target: ShardTarget): Pick<HookRunPlan, 'persist' | 'logShard'> {
  if (target.label === undefined) return {};
  return {
    persist: (state) => writeShardEntry(vaultRoot, state, { at: target.index }),
    logShard: target.index > 0 ? target.state.shard : undefined,
  };
}

/**
 * `UPDATE_PATH_OWNED` when the target's new release would write a path
 * another shard of the vault owns (R2, #407), naming each with its owner.
 */
function assertNotOwned(target: ShardTarget, paths: readonly string[]): void {
  if (target.label === undefined) return;
  const taken = ownedConflicts(ownedPaths(target.vault, { except: target.index }), paths);
  if (taken.length === 0) return;
  throw new ShardMindError(
    `${target.label}'s new release would write ${taken.length === 1 ? 'a path' : `${taken.length} paths`} another shard or ShardMind owns: ${listOwned(taken)}`,
    'UPDATE_PATH_OWNED',
    `Each file has one owner. Update the other shards alone (\`shardmind update <namespace>/<name>\`), and report the clash to ${target.label}'s author, who can move the file or exclude it in its .shardmindignore.`,
  );
}

/** A cancel or a superseded run: the whole run ends, as on a vault with one shard. */
function endsTheRun(err: unknown): boolean {
  if (err instanceof FlowCancelled || err instanceof DownloadCancelledError) return true;
  const code = (e: unknown) => (typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined);
  return code(err) === 'CANCELLED' || code((err as { cause?: unknown } | null)?.cause) === 'CANCELLED';
}

function throwNoInstall(): never {
  throw new ShardMindError(
    'No shard installed in this directory.',
    'UPDATE_NO_INSTALL',
    'Run `shardmind install <shard>` first, then come back to update.',
  );
}

/**
 * The error for a --json run that reached decisions it would prompt for
 * (#230): its one JSON failure document instead. A JSON document is never
 * capped, so every path is named.
 */
function jsonNeedsAnswers(decision: string, hint: string): ShardMindError {
  return new ShardMindError(`--json cannot answer the update's question about ${decision}`, 'UPDATE_JSON_NEEDS_ANSWERS', hint);
}

/**
 * `resolveRef` with its CLI-input hints rewritten for a ref read from
 * `state.json`:
 * - `REGISTRY_INVALID_REF` → `UPDATE_SOURCE_MISMATCH`: a broken ref shape
 *   during update means `state.json` was hand-edited or corrupted.
 * - `SHARD_NOT_FOUND` / `VERSION_NOT_FOUND` / `REF_NOT_FOUND` /
 *   `NO_RELEASES_PUBLISHED`: same code, a hint for the updater.
 * - `REGISTRY_NETWORK` / `REGISTRY_RATE_LIMITED`: unchanged.
 */
export async function resolveRefForUpdate(source: string, opts: { includePrerelease?: boolean } = {}): Promise<ResolvedShard> {
  try {
    return await resolveRef(source, opts);
  } catch (err) {
    if (err instanceof ShardMindError) {
      if (err.code === 'REGISTRY_INVALID_REF') {
        throw new ShardMindError(
          `state.source in .shardmind/state.json is not a valid shard reference: '${source}'`,
          'UPDATE_SOURCE_MISMATCH',
          `The value '${source}' in .shardmind/state.json doesn't match the expected "namespace/name" or "github:namespace/name" shape. Likely hand-edited or partially corrupted — reinstall the shard to repair.`,
        );
      }
      if (err.code === 'SHARD_NOT_FOUND') {
        // Registry mode: the index no longer lists it. Direct mode: the
        // repo's `/releases` answered 404 (missing, or private).
        const isDirect = source.startsWith('github:');
        const hint = isDirect
          ? `github.com/${source.slice('github:'.length)} returned 404. The repo may have been renamed, deleted, or made private. Check the URL, or set GITHUB_TOKEN if it's now a private repo you have access to.`
          : `The shard recorded in .shardmind/state.json ('${source}') is no longer listed in the registry. It may have been renamed, moved, or deprecated — check the shard's homepage, or reinstall from a github:owner/repo source.`;
        throw new ShardMindError(err.message, 'SHARD_NOT_FOUND', hint);
      }
      if (err.code === 'NO_RELEASES_PUBLISHED') {
        // Two cases: no releases at all (the install-side hint, "publish a
        // release", is not the updater's to act on), or only prereleases
        // (its hint, --include-prerelease, fits an updater too).
        const inheritedHint = err.hint ?? '';
        if (inheritedHint.includes('--include-prerelease')) {
          throw new ShardMindError(
            err.message,
            'NO_RELEASES_PUBLISHED',
            `${inheritedHint} Or reinstall via \`shardmind install ${source}@<version>\` to switch this vault to a tag pin.`,
          );
        }
        throw new ShardMindError(
          err.message,
          'NO_RELEASES_PUBLISHED',
          `'${source}' currently has no published releases. Check the repository's releases page — someone may need to publish a release, or you may need to reinstall from a different source.`,
        );
      }
      if (err.code === 'VERSION_NOT_FOUND') {
        // A listed tag whose tarball is missing: usually transient, or a deleted tag.
        throw new ShardMindError(
          err.message,
          'VERSION_NOT_FOUND',
          `The latest version of '${source}' reports a tag whose tarball is missing upstream — usually a transient GitHub state or a deleted tag. Retry in a minute, or reinstall if the issue persists.`,
        );
      }
      if (err.code === 'REF_NOT_FOUND') {
        // The ref recorded in state.ref no longer resolves: reinstalling
        // needs a new ref, not a retry.
        throw new ShardMindError(
          err.message,
          'REF_NOT_FOUND',
          `The ref recorded in .shardmind/state.json no longer exists upstream. Re-run \`shardmind install ${source}\` with a different ref to repoint this vault, or reinstall from a tagged release.`,
        );
      }
    }
    throw err;
  }
}

/**
 * Flags that cannot combine, refused before any network call:
 * `--release` with `--include-prerelease` (a pin needs no widening), and
 * either on a ref install (it tracks a moving ref, resolved by commit).
 */
function assertFlagsCompatible(opts: { stateRef: string | null; release: string | undefined; includePrerelease: boolean }): void {
  const { stateRef, release, includePrerelease } = opts;
  if (release && includePrerelease) {
    throw new ShardMindError(
      '--release and --include-prerelease cannot be combined',
      'UPDATE_FLAG_CONFLICT',
      '--release already pins a specific tag (stable or prerelease). Drop one of the flags.',
    );
  }
  if (stateRef && release) {
    throw new ShardMindError(
      `Cannot use --release on a ref-installed vault (state.ref='${stateRef}')`,
      'UPDATE_FLAG_CONFLICT',
      `This vault tracks ref '${stateRef}'. Drop --release to re-resolve the ref, or reinstall via \`shardmind install <source>@<version>\` to switch to a tag pin.`,
    );
  }
  if (stateRef && includePrerelease) {
    throw new ShardMindError(
      `Cannot use --include-prerelease on a ref-installed vault (state.ref='${stateRef}')`,
      'UPDATE_FLAG_CONFLICT',
      `This vault tracks ref '${stateRef}'. The prerelease widen flag only affects /releases-based resolution; ref installs use /commits/<ref> regardless. Drop --include-prerelease.`,
    );
  }
}

function loadCurrentValues(vaultRoot: string, valuesFile: string): Promise<Record<string, unknown>> {
  return loadValuesYaml(path.join(vaultRoot, valuesFile), {
    label: valuesFile,
    errors: { readFailed: 'VALUES_READ_FAILED', invalid: 'VALUES_INVALID' },
  });
}

async function loadCachedSchema(vaultRoot: string, state: ShardState, cacheDir: string): Promise<ShardSchema> {
  try {
    return await parseSchema(path.join(vaultRoot, cacheDir, SHARD_SCHEMA_FILE));
  } catch (err) {
    throw new ShardMindError(
      'Cached schema missing or corrupt',
      'UPDATE_CACHE_MISSING',
      `Re-run \`shardmind install ${state.source}\` to regenerate .shardmind/. ` +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

