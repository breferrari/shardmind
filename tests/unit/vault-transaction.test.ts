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
import { renameCaseInPlace } from '../../source/core/rename-migrations.js';

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
  beginTransaction(vault, { kind: 'adopt', noPriorInstall: true, signal });
/** As update begins one: an install before it, the snapshot always kept. */
const beginUpdate = () => beginTransaction(vault, { kind: 'update', noPriorInstall: false });
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

describe('vault transaction over a prior install (update, #301)', () => {
  const engine = (rel: string) => path.join(vault, '.shardmind', rel);
  async function installed(): Promise<void> {
    await fsp.mkdir(engine('templates/brain'), { recursive: true });
    await fsp.writeFile(engine('state.json'), '{"v":1}');
    await fsp.writeFile(engine('shard.yaml'), 'version: 0.1.0\n');
    await fsp.writeFile(engine('shard-schema.yaml'), 'schema: 1\n');
    await fsp.writeFile(engine('templates/Home.md'), 'old home\n');
    await fsp.writeFile(engine('templates/brain/a.md'), 'old a\n');
    await fsp.writeFile(path.join(vault, 'shard-values.yaml'), 'user_name: Alice\n');
  }
  const tree = (dir: string) => fsp.readdir(dir, { recursive: true }).then((n) => n.map(String).sort());

  it('restores the engine cache, and the template cache exactly (#264)', async () => {
    await installed();
    const before = await tree(engine('templates'));
    const tx = await beginUpdate();
    await fsp.writeFile(engine('state.json'), '{"v":2}');
    await fsp.writeFile(path.join(vault, 'shard-values.yaml'), 'user_name: Bob\n');
    await fsp.writeFile(engine('templates/Added.md'), 'new\n');
    await fsp.rm(engine('templates/brain/a.md'));
    expect(await tx.rollback()).toEqual([]);
    expect(await fsp.readFile(engine('state.json'), 'utf-8')).toBe('{"v":1}');
    expect(await read('shard-values.yaml')).toBe('user_name: Alice\n');
    expect(await tree(engine('templates'))).toEqual(before);
    // Update keeps its snapshot: the summary points at it.
    expect(await exists(tx.dir)).toBe(true);
  });

  it('removes a template cache there was none of before (#264)', async () => {
    await installed();
    await fsp.rm(engine('templates'), { recursive: true });
    const tx = await beginUpdate();
    await fsp.mkdir(engine('templates'));
    await fsp.writeFile(engine('templates/New.md'), 'new\n');
    expect(await tx.rollback()).toEqual([]);
    expect(await exists(engine('templates'))).toBe(false);
  });

  it('copies the cache over when the marker is missing, a snapshot cut short (#264)', async () => {
    await installed();
    const tx = await beginUpdate();
    await fsp.rm(path.join(tx.dir, 'templates-snapshot.json'));
    await fsp.writeFile(engine('templates/Added.md'), 'new\n');
    expect(await tx.rollback()).toEqual([]);
    expect(await exists(engine('templates/Added.md'))).toBe(true);
  });

  it.each([
    ['a folder', (marker: string) => fsp.mkdir(marker)],
    ['not JSON', (marker: string) => fsp.writeFile(marker, '{"existed": tr')],
    ['not { existed: boolean }', (marker: string) => fsp.writeFile(marker, '{"existed": "yes"}')],
  ])('names the template cache when its marker is %s (#294)', async (_name, make) => {
    await installed();
    const tx = await beginUpdate();
    const marker = path.join(tx.dir, 'templates-snapshot.json');
    await fsp.rm(marker);
    await make(marker);
    expect(await tx.rollback()).toEqual([
      {
        path: '.shardmind/templates',
        reason: expect.stringMatching(/^templates marker unreadable: /),
        backup: path.join(tx.dir, 'cache', '.shardmind', 'templates'),
      },
    ]);
  });

  it('can run twice with the same result', async () => {
    await installed();
    await fsp.writeFile(path.join(vault, 'note.md'), 'original\n');
    const tx = await beginUpdate();
    await tx.recordWrite('note.md');
    await fsp.writeFile(path.join(vault, 'note.md'), 'mid-update\n');
    expect(await tx.rollback()).toEqual([]);
    expect(await tx.rollback()).toEqual([]);
    expect(await read('note.md')).toBe('original\n');
  });

  it('a move: the old file snapshotted, the new path introduced (#178)', async () => {
    await installed();
    await fsp.writeFile(path.join(vault, 'Old.md'), 'mine\n');
    const tx = await beginUpdate();
    await tx.recordMove('Old.md', 'sub/New.md');
    expect(tx.introduced).toEqual(['sub/New.md']);
    await fsp.mkdir(path.join(vault, 'sub'));
    await fsp.rename(path.join(vault, 'Old.md'), path.join(vault, 'sub', 'New.md'));
    expect(await tx.rollback()).toEqual([]);
    expect(await read('Old.md')).toBe('mine\n');
    expect(await exists(path.join(vault, 'sub'))).toBe(false);
  });

  it('a case-only move of one file is snapshotted once, and rolls back to the old spelling (#169)', async () => {
    await installed();
    await fsp.writeFile(path.join(vault, 'Note.md'), 'mine\n');
    const caseFolding = await exists(path.join(vault, 'note.md'));
    const tx = await beginUpdate();
    await tx.recordMove('Note.md', 'note.md');
    expect(tx.introduced).toEqual(['note.md']);
    expect(await fsp.readdir(path.join(tx.dir, 'files'))).toEqual(['Note.md']);
    await fsp.rename(path.join(vault, 'Note.md'), path.join(vault, 'note.md'));
    await fsp.writeFile(path.join(vault, 'note.md'), 'new render\n');
    expect(await tx.rollback()).toEqual([]);
    const names = await fsp.readdir(vault);
    expect(names).toContain('Note.md');
    if (caseFolding) expect(names).not.toContain('note.md');
    expect(await read('Note.md')).toBe('mine\n');
  });

  it('recordFolder: a folder a case rename creates goes on rollback (#195)', async () => {
    await installed();
    const tx = await beginUpdate();
    await tx.recordFolder('New/Deep');
    await fsp.mkdir(path.join(vault, 'New', 'Deep'), { recursive: true });
    expect(await tx.rollback()).toEqual([]);
    expect(await exists(path.join(vault, 'New'))).toBe(false);
  });

  it('undoes a journaled case hop (#169)', async () => {
    await installed();
    await fsp.mkdir(path.join(vault, 'Brain'));
    await fsp.writeFile(path.join(vault, 'Brain', 'a.md'), 'a\n');
    const caseFolding = await exists(path.join(vault, 'brain'));
    const tx = await beginUpdate();
    if (caseFolding) expect(await renameCaseInPlace(vault, 'Brain', 'brain', null, tx.journal)).toBe(true);
    expect(await tx.rollback()).toEqual([]);
    expect(await fsp.readdir(vault)).toContain('Brain');
  });
});
