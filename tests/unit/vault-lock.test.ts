/**
 * core/vault-lock.ts (#253): one shardmind run per vault.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { acquireVaultLock } from '../../source/core/vault-lock.js';
import { LOCK_FILE, LOCK_TAKEOVER_FILE } from '../../source/runtime/vault-paths.js';

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

  it("takes over a lock with this process's PID from before it started: a reused PID's leftover", async () => {
    await holder({ pid: process.pid, hostname: os.hostname(), command: 'update', startedAt: '2026-01-01T00:00:00.000Z' });
    const lock = acquireVaultLock(vault, 'install', { processStartedAt: Date.parse('2026-06-01T00:00:00.000Z') });
    expect(lock.tookOver).toMatchObject({ pid: process.pid });
    lock.release();
  });

  it("refuses a lock with this process's PID from after it started: another live run with the same PID (a container)", async () => {
    await holder({ pid: process.pid, hostname: os.hostname(), command: 'update', startedAt: '2026-10-04T12:00:00.000Z' });
    expect(() => acquireVaultLock(vault, 'install', { processStartedAt: Date.parse('2026-10-04T11:00:00.000Z') })).toThrow(
      expect.objectContaining({ code: 'VAULT_LOCKED' }),
    );
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

  it('refuses an empty lock, whatever its age: it may be a run still writing it, and it says the file is safe to delete', async () => {
    await fsp.writeFile(lockPath(), '');
    const old = new Date(Date.now() - 3_600_000);
    await fsp.utimes(lockPath(), old, old);
    let err: unknown;
    try {
      acquireVaultLock(vault, 'update');
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: 'VAULT_LOCKED' });
    expect((err as { hint?: string }).hint).toMatch(/safe to delete/);
    expect(await fsp.readFile(lockPath(), 'utf-8')).toBe('');
  });

  it('takes over a stale lock only while holding the takeover guard, and never a run that holds it', async () => {
    await holder({ pid: 999999, hostname: os.hostname(), command: 'adopt', startedAt: '2026-01-01T00:00:00.000Z' });
    // Another run is mid-takeover.
    await fsp.writeFile(path.join(vault, LOCK_TAKEOVER_FILE), JSON.stringify({ pid: 4242, hostname: os.hostname(), command: 'install', startedAt: '2026-10-04T12:00:00.000Z' }));
    expect(() => acquireVaultLock(vault, 'update', { isAlive: (pid) => pid === 4242 })).toThrow(
      expect.objectContaining({ code: 'VAULT_LOCKED', message: expect.stringContaining('kept changing') }),
    );
    // The stale lock is left to the run that holds the guard.
    expect(JSON.parse(await fsp.readFile(lockPath(), 'utf-8')).pid).toBe(999999);
  });

  it('clears a takeover guard left by a run that died mid-takeover, then takes the stale lock over', async () => {
    await holder({ pid: 999999, hostname: os.hostname(), command: 'adopt', startedAt: '2026-01-01T00:00:00.000Z' });
    await fsp.writeFile(path.join(vault, LOCK_TAKEOVER_FILE), JSON.stringify({ pid: 999998, hostname: os.hostname(), command: 'install', startedAt: '2026-01-01T00:00:00.000Z' }));
    const lock = acquireVaultLock(vault, 'update', { isAlive: () => false });
    expect(lock.tookOver).toMatchObject({ pid: 999999 });
    expect(fs.existsSync(path.join(vault, LOCK_TAKEOVER_FILE))).toBe(false);
    lock.release();
  });

  it('leaves no takeover guard behind after a takeover', async () => {
    await holder({ pid: 999999, hostname: os.hostname(), command: 'adopt', startedAt: '2026-01-01T00:00:00.000Z' });
    const lock = acquireVaultLock(vault, 'update', { isAlive: () => false });
    expect(fs.existsSync(path.join(vault, LOCK_TAKEOVER_FILE))).toBe(false);
    lock.release();
  });

  it('creates again when the holder releases between the create and the look', async () => {
    // A lock that vanishes when read the first time: the holder released.
    let reads = 0;
    const realLstat = fs.lstatSync;
    const spy = (await import('vitest')).vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p) === lockPath() && reads++ === 0) {
        fs.rmSync(lockPath(), { force: true });
      }
      return (realLstat as (...a: unknown[]) => fs.Stats)(p, ...rest);
    }) as typeof fs.lstatSync);
    try {
      await holder({ pid: 4242, hostname: os.hostname(), command: 'install', startedAt: '2026-10-04T12:00:00.000Z' });
      const lock = acquireVaultLock(vault, 'update', { isAlive: () => true });
      expect(JSON.parse(await fsp.readFile(lockPath(), 'utf-8')).pid).toBe(process.pid);
      lock.release();
    } finally {
      spy.mockRestore();
    }
  });

  it('releases on process exit, as a backstop for paths that miss the explicit release', () => {
    acquireVaultLock(vault, 'update');
    expect(fs.existsSync(lockPath())).toBe(true);
    process.emit('exit', 0);
    expect(fs.existsSync(lockPath())).toBe(false);
  });
});
