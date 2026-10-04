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
import { ShardMindError } from '../runtime/types.js';
import { errnoCode } from '../runtime/errno.js';
import { LOCK_FILE, LOCK_TAKEOVER_FILE } from '../runtime/vault-paths.js';

export interface VaultLockInfo {
  pid: number;
  hostname: string;
  command: string;
  startedAt: string;
}

/**
 * True when a live run of another process holds the vault. Status, which
 * takes no lock, skips its cache write meanwhile, so a run's rollback never
 * finds a file it did not write in `.shardmind/`.
 */
export function isHeldByAnotherRun(vaultRoot: string, isAlive: (pid: number) => boolean = processIsAlive): boolean {
  const found = inspect(path.join(vaultRoot, LOCK_FILE));
  if (found.kind === 'none') return false;
  if (found.kind !== 'holder') return true;
  return found.holder.pid !== process.pid && (!sameHost(found.holder.hostname, os.hostname()) || isAlive(found.holder.pid));
}

export interface VaultLock {
  /** Remove the lock if this run still holds it. Idempotent. */
  release(): void;
  /** Set when a stale lock, whose run was gone, was taken over. */
  tookOver?: VaultLockInfo;
}

/** Every lock this process holds, released by one `exit` handler (a Ctrl+C's or a crash's process.exit). */
const held = new Set<() => void>();
let exitHandlerInstalled = false;

export function acquireVaultLock(
  vaultRoot: string,
  command: 'install' | 'update' | 'adopt',
  deps: {
    pid?: number;
    hostname?: string;
    isAlive?: (pid: number) => boolean;
    now?: () => Date;
    /** When this process started; a lock with our PID from before it is a reused PID's leftover. */
    processStartedAt?: number;
  } = {},
): VaultLock {
  const file = path.join(vaultRoot, LOCK_FILE);
  const mine: VaultLockInfo = {
    pid: deps.pid ?? process.pid,
    hostname: deps.hostname ?? os.hostname(),
    command,
    startedAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
  const isAlive = deps.isAlive ?? processIsAlive;
  const startedAt = deps.processStartedAt ?? Date.now() - process.uptime() * 1000;

  const isStale = (holder: VaultLockInfo): boolean =>
    sameHost(holder.hostname, mine.hostname) &&
    (holder.pid === mine.pid ? Date.parse(holder.startedAt) < startedAt : !isAlive(holder.pid));

  let tookOver: VaultLockInfo | undefined;
  // A holder can release, or another run take a stale lock over, between our
  // create and our look: then create again, a few times.
  const ATTEMPTS = 5;
  for (let attempt = 0; ; attempt++) {
    const created = tryCreate(file, mine);
    if (created === 'created') break;
    if (attempt >= ATTEMPTS) {
      if (created instanceof Error) throw created;
      const last = inspect(file);
      if (last.kind === 'holder' && !isStale(last.holder)) throw lockedError(last.holder, mine.hostname);
      throw new ShardMindError(
        `The vault lock ${LOCK_FILE} kept changing while this run tried to take it`,
        'VAULT_LOCKED',
        'Another shardmind run is starting or finishing on this vault. Run again in a moment.',
      );
    }
    if (created instanceof Error) continue; // EPERM: on Windows, a delete still pending.
    const found = inspect(file);
    if (found.kind === 'none') continue;
    if (found.kind !== 'holder') throw lockedError(undefined, mine.hostname, found.empty === true);
    if (!isStale(found.holder)) throw lockedError(found.holder, mine.hostname);
    if (removeStale(vaultRoot, found.holder, mine, isStale)) tookOver = found.holder;
  }

  const release = (): void => {
    held.delete(release);
    const current = inspect(file);
    if (current.kind === 'holder' && current.holder.pid === mine.pid && current.holder.startedAt === mine.startedAt) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // Held open for a moment (Windows antivirus, a sync client): the run
        // is over all the same, and the next run finds our PID gone.
      }
    }
  };
  held.add(release);
  if (!exitHandlerInstalled) {
    exitHandlerInstalled = true;
    process.on('exit', () => {
      for (const r of [...held]) {
        try {
          r();
        } catch {
          // Exiting: what can't be removed is left for the next run's stale check.
        }
      }
    });
  }
  return tookOver ? { release, tookOver } : { release };
}

/**
 * Delete a lock judged stale, under the takeover file so that two runs
 * judging the same stale lock never both act: only the run holding
 * `.shardmind.lock.takeover` may delete, and it deletes only if the lock
 * still names the holder it judged. A live lock is never moved. A guard
 * left by a run that died mid-takeover is judged like a lock. True when the
 * stale lock was deleted here.
 */
function removeStale(
  vaultRoot: string,
  judged: VaultLockInfo,
  mine: VaultLockInfo,
  isStale: (holder: VaultLockInfo) => boolean,
): boolean {
  const guard = path.join(vaultRoot, LOCK_TAKEOVER_FILE);
  if (tryCreate(guard, mine) !== 'created') {
    const other = inspect(guard);
    if (other.kind === 'holder' && isStale(other.holder)) fs.rmSync(guard, { force: true });
    // Another run is taking it over, or just did: look again.
    return false;
  }
  try {
    const lock = path.join(vaultRoot, LOCK_FILE);
    const now = inspect(lock);
    if (now.kind === 'holder' && now.holder.pid === judged.pid && now.holder.startedAt === judged.startedAt) {
      fs.rmSync(lock, { force: true });
      return true;
    }
    return false;
  } finally {
    try {
      fs.rmSync(guard, { force: true });
    } catch {
      // Left behind, it carries our PID and is judged stale like a lock.
    }
  }
}

type Inspection =
  | { kind: 'none' }
  | { kind: 'holder'; holder: VaultLockInfo }
  /** `empty`: a zero-byte file, the mark of a run killed between create and write. */
  | { kind: 'unreadable'; empty?: boolean };

function inspect(file: string): Inspection {
  let text: string;
  try {
    if (!fs.lstatSync(file).isFile()) return { kind: 'unreadable' };
    text = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    return errnoCode(err) === 'ENOENT' ? { kind: 'none' } : { kind: 'unreadable' };
  }
  if (text.trim() === '') return { kind: 'unreadable', empty: true };
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
    // Not JSON (empty, cut off, or not ours).
  }
  return { kind: 'unreadable' };
}

/**
 * `wx`: create only if absent. 'taken' when the name exists (a file, or a
 * folder). EPERM is returned, not thrown, so the caller can retry: on
 * Windows it is a delete still pending. Other errors throw.
 */
function tryCreate(file: string, info: VaultLockInfo): 'created' | 'taken' | Error {
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'EEXIST' || code === 'EISDIR') return 'taken';
    if (code === 'EPERM') return err as Error;
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
  return 'created';
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

function lockedError(holder: VaultLockInfo | undefined, hostname: string, empty = false): ShardMindError {
  const hint = `Wait for that run to finish, then run again. If no shardmind process is running (it crashed, or the lock was synced or committed into the vault), ${LOCK_FILE} (and ${LOCK_TAKEOVER_FILE}, if present) in the vault folder is safe to delete.`;
  if (empty) {
    return new ShardMindError(
      `An empty ${LOCK_FILE} was left by a crashed run; delete it if no shardmind is running`,
      'VAULT_LOCKED',
      `It is in the vault folder. A run writes its lock in an instant, so an empty one is almost always left over; ${LOCK_TAKEOVER_FILE}, if present, is safe to delete with it.`,
    );
  }
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
