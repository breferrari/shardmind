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
 *
 * Spec: docs/SHARD-LAYOUT.md §Hook lifecycle; docs/IMPLEMENTATION.md §4.16a.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  ModuleSelections,
  ShardManifest,
  ShardSchema,
  ShardState,
  SlottedHookContext,
} from '../runtime/types.js';
import { HOOK_LOGS_DIR, hookLogRelPath } from '../runtime/vault-paths.js';
import { DEFAULT_HOOK_TIMEOUT_MS } from './manifest.js';
import {
  runHook,
  summarizeHook,
  headLines,
  type HookResult,
  type HookStage,
  type HookSummary,
  type RunningHookPhase,
} from './hook.js';
import {
  detectManagedWrites,
  detectUnmanagedCreates,
  eitherIgnores,
  excludesEveryFolder,
  loadBoundaryIgnore,
  snapshotUnmanaged,
  type HookViolation,
  type UnmanagedSnapshot,
} from './hook-boundary.js';
import { rehashManagedFiles, snapshotTrackedHashes, writeState, type RehashResult } from './state.js';
import { loadShardmindignore, parseShardmindignore, type IgnoreFilter } from './shardmindignore.js';
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
  /** Managed paths newly added: summary.addedFiles on update, for post-update; `[]` on install and adopt. */
  newFiles: string[];
  /** Managed paths removed: a reinstall's removals on install (#228), `[]` on adopt, summary.deletedFiles on update. bootstrap and post-update receive it (#356). */
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
  makeCtx: () => SlottedHookContext;
  boundary: 'managed-write' | 'unmanaged-create' | 'none';
  /** When false, the hook is declared but the engine chooses not to run it. */
  willRun: boolean;
  skippedReason?: 'values-are-defaults';
}

