/**
 * Rename migrations (#178): the manifest's `migrations` field, and the
 * old → new path map an update applies.
 */

import { describe, it, expect } from 'vitest';
import { ShardManifestSchema } from '../../source/core/manifest.js';
import { renamesBetween } from '../../source/core/rename-migrations.js';

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
