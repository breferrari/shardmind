import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  findUnsafeVaultPaths,
  assertSafeVaultPaths,
} from '../../source/core/vault-path-guard.js';
import { ShardMindError } from '../../source/runtime/types.js';
import { symlinksWork, hardLinksWork, foldsCase } from '../helpers/fs-capabilities.js';

const canSymlink = await symlinksWork();
const canHardLink = await hardLinksWork();
const caseFolds = await foldsCase();

describe('findUnsafeVaultPaths (#163)', () => {
  let root: string;
  let vault: string;
  let outside: string;

  beforeEach(async () => {
    root = path.join(os.tmpdir(), `shardmind-guard-${crypto.randomUUID()}`);
    vault = path.join(root, 'vault');
    outside = path.join(root, 'outside');
    await fsp.mkdir(vault, { recursive: true });
    await fsp.mkdir(outside, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('accepts plain files, missing files and paths whose parent does not exist yet', async () => {
    await fsp.mkdir(path.join(vault, 'brain'));
    await fsp.writeFile(path.join(vault, 'brain', 'Goals.md'), 'x');
    expect(
      await findUnsafeVaultPaths(vault, ['brain/Goals.md', 'brain/New.md', 'work/deep/New.md', 'Home.md']),
    ).toEqual([]);
  });

  it('accepts an empty list', async () => {
    expect(await findUnsafeVaultPaths(vault, [])).toEqual([]);
  });

  it.skipIf(!canSymlink)('flags a dangling symlink at the path', async () => {
    await fsp.symlink(path.join(outside, 'nowhere.md'), path.join(vault, 'Home.md'));
    expect(await findUnsafeVaultPaths(vault, ['Home.md'])).toEqual([{ path: 'Home.md', reason: 'symlink' }]);
  });

  it.skipIf(!canSymlink)('flags a symlink to a file outside the vault', async () => {
    await fsp.writeFile(path.join(outside, 'precious.md'), 'outside');
    await fsp.symlink(path.join(outside, 'precious.md'), path.join(vault, 'Home.md'));
    expect(await findUnsafeVaultPaths(vault, ['Home.md'])).toEqual([{ path: 'Home.md', reason: 'symlink' }]);
  });

  it.skipIf(!canSymlink)('flags a path under a symlinked folder', async () => {
    await fsp.symlink(outside, path.join(vault, 'brain'), 'dir');
    expect(await findUnsafeVaultPaths(vault, ['brain/Goals.md'])).toEqual([
      { path: 'brain/Goals.md', reason: 'symlinked-folder' },
    ]);
  });

  it.skipIf(!canHardLink)('flags a file with another hard link', async () => {
    await fsp.writeFile(path.join(outside, 'shared.md'), 'shared');
    await fsp.link(path.join(outside, 'shared.md'), path.join(vault, 'Home.md'));
    expect(await findUnsafeVaultPaths(vault, ['Home.md'])).toEqual([{ path: 'Home.md', reason: 'hard-link' }]);
  });

  it.skipIf(!canSymlink)('checks only the folders of a path to delete: unlinking a link harms nothing (#163)', async () => {
    await fsp.symlink(path.join(outside, 'x.md'), path.join(vault, 'Old.md'));
    await fsp.symlink(outside, path.join(vault, 'linked'), 'dir');
    expect(await findUnsafeVaultPaths(vault, [], ['Old.md', 'linked/Gone.md'])).toEqual([
      { path: 'linked/Gone.md', reason: 'symlinked-folder' },
    ]);
  });

  it.skipIf(!canHardLink)('does not flag a hard-linked file that is only deleted', async () => {
    await fsp.writeFile(path.join(outside, 'shared.md'), 'shared');
    await fsp.link(path.join(outside, 'shared.md'), path.join(vault, 'Old.md'));
    expect(await findUnsafeVaultPaths(vault, [], ['Old.md'])).toEqual([]);
  });

  it.skipIf(!caseFolds)('flags a folder that exists only under a different case', async () => {
    await fsp.mkdir(path.join(vault, 'Brain'));
    expect(await findUnsafeVaultPaths(vault, ['brain/Goals.md'])).toEqual([
      { path: 'brain/Goals.md', reason: 'case-mismatch' },
    ]);
  });

  it.skipIf(!caseFolds)('flags a file that exists only under a different case', async () => {
    await fsp.writeFile(path.join(vault, 'HOME.md'), 'x');
    expect(await findUnsafeVaultPaths(vault, ['Home.md'])).toEqual([{ path: 'Home.md', reason: 'case-mismatch' }]);
  });

  it.skipIf(!canHardLink)('assertSafeVaultPaths throws VAULT_PATH_UNSAFE naming each path and reason', async () => {
    await fsp.writeFile(path.join(outside, 'shared.md'), 'shared');
    await fsp.link(path.join(outside, 'shared.md'), path.join(vault, 'Home.md'));
    const err = await assertSafeVaultPaths(vault, ['Home.md', 'Other.md']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShardMindError);
    expect((err as ShardMindError).code).toBe('VAULT_PATH_UNSAFE');
    expect((err as ShardMindError).message).toContain('Home.md (hard-link)');
    expect((err as ShardMindError).message).not.toContain('Other.md');
  });

  it.skipIf(!canSymlink)("checks the engine's own folders, such as .shardmind/backups", async () => {
    await fsp.mkdir(path.join(vault, '.shardmind'));
    await fsp.symlink(outside, path.join(vault, '.shardmind', 'backups'), 'dir');
    const err = await assertSafeVaultPaths(vault, []).catch((e: unknown) => e);
    expect((err as ShardMindError).code).toBe('VAULT_PATH_UNSAFE');
    expect((err as ShardMindError).message).toContain('backups (symlink)');
  });

  it.skipIf(!canSymlink)("checks the run lock at the vault root like the engine's other files (#253)", async () => {
    await fsp.symlink(path.join(outside, 'x'), path.join(vault, '.shardmind.lock'));
    const err = await assertSafeVaultPaths(vault, []).catch((e: unknown) => e);
    expect((err as ShardMindError).code).toBe('VAULT_PATH_UNSAFE');
    expect((err as ShardMindError).message).toContain('.shardmind.lock (symlink)');
  });

  it.skipIf(!caseFolds)('flags a deleted file whose name on disk differs only in case', async () => {
    await fsp.writeFile(path.join(vault, 'foo.md'), 'renamed by the user');
    expect(await findUnsafeVaultPaths(vault, [], ['Foo.md'])).toEqual([{ path: 'Foo.md', reason: 'case-mismatch' }]);
  });

  it.skipIf(!caseFolds)("does not read a case-only rename's own names as a case-mismatch (#169)", async () => {
    // Before the move, disk spells the old name; after a user's own rename, the new one.
    await fsp.writeFile(path.join(vault, 'Foo.md'), 'x');
    expect(await findUnsafeVaultPaths(vault, ['foo.md'], ['Foo.md'], [['Foo.md', 'foo.md']])).toEqual([]);
    await fsp.rename(path.join(vault, 'Foo.md'), path.join(vault, 'foo.md'));
    expect(await findUnsafeVaultPaths(vault, ['foo.md'], ['Foo.md'], [['Foo.md', 'foo.md']])).toEqual([]);
  });

  it.skipIf(!caseFolds)("still flags a third spelling on disk, which is not the pair's (#169)", async () => {
    await fsp.writeFile(path.join(vault, 'FOO.md'), 'x');
    expect(await findUnsafeVaultPaths(vault, ['foo.md'], ['Foo.md'], [['Foo.md', 'foo.md']])).toEqual([
      { path: 'foo.md', reason: 'case-mismatch' },
      { path: 'Foo.md', reason: 'case-mismatch' },
    ]);
  });

  it.skipIf(!caseFolds || !canSymlink)('still refuses a case-only rename whose file is a symlink (#169)', async () => {
    await fsp.writeFile(path.join(outside, 'target.md'), 'x');
    await fsp.symlink(path.join(outside, 'target.md'), path.join(vault, 'Foo.md'));
    expect(await findUnsafeVaultPaths(vault, ['foo.md'], ['Foo.md'], [['Foo.md', 'foo.md']])).toEqual([
      { path: 'foo.md', reason: 'symlink' },
    ]);
  });

  it('skips the case check for a folder it cannot list, rather than failing', async () => {
    await fsp.mkdir(path.join(vault, 'locked'));
    const readdir = vi.spyOn(fsp, 'readdir').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    try {
      expect(await findUnsafeVaultPaths(vault, ['locked/Note.md'])).toEqual([]);
    } finally {
      readdir.mockRestore();
    }
  });

  it('reports a path it cannot inspect as COLLISION_CHECK_FAILED, not a raw errno', async () => {
    const lstat = vi.spyOn(fsp, 'lstat').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    try {
      const err = await findUnsafeVaultPaths(vault, ['Home.md']).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ShardMindError);
      expect((err as ShardMindError).code).toBe('COLLISION_CHECK_FAILED');
    } finally {
      lstat.mockRestore();
    }
  });

  it.skipIf(!canSymlink)("checks a hook's log file inside .shardmind/logs", async () => {
    await fsp.mkdir(path.join(vault, '.shardmind', 'logs'), { recursive: true });
    await fsp.symlink(path.join(outside, 'x.log'), path.join(vault, '.shardmind', 'logs', 'bootstrap.log'));
    const err = await assertSafeVaultPaths(vault, []).catch((e: unknown) => e);
    expect((err as ShardMindError).message).toContain('bootstrap.log (symlink)');
  });

  it('reports a folder it cannot list for another reason as COLLISION_CHECK_FAILED', async () => {
    await fsp.mkdir(path.join(vault, 'busy'));
    const readdir = vi.spyOn(fsp, 'readdir').mockRejectedValue(Object.assign(new Error('io'), { code: 'EIO' }));
    try {
      const err = await findUnsafeVaultPaths(vault, ['busy/Note.md']).catch((e: unknown) => e);
      expect((err as ShardMindError).code).toBe('COLLISION_CHECK_FAILED');
    } finally {
      readdir.mockRestore();
    }
  });

  it('assertSafeVaultPaths resolves when every path is safe', async () => {
    await expect(assertSafeVaultPaths(vault, ['Home.md'])).resolves.toBeUndefined();
  });
});
