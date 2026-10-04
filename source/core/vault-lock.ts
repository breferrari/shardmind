/**
 * One shardmind run per vault (#253). See docs/IMPLEMENTATION.md §4.25 and
 * ARCHITECTURE §10.5c.
 *
 * `install`, `update` and `adopt` hold `<vault>/.shardmind.lock` for the
 * whole run. Synchronous throughout, so the process `exit` handler can
 * release it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ShardMindError } from '../runtime/types.js';
import { errnoCode } from '../runtime/errno.js';
import { LOCK_FILE } from '../runtime/vault-paths.js';

export interface VaultLockInfo {
  pid: number;
  hostname: string;
  command: string;
  startedAt: string;
}

export interface VaultLock {
  /** Remove the lock if this run still holds it. Idempotent. */
  release(): void;
  /** Set when a stale lock, whose run was gone, was taken over. */
  tookOver?: VaultLockInfo;
}

/** An empty lock older than this is a run that died between create and write. */
const EMPTY_LOCK_STALE_MS = 30_000;

export function acquireVaultLock(
  vaultRoot: string,
  command: 'install' | 'update' | 'adopt',
  deps: {
    pid?: number;
    hostname?: string;
    isAlive?: (pid: number) => boolean;
    now?: () => Date;
    /** Test seam: runs between judging a lock stale and moving it out of the way. */
    beforeTakeover?: () => void;
  } = {},
): VaultLock {
  const file = path.join(vaultRoot, LOCK_FILE);
  const now = deps.now ?? (() => new Date());
  const mine: VaultLockInfo = {
    pid: deps.pid ?? process.pid,
    hostname: deps.hostname ?? os.hostname(),
    command,
    startedAt: now().toISOString(),
  };
  const isAlive = deps.isAlive ?? processIsAlive;

  let tookOver: VaultLockInfo | undefined;
  if (!tryCreate(file, mine)) {
    const found = inspect(file, now());
    const stale =
      found.kind === 'abandoned' ||
      (found.kind === 'holder' &&
        sameHost(found.holder.hostname, mine.hostname) &&
        (found.holder.pid === mine.pid || !isAlive(found.holder.pid)));
    if (!stale) throw lockedError(found.kind === 'holder' ? found.holder : undefined, mine.hostname);
    deps.beforeTakeover?.();
    takeOver(file, found, mine.hostname);
    if (!tryCreate(file, mine)) {
      const now2 = inspect(file, now());
      throw lockedError(now2.kind === 'holder' ? now2.holder : undefined, mine.hostname);
    }
    if (found.kind === 'holder') tookOver = found.holder;
  }

  const release = (): void => {
    process.removeListener('exit', release);
    const current = inspect(file, now());
    if (current.kind === 'holder' && current.holder.pid === mine.pid && current.holder.startedAt === mine.startedAt) {
      try {
        fs.rmSync(file);
      } catch {
        // Already gone; nothing is left to release.
      }
    }
  };
  // The backstop: a crash handler's or a Ctrl+C's process.exit still runs it.
  process.on('exit', release);
  return tookOver ? { release, tookOver } : { release };
}

/**
 * True when a live run of another process holds the vault. Status, which
 * takes no lock, uses it to keep out of `.shardmind/` meanwhile: a reinstall
 * moves that folder aside mid-run.
 */
export function isHeldByAnotherRun(vaultRoot: string, isAlive: (pid: number) => boolean = processIsAlive): boolean {
  const found = inspect(path.join(vaultRoot, LOCK_FILE), new Date());
  if (found.kind === 'none') return false;
  if (found.kind !== 'holder') return true;
  return found.holder.pid !== process.pid && (!sameHost(found.holder.hostname, os.hostname()) || isAlive(found.holder.pid));
}

type Inspection =
  | { kind: 'none' }
  | { kind: 'holder'; holder: VaultLockInfo }
  | { kind: 'abandoned' }
  | { kind: 'unreadable' };

