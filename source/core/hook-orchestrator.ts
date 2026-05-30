/**
 * Hook lifecycle orchestration (#102).
 *
 * Decides which hook slots fire, in what order, with what per-slot context;
 * runs each via `runHook`; applies the write-boundary checks
 * (`hook-boundary.ts`); runs the post-hook re-hash; persists
 * `bootstrap_fingerprint`. Pure of Ink/React — the three command machines
 * (`use-{install,update,adopt}-machine.ts`) pass UI callbacks and keep only
 * their React-state plumbing. Replaces the ~45-line hook block previously
 * inlined (and triplicated) across the machines.
 *
 * Slot order:
 *   - install / adopt: bootstrap → personalize (personalize skipped entirely
 *     when valuesAreDefaults — engine-enforced Invariant 2).
 *   - update: bootstrap (only if its fingerprint changed) → post-update.
 *   - legacy: a lone `post-install` runs once on install/adopt with the flat
 *     legacy context and no boundary enforcement, plus a deprecation warning.
 *
 * Spec: docs/SHARD-LAYOUT.md §Hook lifecycle; docs/IMPLEMENTATION.md §4.16a.
 */

import type {
  AnyHookContext,
  ModuleSelections,
  ShardManifest,
  ShardSchema,
  ShardState,
} from '../runtime/types.js';
import { DEFAULT_HOOK_TIMEOUT_MS } from './manifest.js';
import {
  runHook,
  summarizeHook,
  type HookResult,
  type HookStage,
  type HookSummary,
  type RunningHookPhase,
} from './hook.js';
import {
  detectManagedWrites,
  detectUnmanagedCreates,
  snapshotUnmanaged,
  type HookViolation,
} from './hook-boundary.js';
import { rehashManagedFiles, writeState } from './state.js';
import { loadShardmindignore, parseShardmindignore } from './shardmindignore.js';
import { valuesAreDefaults } from './values-defaults.js';

export interface HookRunPlan {
  command: 'install' | 'adopt' | 'update';
  /** Extracted shard source dir where hook scripts live. */
  tempDir: string;
  manifest: ShardManifest;
  schema: ShardSchema;
  vaultRoot: string;
  /** Post-executor state (base for re-hash, managed snapshot, fingerprint). */
  state: ShardState;
  values: Record<string, unknown>;
  modules: ModuleSelections;
  /** Set on update (and adopt-from-install); carried into ctx.previousVersion. */
  previousVersion?: string;
  /** Managed paths newly added — `[]` on install, summary.addedFiles on update. */
  newFiles: string[];
  /** Managed paths removed — `[]` on install/adopt, summary.deletedFiles on update. */
  removedFiles: string[];
  dryRun: boolean;
}

