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
} from '../../runtime/types.js';
import { ShardMindError } from '../../runtime/types.js';
import { VALUES_FILE } from '../../runtime/vault-paths.js';
import { resolve as resolveRef } from '../registry.js';
import { primeLatestVersion } from '../update-check.js';
import { parseSchema } from '../schema.js';
import { readState } from '../state.js';
import { detectDrift } from '../drift.js';
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
import { runUpdate, type UpdateProgressEvent, type UpdateSummary } from '../update-executor.js';
import { checkExternalToolsForRun } from '../external-tools.js';
import { buildRenderContext } from '../renderer.js';
import { runHooks, type HookOutcome, type HookRunUi } from '../hook-orchestrator.js';
import { prepareShard } from './prepare-shard.js';
import { validateValues } from './values.js';
import { FlowCancelled } from './cancelled.js';

export interface UpdateFlowInput {
  vaultRoot: string;
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
  engineVersion: string | undefined;
  /** Aborted when the caller no longer wants the run (a superseded Ink run). */
  stop?: AbortSignal;
}

/** The install, the new release, and the values migrated to it. */
export interface UpdateContext {
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

export interface UpdateFlowIO {
  ask<Q extends UpdateQuestion>(question: Q): Promise<UpdateAnswer<Q>>;
  phase(phase: UpdateFlowPhase): void;
  progress(event: UpdateProgressEvent): void;
  /** The hooks' phase and output; the flow supplies the signal. */
  hooks: Omit<HookRunUi, 'signal'>;
  /** The vault lock, taken before the state is read (#253); not under --dry-run. */
  takeLock(): void;
  onCleanup(cleanup: () => Promise<void>): void;
  /** The abort for the run; aborted already if a Ctrl+C came first (#249). */
  newRunAbort(): AbortController;
  onRun(abort: AbortController, run: Promise<unknown>): void;
  onCommitted(): void;
  onHookAbort(abort: AbortController | null): void;
}

export type UpdateFlowResult =
  | { kind: 'up-to-date'; manifest: ShardManifest; state: ShardState }
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
    };

/** The errors the executor threw after rolling the vault back. */
const rolledBack = new WeakSet<object>();

/** Whether the run that threw `err` rolled the vault back, for the error view's line. */
export function updateRolledBack(err: unknown): boolean {
  return typeof err === 'object' && err !== null && rolledBack.has(err);
}

