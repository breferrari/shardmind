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
import { acquireVaultLock } from '../../source/core/vault-lock.js';
import { renameCaseInPlace } from '../../source/core/rename-migrations.js';
import { asShown } from '../helpers/index.js';

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

describe('vault transaction for install (#301)', () => {
  const beginInstall = (signal?: AbortSignal) =>
    beginTransaction(vault, { kind: 'install', noPriorInstall: true, signal, now: new Date('2026-10-05T12:00:00Z') });
  const at = (rel: string) => path.join(vault, rel);

  it('has no snapshot folder and makes nothing under .shardmind/', async () => {
    const tx = await beginInstall();
    expect(tx.dir).toBeNull();
    expect(await exists(at('.shardmind'))).toBe(false);
  });

  it('with no snapshot, will not record over an existing file (install refuses one first, §4.11b)', async () => {
    const tx = await beginInstall();
    await fsp.writeFile(at('Home.md'), 'arrived after planning\n');
    await expect(tx.recordWrite('Home.md')).rejects.toThrow('Home.md exists, and this transaction has no snapshot to keep it in');
    expect(await tx.rollback()).toEqual([]);
    expect(await read('Home.md')).toBe('arrived after planning\n');
  });

  it('moves a path aside under a backup name, and the rollback moves it back', async () => {
    await fsp.mkdir(at('brain'));
    await fsp.writeFile(at('brain/Note.md'), 'mine\n');
    await fsp.writeFile(at('Home.md'), 'my home\n');
    const tx = await beginInstall();
    const folder = await tx.recordSetAside(at('brain'), false);
    const file = await tx.recordSetAside(at('Home.md'), true);
    expect(folder.backupPath).toBe(`${at('brain')}.shardmind-backup-2026-10-05T12-00-00`);
    expect(await exists(at('Home.md'))).toBe(false);
    // The install writes at both paths.
    await tx.recordWrite('Home.md');
    await fsp.writeFile(at('Home.md'), 'shard home\n');
    await tx.recordWrite('brain/Note.md');
    await fsp.mkdir(at('brain'));
    await fsp.writeFile(at('brain/Note.md'), 'shard note\n');

    expect(await tx.rollback()).toEqual([]);
    expect(await read('Home.md')).toBe('my home\n');
    expect(await read('brain/Note.md')).toBe('mine\n');
    expect((await fsp.readdir(vault)).sort()).toEqual(['Home.md', 'brain']);
    expect(file.backupPath).toContain('.shardmind-backup-');
  });

  it('takes the next free backup name', async () => {
    await fsp.writeFile(at('Home.md'), 'mine\n');
    await fsp.writeFile(at('Home.md.shardmind-backup-2026-10-05T12-00-00'), 'an older backup\n');
    const tx = await beginInstall();
    const moved = await tx.recordSetAside(at('Home.md'), true);
    expect(moved.backupPath).toBe(`${at('Home.md')}.shardmind-backup-2026-10-05T12-00-00.1`);
  });

  it('a failed move is BACKUP_FAILED, and the rollback puts the earlier moves back (#209)', async () => {
    await fsp.writeFile(at('a.md'), 'a\n');
    await fsp.writeFile(at('b.md'), 'b\n');
    const tx = await beginInstall();
    await tx.recordSetAside(at('a.md'), false);
    const realRename = fsp.rename;
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (from === at('b.md')) throw Object.assign(new Error('simulated EPERM'), { code: 'EPERM' });
      return realRename(from, to);
    });
    await expect(tx.recordSetAside(at('b.md'), false)).rejects.toMatchObject({ code: 'BACKUP_FAILED' });
    vi.restoreAllMocks();
    expect(await tx.rollback()).toEqual([]);
    expect((await fsp.readdir(vault)).sort()).toEqual(['a.md', 'b.md']);
  });

  it('no free backup name is BACKUP_FAILED, and the rollback puts the earlier moves back (#209)', async () => {
    await fsp.writeFile(at('a.md'), 'a');
    await fsp.writeFile(at('b.md'), 'b');
    const tx = await beginInstall();
    await tx.recordSetAside(at('a.md'), false);
    const realAccess = fsp.access;
    vi.spyOn(fsp, 'access').mockImplementation(async (p, mode) => {
      // Every name for b.md is taken.
      if (String(p).startsWith(`${at('b.md')}.shardmind-backup-`)) return;
      return realAccess(p, mode);
    });
    await expect(tx.recordSetAside(at('b.md'), false)).rejects.toMatchObject({ code: 'BACKUP_FAILED' });
    vi.restoreAllMocks();
    expect(await tx.rollback()).toEqual([]);
    expect((await fsp.readdir(vault)).sort()).toEqual(['a.md', 'b.md']);
  });

  it('a full disk while moving a path aside is BACKUP_FAILED with the disk-full hint (#225, #301)', async () => {
    await fsp.writeFile(at('Home.md'), 'mine\n');
    const tx = await beginInstall();
    const realRename = fsp.rename;
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (from === at('Home.md')) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return realRename(from, to);
    });
    const err = await tx.recordSetAside(at('Home.md'), true).catch((e: unknown) => e);
    vi.restoreAllMocks();
    const { shown, errnos } = asShown(err);
    expect(shown).toMatchObject({ kind: 'known', code: 'BACKUP_FAILED' });
    expect(shown.kind === 'known' ? shown.hint : '').toMatch(/The disk is full/);
    expect(errnos).toContain('ENOSPC');
    expect(await read('Home.md')).toBe('mine\n');
  });

  it('a set-aside that cannot be moved back is reported with where it still is', async () => {
    await fsp.writeFile(at('Home.md'), 'mine\n');
    const tx = await beginInstall();
    const moved = await tx.recordSetAside(at('Home.md'), false);
    const realRename = fsp.rename;
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (from === moved.backupPath) throw Object.assign(new Error('simulated EBUSY'), { code: 'EBUSY' });
      return realRename(from, to);
    });
    const failures = await tx.rollback();
    vi.restoreAllMocks();
    expect(failures).toEqual([{ path: 'Home.md', reason: 'restore failed: simulated EBUSY', backup: moved.backupPath }]);
    expect(await fsp.readFile(moved.backupPath, 'utf-8')).toBe('mine\n');
  });

  it('commit discards what was set aside and keeps the backups, carrying the old .shardmind/ over (#55, #237)', async () => {
    await fsp.mkdir(at('.shardmind/backups/update-old'), { recursive: true });
    await fsp.writeFile(at('.shardmind/state.json'), '{"old":true}');
    await fsp.writeFile(at('.shardmind/boundary-ignore'), 'mine\n');
    await fsp.writeFile(at('.shardmind/backups/update-old/x.md'), 'only copy\n');
    await fsp.writeFile(at('Stale.md'), 'stale\n');
    await fsp.writeFile(at('Own.md'), 'own\n');
    const tx = await beginInstall();
    const oldState = await tx.recordSetAside(at('.shardmind'), false);
    await tx.recordSetAside(at('Stale.md'), false);
    const own = await tx.recordSetAside(at('Own.md'), true);
    await tx.commitEngineMetadata({
      beforeState: async () => {
        await fsp.mkdir(at('.shardmind'), { recursive: true });
      },
      state: () => fsp.writeFile(at('.shardmind/state.json'), '{"new":true}'),
    });
    const { kept, left } = await tx.commit({ oldStatePath: oldState.originalPath });
    expect(kept).toEqual([own]);
    expect(left).toEqual([]);
    expect(await exists(oldState.backupPath)).toBe(false);
    expect(await exists(at('Stale.md'))).toBe(false);
    expect(await read('.shardmind/boundary-ignore')).toBe('mine\n');
    expect(await read('.shardmind/backups/update-old/x.md')).toBe('only copy\n');
    expect(await read('.shardmind/state.json')).toBe('{"new":true}');
  });

  it('before its engine commit, a rollback leaves the engine entries already there alone', async () => {
    await fsp.mkdir(at('.shardmind'));
    await fsp.writeFile(at('.shardmind/shard.yaml'), 'a clone\'s own\n');
    const tx = await beginInstall();
    await tx.recordWrite('Home.md');
    await fsp.writeFile(at('Home.md'), 'shard home\n');
    expect(await tx.rollback()).toEqual([]);
    expect(await read('.shardmind/shard.yaml')).toBe('a clone\'s own\n');
    expect(await exists(at('Home.md'))).toBe(false);
  });

  it('during its engine commit, the entries already there are set aside and come back on rollback', async () => {
    await fsp.mkdir(at('.shardmind/templates'), { recursive: true });
    await fsp.writeFile(at('.shardmind/shard.yaml'), 'a clone\'s own\n');
    await fsp.writeFile(at('.shardmind/templates/t.md'), 'theirs\n');
    const tx = await beginInstall();
    await expect(
      tx.commitEngineMetadata({
        beforeState: async () => {
          await fsp.mkdir(at('.shardmind/templates'), { recursive: true });
          await fsp.writeFile(at('.shardmind/shard.yaml'), 'the engine cache\n');
          throw new Error('disk full');
        },
        state: async () => {},
      }),
    ).rejects.toThrow('disk full');
    expect(await tx.rollback()).toEqual([]);
    expect(await read('.shardmind/shard.yaml')).toBe('a clone\'s own\n');
    expect(await read('.shardmind/templates/t.md')).toBe('theirs\n');
    expect((await fsp.readdir(at('.shardmind'))).sort()).toEqual(['shard.yaml', 'templates']);
  });

  it('a rollback removes a .shardmind/ the engine commit made, once empty', async () => {
    const tx = await beginInstall();
    await expect(
      tx.commitEngineMetadata({
        beforeState: async () => {
          await fsp.mkdir(at('.shardmind/templates'), { recursive: true });
          throw new Error('disk full');
        },
        state: async () => {},
      }),
    ).rejects.toThrow('disk full');
    expect(await tx.rollback()).toEqual([]);
    expect(await exists(at('.shardmind'))).toBe(false);
  });

  it("a rollback that did nothing leaves the user's empty .shardmind/ there", async () => {
    await fsp.mkdir(at('.shardmind'));
    const tx = await beginInstall();
    expect(await tx.rollback()).toEqual([]);
    expect(await exists(at('.shardmind'))).toBe(true);
  });

  it('a Ctrl+C before a move stops it, and nothing is moved', async () => {
    await fsp.writeFile(at('Home.md'), 'mine\n');
    const abort = new AbortController();
    abort.abort();
    const tx = await beginInstall(abort.signal);
    await expect(tx.recordSetAside(at('Home.md'), false)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(await read('Home.md')).toBe('mine\n');
    expect(await tx.rollback()).toEqual([]);
  });
});

