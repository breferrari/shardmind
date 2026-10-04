/**
 * core/vault-lock.ts (#253): one shardmind run per vault.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { acquireVaultLock, isHeldByAnotherRun } from '../../source/core/vault-lock.js';
import { LOCK_FILE } from '../../source/runtime/vault-paths.js';

let vault: string;
const lockPath = () => path.join(vault, LOCK_FILE);
const holder = (info: Record<string, unknown>) => fsp.writeFile(lockPath(), JSON.stringify(info));

beforeEach(async () => {
  vault = path.join(os.tmpdir(), `shardmind-lock-${crypto.randomUUID()}`);
  await fsp.mkdir(vault, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(vault, { recursive: true, force: true });
});

describe('acquireVaultLock (#253)', () => {
  it('creates the lock with the run it belongs to, and release removes it', async () => {
    const lock = acquireVaultLock(vault, 'update');
    const info = JSON.parse(await fsp.readFile(lockPath(), 'utf-8'));
    expect(info).toMatchObject({ pid: process.pid, hostname: os.hostname(), command: 'update' });
    expect(typeof info.startedAt).toBe('string');
    lock.release();
    expect(fs.existsSync(lockPath())).toBe(false);
    lock.release(); // idempotent
  });

  it('refuses a second run while the first holds it, naming the command and PID', () => {
    const first = acquireVaultLock(vault, 'update');
    try {
      let err: unknown;
      try {
        acquireVaultLock(vault, 'install', { pid: process.pid + 1 });
      } catch (e) {
        err = e;
      }
      expect(err).toMatchObject({ code: 'VAULT_LOCKED' });
      expect((err as Error).message).toContain('update');
      expect((err as Error).message).toContain(String(process.pid));
      expect((err as { hint?: string }).hint).toContain('.shardmind.lock');
    } finally {
      first.release();
    }
  });

  it('takes over a stale lock from this host whose process is gone', async () => {
    await holder({ pid: 999999, hostname: os.hostname(), command: 'adopt', startedAt: '2026-01-01T00:00:00.000Z' });
    const lock = acquireVaultLock(vault, 'update', { isAlive: () => false });
    expect(lock.tookOver).toMatchObject({ pid: 999999, command: 'adopt' });
    expect(JSON.parse(await fsp.readFile(lockPath(), 'utf-8')).pid).toBe(process.pid);
    lock.release();
  });

  it('never takes over a lock from another host, whose process cannot be checked here', async () => {
    await holder({ pid: 999999, hostname: 'other-machine', command: 'update', startedAt: '2026-01-01T00:00:00.000Z' });
    expect(() => acquireVaultLock(vault, 'update', { isAlive: () => false })).toThrow(
      expect.objectContaining({ code: 'VAULT_LOCKED', message: expect.stringContaining('other-machine') }),
    );
    expect(fs.existsSync(lockPath())).toBe(true);
  });

  it('refuses, and leaves alone, a lock file it cannot read as a lock', async () => {
    await fsp.writeFile(lockPath(), 'not json');
    expect(() => acquireVaultLock(vault, 'update')).toThrow(expect.objectContaining({ code: 'VAULT_LOCKED' }));
    expect(await fsp.readFile(lockPath(), 'utf-8')).toBe('not json');
  });

  it('refuses a lock path that is a folder', async () => {
    await fsp.mkdir(lockPath());
    expect(() => acquireVaultLock(vault, 'update')).toThrow(expect.objectContaining({ code: 'VAULT_LOCKED' }));
  });

  it('releases only a lock it still holds', async () => {
    const lock = acquireVaultLock(vault, 'update');
    // Another run took over (say, after this one was judged stale).
    await holder({ pid: 4242, hostname: os.hostname(), command: 'install', startedAt: '2026-02-02T00:00:00.000Z' });
    lock.release();
    expect(JSON.parse(await fsp.readFile(lockPath(), 'utf-8')).pid).toBe(4242);
  });

  it('lets exactly one of two racing runs in', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => Promise.resolve().then(() => acquireVaultLock(vault, 'update', { pid: 70_000 + i, isAlive: () => true }))),
    );
    const won = results.filter((r) => r.status === 'fulfilled');
    expect(won).toHaveLength(1);
    (won[0] as PromiseFulfilledResult<{ release(): void }>).value.release();
  });

  it("takes over a lock carrying this process's own PID: a leftover, or a reused PID in a container", async () => {
    await holder({ pid: process.pid, hostname: os.hostname(), command: 'update', startedAt: '2026-01-01T00:00:00.000Z' });
    const lock = acquireVaultLock(vault, 'install');
    expect(lock.tookOver).toMatchObject({ pid: process.pid });
    lock.release();
  });

  it('refuses a lock whose PID is not a positive integer, rather than probing it', async () => {
    for (const pid of [0, -1, 1.5]) {
      await holder({ pid, hostname: os.hostname(), command: 'update', startedAt: '2026-01-01T00:00:00.000Z' });
      expect(() => acquireVaultLock(vault, 'update', { isAlive: () => false })).toThrow(expect.objectContaining({ code: 'VAULT_LOCKED' }));
    }
  });

  it("counts a host's .local name as the same host, as macOS switches between them", async () => {
    await holder({ pid: 999999, hostname: 'Brennos-MBP.local', command: 'update', startedAt: '2026-01-01T00:00:00.000Z' });
    const lock = acquireVaultLock(vault, 'update', { hostname: 'brennos-mbp', isAlive: () => false });
    expect(lock.tookOver).toMatchObject({ pid: 999999 });
    lock.release();
  });

  it('takes over an empty lock left by a run that died while writing it, once it is old', async () => {
    await fsp.writeFile(lockPath(), '');
    const old = new Date(Date.now() - 120_000);
    await fsp.utimes(lockPath(), old, old);
    const lock = acquireVaultLock(vault, 'update');
    expect(JSON.parse(await fsp.readFile(lockPath(), 'utf-8')).pid).toBe(process.pid);
    lock.release();
  });

  it('refuses a fresh empty lock: its run may still be writing it', async () => {
    await fsp.writeFile(lockPath(), '');
    expect(() => acquireVaultLock(vault, 'update')).toThrow(expect.objectContaining({ code: 'VAULT_LOCKED' }));
  });

  it("does not delete a run's fresh lock that replaced the stale one it judged", async () => {
    await holder({ pid: 999999, hostname: os.hostname(), command: 'adopt', startedAt: '2026-01-01T00:00:00.000Z' });
    const fresh = { pid: 4242, hostname: os.hostname(), command: 'install', startedAt: '2026-10-04T12:00:00.000Z' };
    expect(() =>
      acquireVaultLock(vault, 'update', {
        isAlive: (pid) => pid === 4242,
        // Another run takes the stale lock over between our read and our move.
        beforeTakeover: () => fs.writeFileSync(lockPath(), JSON.stringify(fresh)),
      }),
    ).toThrow(expect.objectContaining({ code: 'VAULT_LOCKED', message: expect.stringContaining('PID 4242') }));
    expect(JSON.parse(await fsp.readFile(lockPath(), 'utf-8'))).toEqual(fresh);
    expect((await fsp.readdir(vault)).filter((n) => n !== LOCK_FILE)).toEqual([]);
  });

  it('isHeldByAnotherRun: a live lock of another process, not our own or none', async () => {
    expect(isHeldByAnotherRun(vault)).toBe(false);
    const lock = acquireVaultLock(vault, 'update');
    expect(isHeldByAnotherRun(vault)).toBe(false);
    lock.release();
    await holder({ pid: process.pid + 1, hostname: os.hostname(), command: 'update', startedAt: '2026-01-01T00:00:00.000Z' });
    expect(isHeldByAnotherRun(vault)).toBe(true);
  });

  it('releases on process exit, as a backstop for paths that miss the explicit release', () => {
    acquireVaultLock(vault, 'update');
    expect(fs.existsSync(lockPath())).toBe(true);
    process.emit('exit', 0);
    expect(fs.existsSync(lockPath())).toBe(false);
  });
});
