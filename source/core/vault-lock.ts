/**
 * One shardmind run per vault (#253). See docs/IMPLEMENTATION.md §4.24 and
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
import { LOCK_FILE } from '../runtime/vault-paths.js';

export { LOCK_FILE };

export interface VaultLockInfo {
  pid: number;
  hostname: string;
  command: string;
  startedAt: string;
}

export interface VaultLock {
  /** Remove the lock if this run still holds it. Idempotent. */
  release(): void;
  /** Set when a stale lock from this host, whose process was gone, was taken over. */
  tookOver?: VaultLockInfo;
}

export function acquireVaultLock(
  vaultRoot: string,
  command: 'install' | 'update' | 'adopt',
  deps: { pid?: number; hostname?: string; isAlive?: (pid: number) => boolean; now?: () => Date } = {},
): VaultLock {
  const file = path.join(vaultRoot, LOCK_FILE);
  const mine: VaultLockInfo = {
    pid: deps.pid ?? process.pid,
    hostname: deps.hostname ?? os.hostname(),
    command,
    startedAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
  const isAlive = deps.isAlive ?? processIsAlive;

  let tookOver: VaultLockInfo | undefined;
  if (!tryCreate(file, mine)) {
    const holder = readHolder(file);
    const stale = holder !== undefined && holder.hostname === mine.hostname && !isAlive(holder.pid);
    if (!stale) throw lockedError(holder, mine.hostname);
    try {
      fs.rmSync(file);
    } catch (err) {
      if (errnoCode(err) !== 'ENOENT') throw lockedError(holder, mine.hostname);
    }
    // Another run may take it in between; then it holds it, and we say so.
    if (!tryCreate(file, mine)) throw lockedError(readHolder(file), mine.hostname);
    tookOver = holder;
  }

  const release = (): void => {
    process.removeListener('exit', release);
    const current = readHolder(file);
    if (current && current.pid === mine.pid && current.startedAt === mine.startedAt) {
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

/** `wx`: create only if absent. False when the file exists; other errors throw. */
function tryCreate(file: string, info: VaultLockInfo): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (err) {
    if (errnoCode(err) === 'EEXIST' || errnoCode(err) === 'EISDIR' || errnoCode(err) === 'EPERM') return false;
    throw err;
  }
  try {
    fs.writeSync(fd, `${JSON.stringify(info)}\n`);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/** The holder, or undefined when the path is not a lock this engine wrote (a folder, a symlink, other bytes). */
function readHolder(file: string): VaultLockInfo | undefined {
  try {
    if (!fs.lstatSync(file).isFile()) return undefined;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<VaultLockInfo>;
    if (
      typeof parsed.pid !== 'number' ||
      typeof parsed.hostname !== 'string' ||
      typeof parsed.command !== 'string' ||
      typeof parsed.startedAt !== 'string'
    ) {
      return undefined;
    }
    return parsed as VaultLockInfo;
  } catch {
    return undefined;
  }
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
  const hint =
    `Wait for that run to finish, then run again. If no shardmind process is running (it crashed, or the lock was synced or committed into the vault), ${LOCK_FILE} in the vault folder is safe to delete.`;
  if (!holder) {
    return new ShardMindError(`The vault is locked by ${LOCK_FILE}, which could not be read as a shardmind lock`, 'VAULT_LOCKED', hint);
  }
  const where = holder.hostname === hostname ? '' : ` on ${holder.hostname}`;
  return new ShardMindError(
    `Another shardmind run is working on this vault: ${holder.command} (PID ${holder.pid}${where}, started ${holder.startedAt})`,
    'VAULT_LOCKED',
    hint,
  );
}
