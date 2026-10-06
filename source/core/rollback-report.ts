/**
 * Reporting a rollback that could not put everything back (#247).
 *
 * Install, update and adopt each roll back a failed run best effort and
 * collect what they could not undo. A failed restore must never reach the
 * user as "rolled back" (#207): the run instead fails with
 * `ROLLBACK_INCOMPLETE`, a known error whose message names every path the
 * rollback could not restore or remove and, for a restore, where its backup
 * is, so a person and a `--json` reader both see what to fix by hand.
 */

import { ShardMindError } from '../runtime/types.js';

/** One path a rollback could not restore or remove, and why. */
export interface RollbackFailure {
  path: string;
  reason: string;
  /** Where the file's backup still is, when the rollback had one. */
  backup?: string;
}

/**
 * The error to throw for `err` when its rollback left `failures`: `err`
 * itself when there are none, else a `ROLLBACK_INCOMPLETE` error. Its
 * message starts with the original failure (and its code), then lists every
 * failure with its backup. The original is attached as `cause` and never
 * mutated: a frozen third-party error would throw, and a message edited
 * twice up the stack would repeat itself.
 */
export function withRollbackFailures(err: unknown, failures: readonly RollbackFailure[]): unknown {
  if (failures.length === 0) return err;
  const original = err instanceof ShardMindError ? `${err.message} (${err.code})` : reasonOf(err);
  const remedy =
    'Each listed path is as the failed run left it: copy back the ones with a backup, and remove ' +
    'or put back the others, before you run shardmind again.';
  const wrapped = new ShardMindError(
    `${original}\n${formatRollbackFailures(failures)}`,
    'ROLLBACK_INCOMPLETE',
    err instanceof ShardMindError && err.hint ? `${err.hint}\n${remedy}` : remedy,
  );
  return Object.assign(wrapped, { rollbackFailures: [...failures], cause: err });
}

/**
 * Run a rollback and return what it could not undo. A rollback that throws
 * partway is a failure too, never a clean one: it may have stopped before
 * restoring anything.
 */
export async function attemptRollback(
  rollback: () => Promise<RollbackFailure[]>,
): Promise<RollbackFailure[]> {
  try {
    return await rollback();
  } catch (err) {
    return [{ path: '(the rollback)', reason: `stopped partway: ${reasonOf(err)}` }];
  }
}

/** An error's message, or the thrown value as text. */
export function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The errors whose run rolled the vault back before throwing (install, update, adopt). */
const rolledBack = new WeakSet<object>();

/** Mark `err` as thrown by a run that rolled the vault back (§4.30 step 4). */
export function markRolledBack(err: unknown): void {
  if (typeof err === 'object' && err !== null) rolledBack.add(err);
}

/** Whether the run that threw `err` rolled the vault back, for the error view's line. */
export function wasRolledBack(err: unknown): boolean {
  return typeof err === 'object' && err !== null && rolledBack.has(err);
}

/** The failures `withRollbackFailures` attached to `err`, or none. */
export function rollbackFailuresOf(err: unknown): RollbackFailure[] {
  if (typeof err !== 'object' || err === null) return [];
  const list = (err as { rollbackFailures?: unknown }).rollbackFailures;
  return Array.isArray(list) ? (list as RollbackFailure[]) : [];
}

/**
 * The error view's line about the rollback: `rolledBack` ("Rolled back
 * partial …") only when the rollback reported nothing; otherwise none,
 * since the error itself says the rollback is incomplete.
 */
export function rollbackDetail(err: unknown, rolledBack: string): string | undefined {
  return rollbackFailuresOf(err).length === 0 ? rolledBack : undefined;
}

/** "Rollback incomplete (N paths):" and one line per failure, with its backup. */
export function formatRollbackFailures(failures: readonly RollbackFailure[]): string {
  const lines = failures.map(
    (f) => `  - ${f.path}: ${f.reason}${f.backup ? `; its backup is at ${f.backup}` : ''}`,
  );
  const n = failures.length;
  return `Rollback incomplete (${n} ${n === 1 ? 'path' : 'paths'}):\n${lines.join('\n')}`;
}
