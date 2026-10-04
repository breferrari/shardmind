import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  missingFolders,
  recordCreatedFolders,
  readCreatedFolders,
  removeCreatedFolders,
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
    vi.spyOn(fsp, 'rmdir').mockImplementation(async (p, o) => {
      if (p === path.join(vault, 'busy')) throw Object.assign(new Error('simulated EBUSY'), { code: 'EBUSY' });
      return realRmdir(p, o);
    });
    const failures = await removeCreatedFolders(vault, ['busy']);
    expect(failures).toEqual([{ path: 'busy', reason: 'remove failed: simulated EBUSY' }]);
  });
});
