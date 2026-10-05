/**
 * The vault transaction (#301), on its own: what a run records before each
 * write, and what its rollback puts back, removes and keeps.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { beginTransaction } from '../../source/core/vault-transaction.js';

let vault: string;

beforeEach(async () => {
  vault = path.join(os.tmpdir(), `shardmind-vault-tx-${crypto.randomUUID()}`);
  await fsp.mkdir(vault, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(vault, { recursive: true, force: true });
});

const begin = (signal?: AbortSignal) =>
  beginTransaction(vault, { kind: 'adopt', keepAfterRollback: 'on-restore-failure', noPriorInstall: true, signal });
const read = (rel: string) => fsp.readFile(path.join(vault, rel), 'utf-8');
const exists = (abs: string) => fsp.access(abs).then(() => true, () => false);

describe('vault transaction (#301)', () => {
  it('restores a file it snapshotted, removes one it introduced, and cleans .shardmind/', async () => {
    await fsp.writeFile(path.join(vault, 'CLAUDE.md'), 'pristine\n');
    const tx = await begin();
    await tx.recordWrite('CLAUDE.md');
    await fsp.writeFile(path.join(vault, 'CLAUDE.md'), 'overwritten\n');
    await tx.recordWrite('shard-only.md');
    await fsp.writeFile(path.join(vault, 'shard-only.md'), 'fresh write\n');

    expect(await tx.rollback()).toEqual([]);
    expect(await read('CLAUDE.md')).toBe('pristine\n');
    expect(await exists(path.join(vault, 'shard-only.md'))).toBe(false);
    expect(await exists(path.join(vault, '.shardmind'))).toBe(false);
  });

  it('removes the folders a write created, and only those (#258)', async () => {
    await fsp.mkdir(path.join(vault, 'mine'));
    const tx = await begin();
    await tx.recordWrite('deep/er/new.md');
    await tx.recordWrite('mine/new.md');
    await fsp.mkdir(path.join(vault, 'deep', 'er'), { recursive: true });
    await fsp.writeFile(path.join(vault, 'deep', 'er', 'new.md'), 'x');
    await fsp.writeFile(path.join(vault, 'mine', 'new.md'), 'x');

    expect(await tx.rollback()).toEqual([]);
    expect(await exists(path.join(vault, 'deep'))).toBe(false);
    expect(await exists(path.join(vault, 'mine'))).toBe(true);
  });

  it('still removes them when the folder record on disk is unusable, from its own list (#295)', async () => {
    const tx = await begin();
    await tx.recordWrite('deep/new.md');
    await fsp.mkdir(path.join(vault, 'deep'));
    await fsp.writeFile(path.join(tx.dir, 'folders.json'), '{truncated');

    expect(await tx.rollback()).toEqual([]);
    expect(await exists(path.join(vault, 'deep'))).toBe(false);
  });

  it("keeps a file it never recorded, such as the user's own shard-values.yaml (#243)", async () => {
    await fsp.writeFile(path.join(vault, 'shard-values.yaml'), 'user_name: mine\n');
    const tx = await begin();
    expect(await tx.rollback()).toEqual([]);
    expect(await read('shard-values.yaml')).toBe('user_name: mine\n');
  });

  it('leaves a folder at a written path alone: it is not snapshotted or introduced', async () => {
    await fsp.mkdir(path.join(vault, 'Notes.md', 'x'), { recursive: true });
    const tx = await begin();
    await tx.recordWrite('Notes.md');
    expect(tx.introduced).toEqual([]);
    expect(await tx.rollback()).toEqual([]);
    expect(await exists(path.join(vault, 'Notes.md', 'x'))).toBe(true);
  });

  it('keeps the snapshot when restoring from it failed (#243)', async () => {
    await fsp.writeFile(path.join(vault, 'Notes.md'), 'the only copy\n');
    const tx = await begin();
    await tx.recordWrite('Notes.md');
    // A folder where the file must be restored: the copy fails.
    await fsp.rm(path.join(vault, 'Notes.md'));
    await fsp.mkdir(path.join(vault, 'Notes.md', 'blocker'), { recursive: true });

    const failures = await tx.rollback();
    expect(failures.some((f) => f.reason.startsWith('restore failed'))).toBe(true);
    expect(await fsp.readFile(path.join(tx.dir, 'files', 'Notes.md'), 'utf-8')).toBe('the only copy\n');
  });

  it('keeps the snapshot when a folder in it could not be read (#247)', async () => {
    await fsp.mkdir(path.join(vault, 'notes'));
    await fsp.writeFile(path.join(vault, 'notes', 'a.md'), 'the only copy\n');
    const tx = await begin();
    await tx.recordWrite('notes/a.md');
    const notes = path.join(tx.dir, 'files', 'notes');
    const realReaddir = fsp.readdir;
    vi.spyOn(fsp, 'readdir').mockImplementation((async (dir: string, opts: unknown) => {
      if (dir === notes) throw Object.assign(new Error('simulated EMFILE'), { code: 'EMFILE' });
      return (realReaddir as (d: string, o: unknown) => Promise<unknown>)(dir, opts);
    }) as typeof fsp.readdir);

    const failures = await tx.rollback();
    vi.restoreAllMocks();
    expect(failures).toContainEqual(expect.objectContaining({ path: 'notes', reason: 'readdir failed: simulated EMFILE' }));
    expect(await fsp.readFile(path.join(notes, 'a.md'), 'utf-8')).toBe('the only copy\n');
  });

  it('stops before the caller writes when a Ctrl+C lands during its record (#249)', async () => {
    await fsp.writeFile(path.join(vault, 'a.md'), 'x');
    const abort = new AbortController();
    const tx = await begin(abort.signal);
    const copy = fsp.copyFile.bind(fsp);
    vi.spyOn(fsp, 'copyFile').mockImplementation(async (src, dst, mode) => {
      await copy(src, dst, mode);
      abort.abort();
    });
    await expect(tx.recordWrite('a.md')).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('commits the engine metadata with state.json last, after the last cancel check', async () => {
    const abort = new AbortController();
    const tx = await begin(abort.signal);
    const order: string[] = [];
    await expect(
      tx.commitEngineMetadata({
        beforeState: async () => {
          order.push('before');
          abort.abort();
        },
        state: async () => {
          order.push('state');
        },
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(order).toEqual(['before']);
  });
});
