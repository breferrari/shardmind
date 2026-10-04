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

  let tookOver: VaultLockInfo | undefined;
  // A holder can release between our create and our look: then create again.
  for (let attempt = 0; ; attempt++) {
    if (tryCreate(file, mine)) break;
    const found = inspect(file);
    if (found.kind === 'none' && attempt < 3) continue;
    if (found.kind !== 'holder') throw lockedError(undefined, mine.hostname);
    const { holder } = found;
    const stale =
      sameHost(holder.hostname, mine.hostname) &&
      (holder.pid === mine.pid ? Date.parse(holder.startedAt) < startedAt : !isAlive(holder.pid));
    if (!stale || attempt >= 3) throw lockedError(holder, mine.hostname);
    removeStale(vaultRoot, holder, mine);
    tookOver = holder;
  }

  const release = (): void => {
    held.delete(release);
    const current = inspect(file);
    if (current.kind === 'holder' && current.holder.pid === mine.pid && current.holder.startedAt === mine.startedAt) {
      fs.rmSync(file, { force: true });
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
 * still names the holder it judged. A live lock is never moved.
 */
function removeStale(vaultRoot: string, judged: VaultLockInfo, mine: VaultLockInfo): void {
  const guard = path.join(vaultRoot, LOCK_TAKEOVER_FILE);
  if (!tryCreate(guard, mine)) throw lockedError(judged, mine.hostname);
  try {
    const now = inspect(path.join(vaultRoot, LOCK_FILE));
    if (now.kind === 'holder' && now.holder.pid === judged.pid && now.holder.startedAt === judged.startedAt) {
      fs.rmSync(path.join(vaultRoot, LOCK_FILE), { force: true });
    }
  } finally {
    fs.rmSync(guard, { force: true });
  }
}

type Inspection = { kind: 'none' } | { kind: 'holder'; holder: VaultLockInfo } | { kind: 'unreadable' };

function inspect(file: string): Inspection {
  let text: string;
  try {
    if (!fs.lstatSync(file).isFile()) return { kind: 'unreadable' };
    text = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    return errnoCode(err) === 'ENOENT' ? { kind: 'none' } : { kind: 'unreadable' };
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
    // Not JSON (empty, cut off, or not ours).
  }
  return { kind: 'unreadable' };
}

/** `wx`: create only if absent. False when the name is taken (a file, or a folder); other errors throw. */
function tryCreate(file: string, info: VaultLockInfo): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'EEXIST' || code === 'EISDIR') return false;
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
  const hint = `Wait for that run to finish, then run again. If no shardmind process is running (it crashed, or the lock was synced or committed into the vault), ${LOCK_FILE} (and ${LOCK_TAKEOVER_FILE}, if present) in the vault folder is safe to delete.`;
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
