import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import type { PathLike } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  missingFolders,
  recordCreatedFolders,
  readCreatedFolders,
  removeCreatedFolders,
  rollbackCreatedFolders,
} from '../../source/core/created-folders.js';

describe('created folders (#258)', () => {
  let vault: string;
  beforeEach(async () => {
    vault = await fsp.mkdtemp(path.join(os.tmpdir(), 'created-folders-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fsp.rm(vault, { recursive: true, force: true });
  });

  it('lists the folders on the way to each path that do not exist, shallowest first', async () => {
    await fsp.mkdir(path.join(vault, 'brain'));
    const missing = await missingFolders(vault, ['brain/notes/a.md', 'people/team/b.md', 'Home.md', 'people/c.md']);
    expect(missing).toEqual(['brain/notes', 'people', 'people/team']);
  });

  it('adds whole folders when asked, and accepts either separator', async () => {
    expect(await missingFolders(vault, ['x\\y.md'], { folders: ['Renamed/Sub'] })).toEqual(['Renamed', 'Renamed/Sub', 'x']);
  });

  it("counts only ENOENT as missing: a folder it cannot read is not the run's", async () => {
    const realLstat = fsp.lstat;
    vi.spyOn(fsp, 'lstat').mockImplementation((async (p: string) => {
      if (p === path.join(vault, 'locked')) throw Object.assign(new Error('simulated EACCES'), { code: 'EACCES' });
      return (realLstat as (p: string) => Promise<unknown>)(p);
    }) as typeof fsp.lstat);
    expect(await missingFolders(vault, ['locked/a.md', 'open/b.md'])).toEqual(['open']);
  });

  it('round-trips the record through the snapshot folder', async () => {
    await recordCreatedFolders(vault, ['a', 'a/b']);
    expect(await readCreatedFolders(vault)).toEqual(['a', 'a/b']);
  });

  it('reads no record as none, and an unreadable one as a failure', async () => {
    expect(await readCreatedFolders(vault)).toEqual([]);
    await fsp.writeFile(path.join(vault, 'folders.json'), '{not json');
    await expect(readCreatedFolders(vault)).rejects.toThrow();
  });

  it('removes the created folders that are empty, deepest first, and keeps a non-empty one', async () => {
    await fsp.mkdir(path.join(vault, 'a', 'b', 'c'), { recursive: true });
    await fsp.mkdir(path.join(vault, 'keep'), { recursive: true });
    await fsp.writeFile(path.join(vault, 'keep', 'mine.md'), 'user file');
    const failures = await removeCreatedFolders(vault, ['a', 'a/b', 'a/b/c', 'keep', 'gone']);
    expect(failures).toEqual([]);
    expect(await fsp.readdir(vault)).toEqual(['keep']);
  });

  it('returns a folder it could not remove for another reason', async () => {
    await fsp.mkdir(path.join(vault, 'busy'));
    const realRmdir = fsp.rmdir;
    vi.spyOn(fsp, 'rmdir').mockImplementation(async (p: PathLike) => {
      if (p === path.join(vault, 'busy')) throw Object.assign(new Error('simulated EBUSY'), { code: 'EBUSY' });
      return realRmdir(p);
    });
    const failures = await removeCreatedFolders(vault, ['busy']);
    expect(failures).toEqual([{ path: 'busy', reason: 'remove failed: simulated EBUSY' }]);
  });

  it('never records or removes a path that would leave the vault', async () => {
    expect(await missingFolders(vault, ['a/../x.md', '../out/y.md', path.join(vault, 'abs', 'z.md')])).toEqual([]);
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'created-outside-'));
    const empty = path.join(outside, 'empty');
    await fsp.mkdir(empty);
    try {
      expect(await removeCreatedFolders(vault, [path.relative(vault, empty), empty, 'a/..'])).toEqual([]);
      expect((await fsp.stat(empty)).isDirectory()).toBe(true);
      expect((await fsp.stat(vault)).isDirectory()).toBe(true);
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  it('with a shared memo, reports a folder once and keeps a folder that existed at first sight as existing', async () => {
    await fsp.mkdir(path.join(vault, 'kept'));
    const seen = new Map<string, boolean>();
    expect(await missingFolders(vault, ['made/a.md', 'kept/a.md'], { seen })).toEqual(['made']);
    await fsp.mkdir(path.join(vault, 'made'));
    // A folder that existed vanishes mid-run and the write makes it again.
    await fsp.rmdir(path.join(vault, 'kept'));
    expect(await missingFolders(vault, ['made/b.md', 'kept/b.md'], { seen })).toEqual([]);
  });

  it('writes the record whole, leaving no temporary file', async () => {
    await recordCreatedFolders(vault, ['a']);
    expect(await fsp.readdir(vault)).toEqual(['folders.json']);
  });

  it('rollbackCreatedFolders names the unreadable record by the path given', async () => {
    await fsp.writeFile(path.join(vault, 'folders.json'), '{not json');
    const failures = await rollbackCreatedFolders(vault, vault, '.shardmind/backups/adopt-1/folders.json');
    expect(failures).toHaveLength(1);
    expect(failures[0]!.path).toBe('.shardmind/backups/adopt-1/folders.json');
    expect(failures[0]!.reason).toMatch(/^folder record unreadable: /);
  });

  it.each([
    ['not JSON', '{not json'],
    ['not a list of folders', '{"not": "a list"}'],
  ])('rollbackCreatedFolders falls back to the list the run recorded when the record is %s (#295)', async (_name, text) => {
    const backup = path.join(vault, 'backup');
    await fsp.mkdir(backup);
    await fsp.writeFile(path.join(backup, 'folders.json'), text);
    await fsp.mkdir(path.join(vault, 'Fresh', 'Deep'), { recursive: true });
    await fsp.mkdir(path.join(vault, 'mine'));
    await fsp.writeFile(path.join(vault, 'mine', 'note.md'), 'mine');

    const failures = await rollbackCreatedFolders(vault, backup, 'backup/folders.json', ['Fresh', 'Fresh/Deep']);
    expect(failures).toEqual([]);
    // The run's folders go; the user's folder, never in the list, stays.
    await expect(fsp.access(path.join(vault, 'Fresh'))).rejects.toThrow();
    expect(await fsp.readFile(path.join(vault, 'mine', 'note.md'), 'utf-8')).toBe('mine');
  });

  it('rollbackCreatedFolders still reads a usable record over the list it was given', async () => {
    const backup = path.join(vault, 'backup');
    await fsp.mkdir(backup);
    await recordCreatedFolders(backup, ['Recorded']);
    await fsp.mkdir(path.join(vault, 'Recorded'));
    await fsp.mkdir(path.join(vault, 'Given'));
    expect(await rollbackCreatedFolders(vault, backup, 'backup/folders.json', ['Given'])).toEqual([]);
    await expect(fsp.access(path.join(vault, 'Recorded'))).rejects.toThrow();
    await fsp.access(path.join(vault, 'Given'));
  });
});

// On a case-folding filesystem a folder under another spelling exists.
const caseFolds = await (async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'case-probe-'));
  try {
    await fsp.mkdir(path.join(dir, 'Probe'));
    return await fsp.lstat(path.join(dir, 'probe')).then(() => true, () => false);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
})();

describe.skipIf(!caseFolds)('created folders on a case-folding filesystem (#258)', () => {
  it('counts a folder under another spelling as existing, never as created', async () => {
    const vault = await fsp.mkdtemp(path.join(os.tmpdir(), 'created-case-'));
    try {
      await fsp.mkdir(path.join(vault, 'Notes'));
      expect(await missingFolders(vault, ['notes/a.md'])).toEqual([]);
    } finally {
      await fsp.rm(vault, { recursive: true, force: true });
    }
  });
});
