/**
 * Rename migrations (#178): the manifest's `migrations` field, and the
 * old → new path map an update applies.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ShardManifestSchema } from '../../source/core/manifest.js';
import { caseOnlyRenames, parseFromVersion, renamesBetween, sameFile, undoCaseHops } from '../../source/core/rename-migrations.js';
import { foldsCase } from '../helpers/fs-capabilities.js';

const caseFolds = await foldsCase();

const base = { apiVersion: 'v1', name: 'demo', namespace: 'acme', version: '6.2.0' };

describe('ShardManifestSchema migrations (#178)', () => {
  const parse = (migrations: unknown) => ShardManifestSchema.safeParse({ ...base, migrations });

  it('accepts a well-formed migration and leaves the field optional', () => {
    expect(parse([{ from: '5.1.0', to: '6.1.0', renames: { 'brain/a.md': 'brain/b.md' } }]).success).toBe(true);
    expect(ShardManifestSchema.safeParse(base).success).toBe(true);
  });

  it.each([
    ['a non-semver from', [{ from: 'five', to: '6.1.0', renames: { 'a.md': 'b.md' } }]],
    ['to not after from', [{ from: '6.1.0', to: '6.1.0', renames: { 'a.md': 'b.md' } }]],
    ['an absolute path', [{ from: '5.1.0', to: '6.1.0', renames: { '/etc/a.md': 'b.md' } }]],
    ['a path leaving the vault', [{ from: '5.1.0', to: '6.1.0', renames: { 'a.md': '../b.md' } }]],
    ['a Windows separator', [{ from: '5.1.0', to: '6.1.0', renames: { 'brain\\a.md': 'b.md' } }]],
    ['a path under .shardmind/', [{ from: '5.1.0', to: '6.1.0', renames: { 'a.md': '.shardmind/b.md' } }]],
    ['a path renamed to itself', [{ from: '5.1.0', to: '6.1.0', renames: { 'a.md': 'a.md' } }]],
    ['two old paths to one new path', [{ from: '5.1.0', to: '6.1.0', renames: { 'a.md': 'c.md', 'b.md': 'c.md' } }]],
    ['an empty path', [{ from: '5.1.0', to: '6.1.0', renames: { '': 'c.md' } }]],
    ['a ./ prefix, which never matches a tracked path', [{ from: '5.1.0', to: '6.1.0', renames: { './a.md': 'b.md' } }]],
    ['an empty segment', [{ from: '5.1.0', to: '6.1.0', renames: { 'a//b.md': 'b.md' } }]],
    ['a trailing slash', [{ from: '5.1.0', to: '6.1.0', renames: { 'a.md': 'b/' } }]],
    ['.shardmind/ in another case', [{ from: '5.1.0', to: '6.1.0', renames: { 'a.md': '.ShardMind/b.md' } }]],
    ['a path under .git/', [{ from: '5.1.0', to: '6.1.0', renames: { 'a.md': '.git/b.md' } }]],
  ])('rejects %s', (_label, migrations) => {
    expect(parse(migrations).success).toBe(false);
  });
});

describe('renamesBetween (#178)', () => {
  const m = (from: string, to: string, renames: Record<string, string>) => ({ from, to, renames });

  it('is empty without migrations', () => {
    expect(renamesBetween(undefined, '1.0.0', '2.0.0')).toEqual(new Map());
    expect(renamesBetween([], '1.0.0', '2.0.0')).toEqual(new Map());
  });

  it('applies a migration whose `to` lies in (installed, target]', () => {
    const migrations = [m('5.1.0', '6.1.0', { 'a.md': 'b.md' })];
    expect(renamesBetween(migrations, '5.1.0', '6.1.0')).toEqual(new Map([['a.md', 'b.md']]));
    expect(renamesBetween(migrations, '5.0.0', '6.2.0')).toEqual(new Map([['a.md', 'b.md']]));
  });

  it('skips a migration already behind the installed version or beyond the target', () => {
    const migrations = [m('5.1.0', '6.1.0', { 'a.md': 'b.md' })];
    expect(renamesBetween(migrations, '6.1.0', '6.2.0')).toEqual(new Map());
    expect(renamesBetween(migrations, '5.1.0', '6.0.0')).toEqual(new Map());
  });

  it('chains renames in `to` order, whatever order they are declared in', () => {
    const migrations = [m('6.1.0', '6.2.0', { 'b.md': 'c.md' }), m('5.1.0', '6.1.0', { 'a.md': 'b.md' })];
    // `b.md` → `c.md` is in the map too: a file tracked at `b.md` moves.
    // Which old paths exist, and clashes between them, is applyRenames' job.
    expect(renamesBetween(migrations, '5.1.0', '6.2.0')).toEqual(
      new Map([['a.md', 'c.md'], ['b.md', 'c.md']]),
    );
    // Updating from 6.1 only the second step applies.
    expect(renamesBetween(migrations, '6.1.0', '6.2.0')).toEqual(new Map([['b.md', 'c.md']]));
  });

  it('drops a chain that comes back to where it started', () => {
    const migrations = [m('1.0.0', '2.0.0', { 'a.md': 'b.md' }), m('2.0.0', '3.0.0', { 'b.md': 'a.md' })];
    expect(renamesBetween(migrations, '1.0.0', '3.0.0')).toEqual(new Map([['b.md', 'a.md']]));
  });

  it('compares versions as semver, not as strings', () => {
    const migrations = [m('6.9.0', '6.10.0', { 'a.md': 'b.md' })];
    expect(renamesBetween(migrations, '6.9.0', '6.10.0')).toEqual(new Map([['a.md', 'b.md']]));
  });
});

describe('parseFromVersion (#179)', () => {
  it('accepts a semver version, normalized', () => {
    expect(parseFromVersion('5.1.0')).toBe('5.1.0');
    expect(parseFromVersion('v5.1.0')).toBe('5.1.0');
  });

  it.each(['five', '5.1', '', '>=5.0.0'])('refuses %j with ADOPT_FROM_VERSION_INVALID', (value) => {
    expect(() => parseFromVersion(value)).toThrow(expect.objectContaining({ code: 'ADOPT_FROM_VERSION_INVALID' }));
  });
});

describe('caseOnlyRenames (#169)', () => {
  const pairs = (tracked: string[], shipped: string[], declared: Record<string, string> = {}) =>
    Object.fromEntries(caseOnlyRenames(tracked, new Set(shipped), new Map(Object.entries(declared))));

  it('pairs a tracked file no longer shipped with the new path that differs only in case', () => {
    expect(pairs(['Foo.md', 'Home.md'], ['foo.md', 'Home.md'])).toEqual({ 'Foo.md': 'foo.md' });
    expect(pairs(['brain/North Star.md'], ['brain/north star.md'])).toEqual({ 'brain/North Star.md': 'brain/north star.md' });
  });

  it('pairs nothing when two new paths fold to the old name', () => {
    expect(pairs(['Foo.md'], ['foo.md', 'FOO.md'])).toEqual({});
  });

  it('pairs nothing when two old files fold to the new name', () => {
    expect(pairs(['Foo.md', 'FOO.md'], ['foo.md'])).toEqual({});
  });

  it('pairs a path whose folder changes case, with or without its name (#195)', () => {
    expect(pairs(['Notes/Foo.md'], ['notes/Foo.md'])).toEqual({ 'Notes/Foo.md': 'notes/Foo.md' });
    expect(pairs(['Notes/Foo.md'], ['notes/foo.md'])).toEqual({ 'Notes/Foo.md': 'notes/foo.md' });
    expect(pairs(['Brain/Notes/A.md'], ['brain/notes/A.md'])).toEqual({ 'Brain/Notes/A.md': 'brain/notes/A.md' });
  });

  it('moves a folder only as a whole: every file under it pairs, or none does (#195)', () => {
    expect(pairs(['Notes/A.md', 'Notes/B.md'], ['notes/A.md', 'notes/B.md'])).toEqual({
      'Notes/A.md': 'notes/A.md',
      'Notes/B.md': 'notes/B.md',
    });
    // B.md is still shipped under the old spelling, so the folder cannot move.
    expect(pairs(['Notes/A.md', 'Notes/B.md'], ['notes/A.md', 'Notes/B.md'])).toEqual({});
    // A file the new shard drops leaves with the update; it does not hold the folder.
    expect(pairs(['Notes/A.md', 'Notes/Gone.md'], ['notes/A.md'])).toEqual({ 'Notes/A.md': 'notes/A.md' });
  });

  it('pairs nothing when one old folder would take two new spellings (#195)', () => {
    expect(pairs(['Notes/A.md', 'Notes/B.md'], ['notes/A.md', 'NOTES/B.md'])).toEqual({});
  });

  it('a nested folder holding the old spelling blocks its parent too (#195)', () => {
    expect(pairs(['Brain/A.md', 'Brain/Sub/B.md'], ['brain/A.md', 'Brain/Sub/B.md'])).toEqual({});
  });

  it('pairs nothing when the old path is still shipped or the new one is already tracked', () => {
    expect(pairs(['Foo.md'], ['Foo.md', 'foo.md'])).toEqual({});
    expect(pairs(['Foo.md', 'foo.md'], ['foo.md'])).toEqual({});
  });

  it('pairs nothing for names that differ by more than case', () => {
    expect(pairs(['Foo.md'], ['Foo.txt'])).toEqual({});
  });

  it('leaves a declared rename of the old path, or into the new one, to the declaration', () => {
    expect(pairs(['Foo.md'], ['foo.md'], { 'Foo.md': 'bar.md' })).toEqual({});
    expect(pairs(['Foo.md', 'Old.md'], ['foo.md'], { 'Old.md': 'foo.md' })).toEqual({});
  });

  it('pairs a change of Unicode normalization alone, which macOS folds like case', () => {
    expect(pairs(['caf\u00e9.md'], ['cafe\u0301.md'])).toEqual({ 'caf\u00e9.md': 'cafe\u0301.md' });
  });

  it('treats a Unicode normalization difference as the same name', () => {
    // NFD "e\u0301" vs NFC "\u00e9": the same name to a user, folded by macOS.
    expect(pairs(['Caf\u00e9.md'], ['cafe\u0301.md'])).toEqual({ 'Caf\u00e9.md': 'cafe\u0301.md' });
  });
});

describe('sameFile (#169)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'shardmind-169-'));
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it.skipIf(!caseFolds)('is true for two spellings of one file on a case-folding filesystem', async () => {
    await fsp.writeFile(path.join(dir, 'Foo.md'), 'x');
    expect(await sameFile(dir, 'Foo.md', 'foo.md')).toBe(true);
    expect(await sameFile(dir, 'foo.md', 'Foo.md')).toBe(true);
  });

  it.skipIf(caseFolds)('is false for two files whose names differ only in case', async () => {
    await fsp.writeFile(path.join(dir, 'Foo.md'), 'x');
    await fsp.writeFile(path.join(dir, 'foo.md'), 'y');
    expect(await sameFile(dir, 'Foo.md', 'foo.md')).toBe(false);
  });

  it.skipIf(!caseFolds)('is true for two folder spellings of one file on a case-folding filesystem (#195)', async () => {
    await fsp.mkdir(path.join(dir, 'Notes'));
    await fsp.writeFile(path.join(dir, 'Notes', 'Foo.md'), 'x');
    expect(await sameFile(dir, 'Notes/Foo.md', 'notes/Foo.md')).toBe(true);
    expect(await sameFile(dir, 'Notes/Foo.md', 'notes/foo.md')).toBe(true);
  });

  it.skipIf(caseFolds)('is false for two folders whose names differ only in case (#195)', async () => {
    await fsp.mkdir(path.join(dir, 'Notes'));
    await fsp.mkdir(path.join(dir, 'notes'));
    await fsp.writeFile(path.join(dir, 'Notes', 'Foo.md'), 'x');
    await fsp.writeFile(path.join(dir, 'notes', 'Foo.md'), 'y');
    expect(await sameFile(dir, 'Notes/Foo.md', 'notes/Foo.md')).toBe(false);
  });

  it('undoCaseHops reports an unreadable journal instead of undoing nothing silently (#195)', async () => {
    expect(await undoCaseHops(dir, dir)).toEqual([]);
    await fsp.writeFile(path.join(dir, 'case-renames.json'), '[{"from":"a","to":"A","tm');
    const failures = await undoCaseHops(dir, dir);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.reason).toMatch(/journal unreadable/);
  });

  it('is false when either path reaches nothing', async () => {
    expect(await sameFile(dir, 'Foo.md', 'foo.md')).toBe(false);
  });
});
