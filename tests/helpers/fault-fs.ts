/**
 * One fault injector over the shared `fsp` (#267).
 *
 * Every write path in install, update and adopt calls the default
 * `node:fs/promises` object (the executors, `state.ts`, `fs-utils.removePath`,
 * `created-folders.ts`). This wraps its mutating methods for the length of
 * one run: it counts each call by kind, and throws or runs a hook at the
 * call a fault plan names. Installed once per row and always uninstalled;
 * no test spies on `fsp` by hand. `rollback-contract.test.ts` guards that
 * no write path reaches the vault around it.
 */

import fsp from 'node:fs/promises';

/** What a call does to the vault. `restore` is a copy or rename out of a run's backup. */
export type FaultKind = 'write' | 'rename' | 'mkdir' | 'remove' | 'restore';

export type FaultCounts = Record<FaultKind, number>;

export interface FaultPlan {
  /** Throw at the `nth` call (1-based) of `kind`. */
  fail?: { kind: FaultKind; nth: number };
  /** Also throw at the `nth` restore: a rollback that cannot put a file back. */
  failRestore?: { nth: number };
  /** Run `hook` just before the `nth` write goes on (a Ctrl+C mid-write). */
  beforeWrite?: { nth: number; hook: () => void };
}

const KIND: Record<string, Exclude<FaultKind, 'restore'>> = {
  writeFile: 'write',
  copyFile: 'write',
  cp: 'write',
  rename: 'rename',
  mkdir: 'mkdir',
  rm: 'remove',
  unlink: 'remove',
  rmdir: 'remove',
};

/** A run's backups: install's `*.shardmind-backup-*`, update's and adopt's snapshot. */
const BACKUP = /\.shardmind-backup-|[\\/]\.shardmind[\\/]backups[\\/]/;

/** The error a fault throws: an fs error, as the executors would see one. */
export function injectedError(kind: FaultKind, nth: number): NodeJS.ErrnoException {
  return Object.assign(new Error(`injected EIO at ${kind} #${nth}`), { code: 'EIO' });
}

/**
 * Wrap `fsp`'s mutating methods with `plan` until the returned `uninstall`
 * runs. `counts` is live: after a run without faults it is that run's
 * number of calls of each kind.
 */
export function injectFaults(plan: FaultPlan = {}): {
  counts: FaultCounts;
  /**
   * The destinations of writes and renames started after `beforeWrite`'s
   * hook ran (the write it ran before is not one).
   */
  writtenAfterHook: string[];
  /** Which of the plan's faults happened: a row whose fault never fired proves nothing. */
  fired: { fail: boolean; restore: boolean; hook: boolean };
  /** Mark the run as over: every fs mutation from now on is recorded (#274). */
  settle: () => void;
  /** What was written, renamed, made or removed after `settle`: a run still going. */
  touchedAfterSettle: string[];
  uninstall: () => void;
} {
  const counts: FaultCounts = { write: 0, rename: 0, mkdir: 0, remove: 0, restore: 0 };
  let hooked = false;
  const fired = { fail: false, restore: false, hook: false };
  let settled = false;
  const touchedAfterSettle: string[] = [];
  const writtenAfterHook: string[] = [];
  const target = fsp as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const originals = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  for (const [method, base] of Object.entries(KIND)) {
    const original = target[method]!;
    originals.set(method, original);
    target[method] = async (...args: unknown[]) => {
      const isRestore = (method === 'copyFile' || method === 'rename') && BACKUP.test(String(args[0]));
      const kind: FaultKind = isRestore ? 'restore' : base;
      const n = ++counts[kind];
      if (settled) touchedAfterSettle.push(`${method} ${String(method === 'copyFile' || method === 'cp' || method === 'rename' ? args[1] : args[0])}`);
      if (hooked && (kind === 'write' || kind === 'rename')) {
        writtenAfterHook.push(String(method === 'writeFile' ? args[0] : args[1]));
      }
      if (kind === 'write' && plan.beforeWrite?.nth === n) {
        hooked = true;
        fired.hook = true;
        plan.beforeWrite.hook();
      }
      if (plan.fail?.kind === kind && plan.fail.nth === n) {
        fired.fail = true;
        throw injectedError(kind, n);
      }
      if (kind === 'restore' && plan.failRestore?.nth === n) {
        fired.restore = true;
        throw injectedError(kind, n);
      }
      return original.apply(fsp, args);
    };
  }
  return {
    counts,
    writtenAfterHook,
    fired,
    settle: () => {
      settled = true;
    },
    touchedAfterSettle,
    uninstall: () => {
      for (const [method, original] of originals) target[method] = original;
    },
  };
}