export async function runHooks(plan: HookRunPlan, ui: HookRunUi): Promise<HookRunResult> {
  const { manifest } = plan;
  const hooks = manifest.hooks ?? {};
  const shardLabel = `${manifest.namespace}/${manifest.name}`;
  const timeoutMs = hooks.timeout_ms ?? DEFAULT_HOOK_TIMEOUT_MS;

  const defaults = valuesAreDefaultsSafe(plan.values, plan.schema);

  const jobs = buildJobs(plan, defaults);

  // Slots that actually spawn a subprocess — drives the "(N of M)" markers.
  const runnableCount = jobs.filter((j) => j.willRun && j.relPath !== undefined).length;

  if (plan.dryRun) {
    // Faithful preview: honor the same gating the live run would. A slot the
    // engine would skip (personalize under Invariant 2, a bootstrap whose
    // fingerprint is unchanged) must NOT be reported as a hook that "would
    // fire" — that's exactly what the live loop below decides via willRun.
    const outcomes: HookOutcome[] = [];
    for (const job of jobs) {
      if (job.relPath === undefined) continue;
      if (!job.willRun) {
        if (job.skippedReason) outcomes.push({ slot: job.slot, summary: { skipped: job.skippedReason } });
        continue;
      }
      const result = await runHook(plan.tempDir, job.relPath);
      outcomes.push({ slot: job.slot, summary: summarizeHook(result) });
    }
    return { outcomes, finalState: plan.state, stateChanged: false };
  }

  const outcomes: HookOutcome[] = [];
  let state = plan.state;
  let stateChanged = false;
  let runIndex = 0;
  // Lazily loaded once and reused across a slot's before/after snapshots so
  // the vault `.shardmindignore` is parsed at most once per run.
  let ignore: IgnoreFilter | undefined;
  // Why `.shardmind/boundary-ignore` was not applied, when it was not (#190).
  let ignoreProblem: string | undefined;
  // Tracked-file hashes before any slot runs. The re-hash compares against
  // this, not against `rendered_hash`: a file the user edited before the
  // hook phase differs from its recorded baseline without any hook touching
  // it, and must neither be re-baselined nor read as a bootstrap write
  // (#150). No slot runs ⇒ nothing to attribute ⇒ no snapshot, no re-hash.
  let baseline = runnableCount > 0 ? await snapshotSafe(plan.vaultRoot, state) : null;
  // Whether a hook ran since `baseline` was taken. Bootstrap's re-hash
  // clears it, so a run where nothing follows bootstrap skips the final pass.
  let hookRanSinceBaseline = false;

  for (const job of jobs) {
    if (job.relPath === undefined) continue;

    // Cancellation: once the user has Ctrl+C'd (the machine aborts the shared
    // signal), stop launching further slots — spawning a child against an
    // already-aborted signal would surface as a spurious "spawn failed" rather
    // than a clean cancel. The final re-hash below still runs.
    if (ui.signal?.aborted) break;

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
    let unmanagedBefore: UnmanagedSnapshot | undefined;
    if (job.boundary === 'unmanaged-create') {
      if (!ignore) {
        // The vault owner's exclusions (#190) join the vault's .shardmindignore.
        const own = await loadBoundaryIgnore(plan.vaultRoot);
        const base = await loadIgnoreSafe(plan.vaultRoot);
        ignoreProblem = own.problem;
        if (own.filter && (await excludesEveryFolder(plan.vaultRoot, base, own.filter))) {
          ignoreProblem = 'it excludes every folder at the vault root, which would switch the check off';
        }
        ignore = own.filter && ignoreProblem === undefined ? eitherIgnores(base, own.filter) : base;
      }
      unmanagedBefore = await snapshotUnmanaged(plan.vaultRoot, ignore);
    }

    hookRanSinceBaseline = true;
    const result = await runHook(plan.tempDir, job.relPath, job.makeCtx(), {
      timeoutMs,
      onStdout: ui.onStdout,
      onStderr: ui.onStderr,
      signal: ui.signal,
    });

    let violation: HookViolation | null = null;

    if (job.boundary === 'managed-write') {
      // Re-hash now (only bootstrap has run) so changed managed files are
      // attributable to it. Reuses the post-hook re-hash machinery. A managed
      // file bootstrap *deleted* lands in `missing`, not `changed` — fold both
      // in so a destructive write is flagged too.
      const rehash = await rehashSafe(plan.vaultRoot, state, baseline);
      if (rehash) {
        if (rehash.rebaselined.length > 0) stateChanged = true;
        state = rehash.state;
        // Later slots' writes are measured from here, so bootstrap's are not
        // attributed to them twice.
        baseline = rehash.current;
        hookRanSinceBaseline = false;
        // `changed` (modified) + `missing` (deleted) only. `rehash.failed`
        // (EACCES/EIO) is deliberately NOT folded in: a transient I/O error is
        // not necessarily a hook write, and flagging it would be a false
        // positive on the non-fatal warning.
        violation = detectManagedWrites([...rehash.changed, ...rehash.missing]);
      }
    } else if (job.boundary === 'unmanaged-create' && unmanagedBefore && ignore) {
      const after = await snapshotUnmanaged(plan.vaultRoot, ignore);
      violation = detectUnmanagedCreates(after, unmanagedBefore, state);
    }

    const summary = summarize(result, {
      violation,
      ignoreProblem: job.boundary === 'unmanaged-create' ? ignoreProblem : undefined,
    });
    // Persist the full output (and attach the pointer) when the hook crashed or
    // its output is long enough that the Summary will truncate it.
    const withLog = summary ? await attachHookLog(plan.vaultRoot, job.slot, summary) : summary;
    outcomes.push({ slot: job.slot, summary: withLog });

    // Persist the bootstrap fingerprint only after a SUCCESSFUL bootstrap
    // (exit 0), so the next update compares against it (Invariant 4). A
    // bootstrap that failed (non-zero exit or threw) must re-run on the next
    // update — recording its fingerprint would strand a never-built artifact.
    if (job.slot === 'bootstrap' && result.kind === 'ran' && result.exitCode === 0) {
      const fp = hooks.bootstrap?.fingerprint;
      if (state.bootstrap_fingerprint !== fp) {
        state = { ...state, bootstrap_fingerprint: fp };
        stateChanged = true;
      }
    }
  }

  // Final re-hash so state.json reflects any managed-file edits the last hook
  // made (personalize / post-update writes), then persist if anything moved.
  const finalRehash = hookRanSinceBaseline ? await rehashSafe(plan.vaultRoot, state, baseline) : null;
  if (finalRehash) {
    if (finalRehash.rebaselined.length > 0) stateChanged = true;
    state = finalRehash.state;
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
  defaults: boolean,
): SlotJob[] {
  const hooks = plan.manifest.hooks ?? {};
  const base = {
    vaultRoot: plan.vaultRoot,
    values: plan.values,
    modules: plan.modules,
    shard: { name: plan.manifest.name, version: plan.manifest.version },
  };

  if (plan.command === 'update') {
    const jobs: SlotJob[] = [];
    jobs.push({
      slot: 'bootstrap',
      relPath: hooks.bootstrap?.script,
      boundary: 'managed-write',
      willRun: bootstrapShouldRerun(plan.state.bootstrap_fingerprint, hooks.bootstrap?.fingerprint),
      makeCtx: () => ({
        slot: 'bootstrap',
        ...base,
        previousVersion: plan.previousVersion,
        valuesAreDefaults: defaults,
        removedFiles: plan.removedFiles,
      }),
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
  return [
    {
      slot: 'bootstrap',
      relPath: hooks.bootstrap?.script,
      boundary: 'managed-write',
      willRun: true,
      makeCtx: () => ({ slot: 'bootstrap', ...base, valuesAreDefaults: defaults, removedFiles: plan.removedFiles }),
    },
    {
      slot: 'personalize',
      relPath: hooks.personalize,
      boundary: 'unmanaged-create',
      // Invariant 2: engine skips personalize entirely on a defaults install.
      willRun: !defaults,
      skippedReason: defaults ? 'values-are-defaults' : undefined,
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

/** Merge a boundary violation into a HookResult summary. */
function summarize(
  result: HookResult,
  extra: { violation: HookViolation | null; ignoreProblem?: string },
): HookSummary | null {
  const summary = summarizeHook(result);
  // Nothing to render: the hook produced no summary (e.g. the script vanished
  // between lookup and run → `absent`) and there's no violation to surface
  // on its own.
  if (!summary && !extra.violation) return null;
  const merged: HookSummary = summary ? { ...summary } : {};
  if (extra.violation) {
    merged.violation = { kind: extra.violation.kind, paths: extra.violation.paths };
    if (extra.violation.unreadable) merged.violation.unreadable = extra.violation.unreadable;
  }
  // Only beside a hook that ran: a vanished script has no walk to qualify.
  if (extra.ignoreProblem && summary) merged.ignoreProblem = extra.ignoreProblem;
  return merged;
}

/**
 * Persist a hook's full captured output to `.shardmind/logs/<slot>.log` when it
 * is worth pointing at — the hook crashed (non-zero exit / failure) or either
 * stream is long enough that the Summary will truncate it — and return the
 * summary with `logPath` set. A short, clean hook writes nothing (no clutter,
 * no perturbation of clean-path E2E) and is returned unchanged.
 *
 * Non-fatal: a log-write failure (read-only vault, ENOSPC) just omits the
 * pointer; it must never break an install whose hook is already non-fatal by
 * contract (ARCHITECTURE.md §9.3). The log lives under `.shardmind/`, so it is
 * excluded from Invariant 1 byte-equivalence.
 */
export async function attachHookLog(
  vaultRoot: string,
  slot: HookStage,
  summary: HookSummary,
): Promise<HookSummary> {
  const stdout = summary.stdout ?? '';
  const stderr = summary.stderr ?? '';
  if (stdout === '' && stderr === '') return summary;

  const crashed = (summary.exitCode ?? 0) !== 0;
  const willTruncate =
    headLines(stdout.trim()).hidden > 0 || headLines(stderr.trim()).hidden > 0;
  if (!crashed && !willTruncate) return summary;

  try {
    await fsp.mkdir(path.join(vaultRoot, HOOK_LOGS_DIR), { recursive: true });
    const relPath = hookLogRelPath(slot);
    await fsp.writeFile(path.join(vaultRoot, relPath), formatHookLog(slot, summary), 'utf-8');
    return { ...summary, logPath: relPath };
  } catch {
    return summary;
  }
}

/** Readable full-output dump written to `.shardmind/logs/<slot>.log`. */
function formatHookLog(slot: HookStage, summary: HookSummary): string {
  return [
    `# ShardMind ${slot} hook — full captured output`,
    `# exit code: ${summary.exitCode ?? 0}`,
    '',
    '=== stdout ===',
    summary.stdout ?? '',
    '',
    '=== stderr ===',
    summary.stderr ?? '',
    '',
  ].join('\n');
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

async function loadIgnoreSafe(vaultRoot: string): Promise<IgnoreFilter> {
  try {
    return await loadShardmindignore(vaultRoot);
  } catch {
    // A vault `.shardmindignore` that cannot be read (an I/O error)
    // must not break a courtesy boundary check — fall back to no filtering.
    return parseShardmindignore('');
  }
}

async function snapshotSafe(
  vaultRoot: string,
  state: ShardState,
): Promise<Map<string, string> | null> {
  try {
    return await snapshotTrackedHashes(vaultRoot, state);
  } catch {
    return null;
  }
}

/** `null` when there is no baseline (no snapshot taken) or the re-hash threw. */
async function rehashSafe(
  vaultRoot: string,
  state: ShardState,
  baseline: ReadonlyMap<string, string> | null,
): Promise<RehashResult | null> {
  if (!baseline) return null;
  try {
    return await rehashManagedFiles(vaultRoot, state, baseline);
  } catch {
    return null;
  }
}
