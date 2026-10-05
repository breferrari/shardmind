import { describe, it, expect, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  headerFor,
  stripHeader,
  readRecord,
  writeRecord,
  parseRecord,
  tagFor,
  type VendorRecord,
} from '../../scripts/vendor/record.js';

export const RECORD: VendorRecord = {
  schemaVersion: 1,
  kit: 'demo-kit',
  package: 'demo-pkg',
  version: '1.0.0',
  repository: 'https://github.com/example/demo',
  tag: 'v1.0.0',
  commit: 'a'.repeat(40),
  tarball: { url: 'https://registry.npmjs.org/demo-pkg/-/demo-pkg-1.0.0.tgz', integrity: 'sha512-x' },
  sourceRoot: 'source',
  license: 'MIT',
  copyright: 'Demo Author',
  modifiedBy: 'Brenno Ferrari',
  files: {
    'b.ts': { upstream: 'lib/b.ts', modified: false },
    'a.ts': { upstream: 'lib/a.ts', modified: true, change: 'no default React import.' },
  },
};

describe('vendor record (#280)', () => {
  it.each([
    ['a file key that climbs out of the kit', { files: { '../x.ts': { upstream: 'lib/x.ts', modified: false } } }],
    ['an upstream path that climbs out', { files: { 'x.ts': { upstream: '../../etc/x', modified: false } } }],
    ['an absolute upstream path', { files: { 'x.ts': { upstream: '/etc/x', modified: false } } }],
    ['a drive-letter path', { files: { 'C:/x.ts': { upstream: 'lib/x.ts', modified: false } } }],
    ['a backslash path', { files: { 'x.ts': { upstream: 'lib\\x.ts', modified: false } } }],
    ['a sourceRoot that climbs out', { sourceRoot: '..' }],
  ])('refuses %s', (_name, patch) => {
    expect(() => parseRecord({ ...RECORD, ...patch })).toThrow(/relative path inside its folder/);
  });

  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await fsp.rm(d, { recursive: true, force: true });
  });

  it('generates the agreed header, with the modified line only when modified', () => {
    expect(headerFor(RECORD, 'a.ts')).toBe(
      '/*\n' +
        ` * From demo-pkg@1.0.0 (https://github.com/example/demo at ${'a'.repeat(40)}), lib/a.ts.\n` +
        ' * Copyright (c) Demo Author. MIT: see demo-kit/LICENSE.\n' +
        ' * Modified by Brenno Ferrari: no default React import.\n' +
        ' */\n\n',
    );
    expect(headerFor(RECORD, 'b.ts')).toBe(
      '/*\n' +
        ` * From demo-pkg@1.0.0 (https://github.com/example/demo at ${'a'.repeat(40)}), lib/b.ts.\n` +
        ' * Copyright (c) Demo Author. MIT: see demo-kit/LICENSE.\n' +
        ' */\n\n',
    );
  });

  it('strips exactly its own header, and refuses a file whose header differs', () => {
    expect(stripHeader(headerFor(RECORD, 'b.ts') + 'export const b = 1;\n', RECORD, 'b.ts')).toBe('export const b = 1;\n');
    expect(() => stripHeader('/* edited by hand */\nexport const b = 1;\n', RECORD, 'b.ts')).toThrow(/header/);
  });

  it('rejects a record that breaks the schema', () => {
    expect(() => parseRecord({ ...RECORD, commit: 'abc' })).toThrow();
    expect(() => parseRecord({ ...RECORD, files: { 'a.ts': { upstream: 'lib/a.ts', modified: true } } })).toThrow(/change/);
    expect(() => parseRecord({ ...RECORD, schemaVersion: 2 })).toThrow();
  });

  it('writes keys sorted at every depth with a trailing newline, and reads it back', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vendor-record-'));
    dirs.push(dir);
    await writeRecord(dir, RECORD);
    const text = await fsp.readFile(path.join(dir, 'VENDOR.json'), 'utf-8');
    expect(text.endsWith('}\n')).toBe(true);
    const json = JSON.parse(text);
    expect(Object.keys(json)).toEqual([...Object.keys(json)].sort());
    expect(Object.keys(json.files)).toEqual(['a.ts', 'b.ts']);
    expect(Object.keys(json.files['a.ts'])).toEqual(['change', 'modified', 'upstream']);
    expect(Object.keys(json.tarball)).toEqual(['integrity', 'url']);
    expect(await readRecord(dir)).toEqual(RECORD);
  });

  it('names a version tag by its pattern, v{version} by default', () => {
    expect(tagFor(RECORD, '2.0.0')).toBe('v2.0.0');
    expect(tagFor({ ...RECORD, tagPattern: 'release-{version}' }, '2.0.0')).toBe('release-2.0.0');
  });
});
