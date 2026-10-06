/**
 * The write step every flow ends with (#302). Spec: docs/IMPLEMENTATION.md
 * §4.30 step 8. The executor runs under an abort the caller can stop (a
 * Ctrl+C waits for its rollback, #249); once it returns, the run has
 * committed and its hooks run under their own abort.
 */

import { runHooks, type HookOutcome, type HookRunPlan, type HookRunUi } from '../hook-orchestrator.js';

/** The members of a flow's io its write step uses; each flow's io extends it. */
export interface FlowRunIO {
  /** The hooks' phase and output; the flow supplies the signal. */
  hooks: Omit<HookRunUi, 'signal'>;
  /**
   * Take the vault lock (#253), before the vault is read; not under
   * --dry-run. Returns its release, for a transaction that takes it once
   * the folder it makes exists (§4.28 step 1a).
   */
  lock(): { release(): void };
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

/**
 * Run the executor, then the hooks. A failure is rethrown as the executor
 * threw it: marked (`rolledBackError`) only when it rolled a transaction
 * back, not when it failed before one existed or in a dry run.
 */
export async function runAndHooks<T extends { state: HookRunPlan['state'] }>(
  io: FlowRunIO,
  run: (signal: AbortSignal) => Promise<T>,
  hooks: (result: T) => HookRunPlan,
): Promise<{ result: T; hooks: HookOutcome[] }> {
  const abort = io.newRunAbort();
  const running = run(abort.signal);
  io.onRun(abort, running);
  const result = await running;
  // state.json is on disk: past the point of no return, so a Ctrl+C during
  // the hooks can't walk the run back (ARCHITECTURE §9.3).
  io.onCommitted();

  const hookAbort = new AbortController();
  io.onHookAbort(hookAbort);
  try {
    const hookRun = await runHooks(hooks(result), { ...io.hooks, signal: hookAbort.signal });
    return { result, hooks: hookRun.outcomes };
  } finally {
    io.onHookAbort(null);
  }
}