/** What is at the lock path. An empty file older than a moment is a run that died before writing it. */
function inspect(file: string, now: Date): Inspection {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    return errnoCode(err) === 'ENOENT' ? { kind: 'none' } : { kind: 'unreadable' };
  }
  if (!stat.isFile()) return { kind: 'unreadable' };
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return { kind: 'unreadable' };
  }
  if (text.trim() === '') {
    return now.getTime() - stat.mtimeMs > EMPTY_LOCK_STALE_MS ? { kind: 'abandoned' } : { kind: 'unreadable' };
  }
  try {
    const parsed = JSON.parse(text) as Partial<VaultLockInfo>;
    if (
      typeof parsed.pid === 'number' &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.hostname === 'string' &&
      typeof parsed.command === 'string' &&
      typeof parsed.startedAt === 'string'
    ) {
      return { kind: 'holder', holder: parsed as VaultLockInfo };
    }
  } catch {
    // Not JSON.
  }
  return { kind: 'unreadable' };
}

/**
 * Move the stale lock aside under a unique name, then check it is the one
 * judged stale. Another run may have taken it over in between: then that
 * run's fresh lock goes back, and its holder is reported.
 */
function takeOver(file: string, judged: Inspection, hostname: string): void {
  const grave = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.stale`;
  try {
    fs.renameSync(file, grave);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return; // Gone already; the create decides.
    throw lockedError(judged.kind === 'holder' ? judged.holder : undefined, hostname);
  }
  const moved = inspect(grave, new Date());
  const same =
    moved.kind === judged.kind &&
    (moved.kind !== 'holder' ||
      (judged.kind === 'holder' && moved.holder.pid === judged.holder.pid && moved.holder.startedAt === judged.holder.startedAt));
  if (same) {
    fs.rmSync(grave, { force: true });
    return;
  }
  // Someone else's fresh lock: put it back (link refuses to overwrite).
  try {
    fs.linkSync(grave, file);
  } catch {
    // A third run already holds the name; it stays.
  }
  fs.rmSync(grave, { force: true });
  throw lockedError(moved.kind === 'holder' ? moved.holder : undefined, hostname);
}

/** `wx`: create only if absent. False when the name is taken; other errors throw. */
function tryCreate(file: string, info: VaultLockInfo): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'EEXIST' || code === 'EISDIR') return false;
    // EPERM: on Windows, a file whose delete is still pending, or a folder
    // the user cannot write to. Only the first is "taken".
    if (code === 'EPERM' && fs.existsSync(file)) return false;
    throw err;
  }
  try {
    fs.writeSync(fd, `${JSON.stringify(info)}\n`);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(file, { force: true });
    throw err;
  }
  fs.closeSync(fd);
  return true;
}

/** Hostnames compared without case or a trailing `.local`, which macOS adds and drops as the network changes. */
function sameHost(a: string, b: string): boolean {
  const norm = (h: string) => h.toLowerCase().replace(/\.local$/, '');
  return norm(a) === norm(b);
}

/** `kill(pid, 0)`: no signal, only the check. EPERM means it runs as another user. */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errnoCode(err) === 'EPERM';
  }
}

function lockedError(holder: VaultLockInfo | undefined, hostname: string): ShardMindError {
  const hint = `Wait for that run to finish, then run again. If no shardmind process is running (it crashed, or the lock was synced or committed into the vault), ${LOCK_FILE} in the vault folder is safe to delete.`;
  if (!holder) {
    return new ShardMindError(`The vault is locked by ${LOCK_FILE}, which could not be read as a shardmind lock`, 'VAULT_LOCKED', hint);
  }
  const where = sameHost(holder.hostname, hostname) ? '' : ` on ${holder.hostname}`;
  return new ShardMindError(
    `Another shardmind run is working on this vault: ${holder.command} (PID ${holder.pid}${where}, started ${holder.startedAt})`,
    'VAULT_LOCKED',
    hint,
  );
}