export async function runUpdateFlow(input: UpdateFlowInput, io: UpdateFlowIO): Promise<UpdateFlowResult> {
  const { vaultRoot, dryRun, json } = input;
  // `--json` is the plan surface only: executing under it would render
  // nothing and wait at a prompt nobody sees.
  if (json && !dryRun) {
    throw new ShardMindError(
      '--json is only supported together with --dry-run',
      'JSON_REQUIRES_DRY_RUN',
      'Add --dry-run to get the machine-readable plan. Executing with --json is not supported yet — run without --json to execute.',
    );
  }
  // Before the state is read: a plan made from a state another run is
  // changing would be stale (#253).
  if (!dryRun) io.takeLock();
  io.phase({ kind: 'loading', message: 'Reading install state…' });
  const { state, source } = await readUpdateTarget(vaultRoot, input);

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
      resolve: async () => {
        const resolved = await resolveRefForUpdate(source, { includePrerelease: input.includePrerelease });
        // The update-check cache stores "latest stable" for the status
        // command: primed only when the run resolved through that policy.
        if (!state.ref && !input.release && !input.includePrerelease) {
          priming = primeLatestVersion(vaultRoot, state.source, resolved.version).catch(() => {});
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
    // A ref install is up to date at the same commit; a tag install at the
    // same version and tarball (a retagged release runs through the merge).
    const upToDate = state.ref
      ? state.resolvedSha === shard.resolved.ref?.commit
      : shard.manifest.version === state.version && shard.tarballSha256 === state.tarball_sha256;
    if (upToDate) return { kind: 'up-to-date', manifest: shard.manifest, state };

    io.phase({ kind: 'loading', message: 'Loading current values…' });
    const oldValues = await loadCurrentValues(vaultRoot);
    const oldSchema = await loadCachedSchema(vaultRoot, state);
    io.phase({ kind: 'loading', message: 'Applying migrations…' });
    const migration = applyMigrations(oldValues, state.version, shard.manifest.version, shard.schema.migrations);
    const additions = computeSchemaAdditions(shard.schema, state.modules, migration.values);
    const ctx: UpdateContext = {
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
    await priming;
    await cleanup?.().catch(() => {});
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
        'Drop --yes and answer interactively, or add the missing keys to shard-values.yaml first.',
      );
    }
    const selections = mergeModuleSelections(
      ctx.state.modules,
      ctx.newSchema,
      Object.fromEntries(ctx.newOptionalModules.map((m) => [m.id, 'included'])),
    );
    return { values: validateValues(ctx.newSchema, ctx.migratedValues), selections, pendingModules: [] };
  }

  let given = ctx.migratedValues;
  if (ctx.newRequiredKeys.length > 0) {
    if (input.json) {
      throw jsonNeedsAnswers(
        `new required values (${ctx.newRequiredKeys.join(', ')})`,
        'Add them to shard-values.yaml; --yes cannot supply new required values either.',
      );
    }
    given = { ...ctx.migratedValues, ...(await io.ask({ kind: 'new-values', ctx })) };
  }
  const values = validateValues(ctx.newSchema, given);

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
): Promise<UpdateFlowResult> {
  const { vaultRoot } = input;
  // With the values final, before the removed-files question, the render
  // and any conflict question (#138).
  const externalTools = await checkExternalToolsForRun({ manifest: ctx.newManifest, values, dryRun: input.dryRun });
  // The new shard rendered once, threaded through to the planner.
  const renderContext = buildRenderContext(ctx.newManifest, values, selections, undefined, vaultRoot);
  const [drift, newFilePlan] = await Promise.all([
    detectDrift(vaultRoot, ctx.state),
    renderNewShard(ctx.newSchema, ctx.newTempDir, selections, renderContext),
  ]);
  const newPaths = new Set(newFilePlan.outputs.map((o) => o.outputPath));
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
  const applied = renamed ?? (await resolveRenames(vaultRoot, ctx, await detectDrift(vaultRoot, ctx.state), newFilePlan));
  const plan = await planUpdate({
    vault: { root: vaultRoot, state: applied.state, drift: applied.drift, movedFrom: applied.movedFrom },
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
    // --yes keeps the user's copy of each conflict.
    resolutions[pc.path] = input.yes
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
): Promise<UpdateFlowResult> {
  const { vaultRoot, dryRun } = input;
  const start = Date.now();
  io.phase({ kind: 'writing' });
  const abort = io.newRunAbort();
  const run = runUpdate({
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
    signal: abort.signal,
    onProgress: io.progress,
  });
  io.onRun(abort, run);
  let result;
  try {
    result = await run;
  } catch (err) {
    // runUpdate rolled the vault back before throwing (a dry run wrote nothing).
    if (!dryRun && typeof err === 'object' && err !== null) rolledBack.add(err);
    throw err;
  }
  // state.json is on disk: past the point of no return, so a Ctrl+C during
  // the hooks can't walk the update back (spec §9.3).
  io.onCommitted();

  // Bootstrap only if its fingerprint changed, then post-update. A dry run
  // reports deferred outcomes without spawning.
  const hookAbort = new AbortController();
  io.onHookAbort(hookAbort);
  let hooks: HookOutcome[];
  try {
    const hookRun = await runHooks(
      {
        command: 'update',
        tempDir: ctx.newTempDir,
        manifest: ctx.newManifest,
        schema: ctx.newSchema,
        vaultRoot,
        state: result.state,
        values,
        modules: selections,
        previousVersion: ctx.state.version,
        newFiles: result.summary.addedFiles,
        removedFiles: result.summary.deletedFiles,
        dryRun,
      },
      { ...io.hooks, signal: hookAbort.signal },
    );
    hooks = hookRun.outcomes;
  } finally {
    io.onHookAbort(null);
  }

  return {
    kind: 'done',
    summary: result.summary,
    migrationWarnings: ctx.migrationWarnings,
    hooks,
    durationMs: Date.now() - start,
    backupDir: result.backupDir ? toPosix(vaultRoot, result.backupDir) : null,
    externalTools,
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
 * The install and the source to resolve it from: `UPDATE_NO_INSTALL`
 * without one, `UPDATE_FLAG_CONFLICT` for flags that cannot combine.
 * `state.ref` re-resolves the tracked ref; `--release` pins a tag;
 * otherwise the recorded source's latest stable release.
 */
export async function readUpdateTarget(
  vaultRoot: string,
  opts: { release?: string; includePrerelease?: boolean } = {},
): Promise<{ state: ShardState; source: string }> {
  const state = await readState(vaultRoot);
  if (!state) throwNoInstall();
  assertFlagsCompatible({ stateRef: state.ref ?? null, release: opts.release, includePrerelease: opts.includePrerelease ?? false });
  const source = state.ref ? `${state.source}#${state.ref}` : opts.release ? `${state.source}@${opts.release}` : state.source;
  return { state, source };
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

function loadCurrentValues(vaultRoot: string): Promise<Record<string, unknown>> {
  return loadValuesYaml(path.join(vaultRoot, VALUES_FILE), {
    label: VALUES_FILE,
    errors: { readFailed: 'VALUES_READ_FAILED', invalid: 'VALUES_INVALID' },
  });
}

async function loadCachedSchema(vaultRoot: string, state: ShardState): Promise<ShardSchema> {
  try {
    return await parseSchema(path.join(vaultRoot, '.shardmind', 'shard-schema.yaml'));
  } catch (err) {
    throw new ShardMindError(
      'Cached schema missing or corrupt',
      'UPDATE_CACHE_MISSING',
      `Re-run \`shardmind install ${state.source}\` to regenerate .shardmind/. ` +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