describe('vault transaction for an install into a folder it creates (#333)', () => {
  // `vault` is the cwd here: the install's vault is a folder inside it.
  const lockOf = (root: string) => path.join(root, '.shardmind.lock');
  const beginInto = (folders: string[], root = folders[folders.length - 1]!) =>
    beginTransaction(root, {
      kind: 'install',
      noPriorInstall: true,
      createRoot: { folders, lock: () => acquireVaultLock(root, 'install') },
    });

  it('makes the folder and takes its lock; commit keeps the folder and leaves the lock to the caller', async () => {
    const root = path.join(vault, 'wiki-mind');
    const tx = await beginInto([root]);
    expect(await exists(lockOf(root))).toBe(true);
    await tx.recordWrite('Home.md');
    await fsp.writeFile(path.join(root, 'Home.md'), '# Home\n');
    await tx.commit();
    expect(await exists(lockOf(root))).toBe(true);
    expect(await fsp.readFile(path.join(root, 'Home.md'), 'utf-8')).toBe('# Home\n');
  });

  it('the rollback removes what the run wrote, the lock and every level it made', async () => {
    const levels = [path.join(vault, 'a'), path.join(vault, 'a', 'b'), path.join(vault, 'a', 'b', 'c')];
    const root = levels[2]!;
    const tx = await beginInto(levels);
    await tx.recordWrite('brain/Note.md');
    await fsp.mkdir(path.join(root, 'brain'));
    await fsp.writeFile(path.join(root, 'brain', 'Note.md'), 'x');
    expect(await tx.rollback()).toEqual([]);
    expect(await exists(levels[0]!)).toBe(false);
    expect(await fsp.readdir(vault)).toEqual([]);
  });

  it('a file something else put in the folder during the run keeps it, named as a failure', async () => {
    const root = path.join(vault, 'wiki-mind');
    const tx = await beginInto([root]);
    await fsp.writeFile(path.join(root, 'theirs.md'), 'not the run’s');
    const failures = await tx.rollback();
    expect(failures).toEqual([expect.objectContaining({ path: root, reason: expect.stringMatching(/^remove failed:/) })]);
    expect(await fsp.readFile(path.join(root, 'theirs.md'), 'utf-8')).toBe('not the run’s');
    expect(await exists(lockOf(root))).toBe(false);
  });

  it('a folder that appeared after planning is refused before anything is written, and left alone', async () => {
    const root = path.join(vault, 'wiki-mind');
    await fsp.mkdir(root);
    await fsp.writeFile(path.join(root, 'theirs.md'), 'x');
    await expect(beginInto([root])).rejects.toMatchObject({ code: 'INSTALL_DESTINATION_NOT_EMPTY' });
    expect(await fsp.readdir(root)).toEqual(['theirs.md']);
  });

  it('a refused vault folder removes the parent levels this begin made, once empty: one holding what is in the way stays', async () => {
    const levels = [path.join(vault, 'a'), path.join(vault, 'a', 'b')];
    // The vault folder's path is taken by a file once the parent exists.
    const realMkdir = fsp.mkdir.bind(fsp);
    vi.spyOn(fsp, 'mkdir').mockImplementation((async (p: string, opts?: unknown) => {
      if (p === levels[1]) {
        await fsp.writeFile(levels[1]!, 'x');
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      }
      return realMkdir(p, opts as undefined);
    }) as typeof fsp.mkdir);
    await expect(beginInto(levels)).rejects.toMatchObject({ code: 'INSTALL_DESTINATION_NOT_EMPTY' });
    vi.restoreAllMocks();
    expect(await fsp.readdir(path.join(vault, 'a'))).toEqual(['b']);
    expect((await fsp.lstat(path.join(vault, 'a', 'b'))).isFile()).toBe(true);
  });

  it('a parent level that exists, from before or made meanwhile by another run, is used and never removed', async () => {
    const levels = [path.join(vault, 'a'), path.join(vault, 'a', 'b')];
    await fsp.mkdir(levels[0]!);
    const tx = await beginInto(levels);
    expect(await tx.rollback()).toEqual([]);
    expect(await exists(levels[0]!)).toBe(true);
    expect(await exists(levels[1]!)).toBe(false);
  });
});
