import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  it('assertSafeVaultPaths resolves when every path is safe', async () => {
    await expect(assertSafeVaultPaths(vault, ['Home.md'])).resolves.toBeUndefined();
  });
});
