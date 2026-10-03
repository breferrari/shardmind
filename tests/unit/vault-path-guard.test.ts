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

// Creating a symlink needs a privilege on Windows that CI runners and most
// dev boxes lack; probe once and skip the symlink cases where it fails.
async function symlinksWork(): Promise<boolean> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'shardmind-symprobe-'));
  try {
    await fsp.symlink(path.join(dir, 'target'), path.join(dir, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

// True when the filesystem under tmpdir resolves names case-insensitively.
async function foldsCase(): Promise<boolean> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'shardmind-caseprobe-'));
  try {
    await fsp.writeFile(path.join(dir, 'probe'), '');
    await fsp.lstat(path.join(dir, 'PROBE'));
    return true;
  } catch {
    return false;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

const canSymlink = await symlinksWork();
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

  it('flags a file with another hard link', async () => {
    await fsp.writeFile(path.join(outside, 'shared.md'), 'shared');
    await fsp.link(path.join(outside, 'shared.md'), path.join(vault, 'Home.md'));
    expect(await findUnsafeVaultPaths(vault, ['Home.md'])).toEqual([{ path: 'Home.md', reason: 'hard-link' }]);
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

  it('assertSafeVaultPaths throws VAULT_PATH_UNSAFE naming each path and reason', async () => {
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
