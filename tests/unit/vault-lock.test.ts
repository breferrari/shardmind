/**
 * core/vault-lock.ts (#253): one shardmind run per vault.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { acquireVaultLock, LOCK_FILE } from '../../source/core/vault-lock.js';

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
        acquireVaultLock(vault, 'install');
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
      Array.from({ length: 8 }, () => Promise.resolve().then(() => acquireVaultLock(vault, 'update'))),
    );
    const won = results.filter((r) => r.status === 'fulfilled');
    expect(won).toHaveLength(1);
    (won[0] as PromiseFulfilledResult<{ release(): void }>).value.release();
  });

  it('releases on process exit, as a backstop for paths that miss the explicit release', () => {
    acquireVaultLock(vault, 'update');
    expect(fs.existsSync(lockPath())).toBe(true);
    process.emit('exit', 0);
    expect(fs.existsSync(lockPath())).toBe(false);
  });
});
