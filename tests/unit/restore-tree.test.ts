/**
 * core/restore-tree.ts (#264): putting a snapshot back. `restoreTree` copies
 * over (the vault root holds the user's files too); `restoreDirExactly`
 * makes a folder the run replaced whole equal to its snapshot.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { restoreDirExactly, restoreTree } from '../../source/core/restore-tree.js';
import type { RollbackFailure } from '../../source/core/rollback-report.js';

let root: string;
const snap = () => path.join(root, 'snap');
const dest = () => path.join(root, 'dest');

async function write(base: string, rel: string, body: string): Promise<void> {
  await fsp.mkdir(path.dirname(path.join(base, rel)), { recursive: true });
  await fsp.writeFile(path.join(base, rel), body);
}

async function tree(dir: string): Promise<Record<string, string> | null> {
  try {
    await fsp.access(dir);
  } catch {
    return null;
  }
  const out: Record<string, string> = {};
  for (const rel of (await fsp.readdir(dir, { recursive: true })) as string[]) {
    const abs = path.join(dir, rel);
    const key = rel.split(path.sep).join('/');
    out[key] = (await fsp.stat(abs)).isDirectory() ? '<dir>' : await fsp.readFile(abs, 'utf-8');
  }
  return out;
}

beforeEach(async () => {
  root = path.join(os.tmpdir(), `shardmind-restore-${crypto.randomUUID()}`);
  await fsp.mkdir(root, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe('restoreDirExactly (#264)', () => {
  it('makes the folder equal to the snapshot: bytes back, extras and their emptied folders gone', async () => {
    await write(snap(), 'a.njk', 'old a');
    await write(snap(), 'kept/b.njk', 'old b');
    await write(dest(), 'a.njk', 'new a');
    await write(dest(), 'kept/b.njk', 'new b');
    await write(dest(), 'added.njk', 'only in the new version');
    await write(dest(), 'new-folder/c.njk', 'only in the new version');
    const failures: RollbackFailure[] = [];
    await restoreDirExactly(snap(), dest(), failures);
    expect(failures).toEqual([]);
    expect(await tree(dest())).toEqual(await tree(snap()));
  });

  it('restores a folder the run removed', async () => {
    await write(snap(), 'x/y.njk', 'old');
    const failures: RollbackFailure[] = [];
    await restoreDirExactly(snap(), dest(), failures);
    expect(await tree(dest())).toEqual({ x: '<dir>', 'x/y.njk': 'old' });
  });

  it('removes the folder when the snapshot has none: it did not exist before', async () => {
    await write(dest(), 'added.njk', 'new');
    const failures: RollbackFailure[] = [];
    await restoreDirExactly(snap(), dest(), failures);
    expect(failures).toEqual([]);
    expect(await tree(dest())).toBeNull();
  });

  it('keeps an empty folder the snapshot has', async () => {
    await fsp.mkdir(path.join(snap(), 'empty'), { recursive: true });
    await write(dest(), 'empty/new.njk', 'new');
    const failures: RollbackFailure[] = [];
    await restoreDirExactly(snap(), dest(), failures);
    expect(await tree(dest())).toEqual({ empty: '<dir>' });
  });
});

describe('restoreTree', () => {
  it('copies the snapshot over and leaves files it does not hold (the vault root holds the user\'s files)', async () => {
    await write(snap(), 'note.md', 'old');
    await write(dest(), 'note.md', 'new');
    await write(dest(), 'mine.md', "the user's");
    const failures: RollbackFailure[] = [];
    await restoreTree(snap(), dest(), failures);
    expect(await tree(dest())).toEqual({ 'note.md': 'old', 'mine.md': "the user's" });
  });

  it('skips the subtrees it is told to', async () => {
    await write(snap(), 'keep.md', 'old');
    await write(snap(), 'skip/x.md', 'old');
    const failures: RollbackFailure[] = [];
    await restoreTree(snap(), dest(), failures, { skip: ['skip'] });
    expect(await tree(dest())).toEqual({ 'keep.md': 'old' });
  });
});