export interface HookRunUi {
  setPhase: (phase: RunningHookPhase) => void;
  onStdout: (chunk: string) => void;
  onStderr: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface HookOutcome {
  slot: HookStage;
  summary: HookSummary | null;
}

export interface HookRunResult {
  outcomes: HookOutcome[];
  /** State after re-hash + fingerprint write; the machine persists nothing else. */
  finalState: ShardState;
  stateChanged: boolean;
}

/** Description of one slot the orchestrator will consider running. */
interface SlotJob {
  slot: HookStage;
  relPath: string | undefined;
  makeCtx: () => AnyHookContext;
  boundary: 'managed-write' | 'unmanaged-create' | 'none';
  /** When false, the hook is declared but the engine chooses not to run it. */
  willRun: boolean;
  skippedReason?: 'values-are-defaults';
  deprecated?: boolean;
}

export async function runHooks(plan: HookRunPlan, ui: HookRunUi): Promise<HookRunResult> {
  const { manifest } = plan;
  const hooks = manifest.hooks ?? {};
  const shardLabel = `${manifest.namespace}/${manifest.name}`;
  const shard = { name: manifest.name, version: manifest.version };
  const timeoutMs = hooks.timeout_ms ?? DEFAULT_HOOK_TIMEOUT_MS;

  const isLegacyInstall =
    plan.command !== 'update' &&
    Boolean(hooks['post-install']) &&
    !hooks.bootstrap &&
    !hooks.personalize;

  const defaults = valuesAreDefaultsSafe(plan.values, plan.schema);

  const jobs = buildJobs(plan, { isLegacyInstall, defaults, shard });

  // Slots that actually spawn a subprocess — drives the "(N of M)" markers.
  const runnableCount = jobs.filter((j) => j.willRun && j.relPath !== undefined).length;

  if (plan.dryRun) {
    // Report a deferred/absent outcome per declared slot without executing.
    const outcomes: HookOutcome[] = [];
    for (const job of jobs) {
      if (job.relPath === undefined) continue;
      const result = await runHook(plan.tempDir, job.relPath);
      outcomes.push({ slot: job.slot, summary: summarizeHook(result) });
    }
    return { outcomes, finalState: plan.state, stateChanged: false };
  }

  const outcomes: HookOutcome[] = [];
  let state = plan.state;
  let stateChanged = false;
  let runIndex = 0;

  for (const job of jobs) {
    if (job.relPath === undefined) continue;

    if (!job.willRun) {
      // personalize under Invariant 2 surfaces a "skipped" note so the user
      // knows the hook existed; a bootstrap that simply isn't re-running
      // (fingerprint unchanged) is silent — emit nothing.
      if (job.skippedReason) {
        outcomes.push({ slot: job.slot, summary: { skipped: job.skippedReason } });
      }
      continue;
    }

    runIndex += 1;
    ui.setPhase({
      kind: 'running-hook',
      stage: job.slot,
      output: '',
      shardLabel,
      index: runIndex,
      total: runnableCount,
    });

    // Baseline for personalize's unmanaged-create check, taken right before
    // the hook runs (so bootstrap's own artifacts are already in the baseline).
    let unmanagedBefore: Set<string> | undefined;
    if (job.boundary === 'unmanaged-create') {
      unmanagedBefore = await snapshotUnmanagedSafe(plan.vaultRoot);
    }

    const result = await runHook(plan.tempDir, job.relPath, job.makeCtx(), {
      timeoutMs,
      onStdout: ui.onStdout,
      onStderr: ui.onStderr,
      signal: ui.signal,
    });

    let violation: HookViolation | null = null;

    if (job.boundary === 'managed-write') {
      // Re-hash now (only bootstrap has run) so changed managed files are
      // attributable to it. Reuses the post-hook re-hash machinery.
      const rehash = await rehashSafe(plan.vaultRoot, state);
      if (rehash) {
        state = rehash.state;
        if (rehash.changed.length > 0) stateChanged = true;
        violation = detectManagedWrites(rehash.changed);
      }
    } else if (job.boundary === 'unmanaged-create' && unmanagedBefore) {
      const after = await snapshotUnmanagedSafe(plan.vaultRoot);
      violation = detectUnmanagedCreates(after, unmanagedBefore, state);
    }

    outcomes.push({ slot: job.slot, summary: summarize(result, { violation, deprecated: job.deprecated }) });

    // Persist the bootstrap fingerprint once bootstrap has actually run, so the
    // next update compares against it (Invariant 4).
    if (job.slot === 'bootstrap' && result.kind === 'ran') {
      const fp = hooks.bootstrap?.fingerprint;
      if (state.bootstrap_fingerprint !== fp) {
        state = { ...state, bootstrap_fingerprint: fp };
        stateChanged = true;
      }
    }
  }

  // Final re-hash so state.json reflects any managed-file edits the last hook
  // made (personalize / post-update writes), then persist if anything moved.
  const finalRehash = await rehashSafe(plan.vaultRoot, state);
  if (finalRehash) {
    state = finalRehash.state;
    if (finalRehash.changed.length > 0) stateChanged = true;
  }

  if (stateChanged) {
    try {
      await writeState(plan.vaultRoot, state);
    } catch {
      // Non-fatal: the executor already wrote state.json; drift detection
      // surfaces any discrepancy on the next status run. See shared.ts.
    }
  }

  return { outcomes, finalState: state, stateChanged };
}

/** Build the ordered slot jobs for this command. */
function buildJobs(
  plan: HookRunPlan,
  ctx: { isLegacyInstall: boolean; defaults: boolean; shard: { name: string; version: string } },
): SlotJob[] {
  const hooks = plan.manifest.hooks ?? {};
  const { shard } = ctx;
  const base = {
    vaultRoot: plan.vaultRoot,
    values: plan.values,
    modules: plan.modules,
    shard,
  };

  if (plan.command === 'update') {
    const jobs: SlotJob[] = [];
    jobs.push({
      slot: 'bootstrap',
      relPath: hooks.bootstrap?.script,
      boundary: 'managed-write',
      willRun: bootstrapShouldRerun(plan.state.bootstrap_fingerprint, hooks.bootstrap?.fingerprint),
      makeCtx: () => ({ slot: 'bootstrap', ...base, previousVersion: plan.previousVersion }),
    });
    jobs.push({
      slot: 'post-update',
      relPath: hooks['post-update'],
      boundary: 'none',
      willRun: true,
      makeCtx: () => ({
        slot: 'post-update',
        ...base,
        previousVersion: plan.previousVersion,
        newFiles: plan.newFiles,
        removedFiles: plan.removedFiles,
      }),
    });
    return jobs;
  }

  // install / adopt
  if (ctx.isLegacyInstall) {
    return [
      {
        slot: 'post-install',
        relPath: hooks['post-install'],
        boundary: 'none',
        willRun: true,
        deprecated: true,
        // Legacy flat context: keep valuesAreDefaults + file lists so existing
        // self-gating hooks behave exactly as before.
        makeCtx: () => ({
          ...base,
          valuesAreDefaults: ctx.defaults,
          newFiles: plan.newFiles,
          removedFiles: plan.removedFiles,
        }),
      },
    ];
  }

  return [
    {
      slot: 'bootstrap',
      relPath: hooks.bootstrap?.script,
      boundary: 'managed-write',
      willRun: true,
      makeCtx: () => ({ slot: 'bootstrap', ...base }),
    },
    {
      slot: 'personalize',
      relPath: hooks.personalize,
      boundary: 'unmanaged-create',
      // Invariant 2: engine skips personalize entirely on a defaults install.
      willRun: !ctx.defaults,
      skippedReason: ctx.defaults ? 'values-are-defaults' : undefined,
      makeCtx: () => ({ slot: 'personalize', ...base }),
    },
  ];
}

/** Bootstrap re-runs on update iff the manifest fingerprint differs from state. */
export function bootstrapShouldRerun(
  installed: string | undefined,
  target: string | undefined,
): boolean {
  return installed !== target;
}

/** Merge a boundary violation / deprecation flag into a HookResult summary. */
function summarize(
  result: HookResult,
  extra: { violation: HookViolation | null; deprecated?: boolean },
): HookSummary | null {
  const summary = summarizeHook(result);
  if (summary === null) {
    // A hook that was declared but absent on disk: still surface a violation /
    // deprecation note if one applies (it won't for absent, but keep shape).
    if (!extra.violation && !extra.deprecated) return null;
  }
  const merged: HookSummary = summary ?? {};
  if (extra.violation) {
    merged.violation = { kind: extra.violation.kind, paths: extra.violation.paths };
  }
  if (extra.deprecated) merged.deprecated = true;
  return merged;
}

function valuesAreDefaultsSafe(values: Record<string, unknown>, schema: ShardSchema): boolean {
  try {
    return valuesAreDefaults(values, schema);
  } catch {
    // Hook gating is non-fatal: on any coercion failure, treat as non-default
    // so personalize still runs (the conservative choice — never silently skip
    // personalization the user might expect).
    return false;
  }
}

async function snapshotUnmanagedSafe(vaultRoot: string): Promise<Set<string>> {
  let ignore;
  try {
    ignore = await loadShardmindignore(vaultRoot);
  } catch {
    // A vault `.shardmindignore` with unsupported negation (or an I/O error)
    // must not break a courtesy boundary check — fall back to no filtering.
    ignore = parseShardmindignore('');
  }
  return snapshotUnmanaged(vaultRoot, ignore);
}

async function rehashSafe(
  vaultRoot: string,
  state: ShardState,
): Promise<{ state: ShardState; changed: string[] } | null> {
  try {
    const r = await rehashManagedFiles(vaultRoot, state);
    return { state: r.state, changed: r.changed };
  } catch {
    return null;
  }
}
