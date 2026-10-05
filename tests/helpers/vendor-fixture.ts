/**
 * Fixture upstreams for the vendor scripts (#280): a package at v1 and v2,
 * and a kit vendored from v1 with ShardMind's own changes. No network.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { headerFor, writeRecord, type VendorRecord } from '../../scripts/vendor/record.js';
import type { UpstreamSource } from '../../scripts/vendor/upstream.js';

export const V1_COMMIT = '1'.repeat(40);
export const V2_COMMIT = '2'.repeat(40);

const lines = (...l: string[]) => `${l.join('\n')}\n`;

/** Upstream's source files at each version, under `source/`. */
export const UPSTREAM: Record<'1.0.0' | '2.0.0', Record<string, string>> = {
  '1.0.0': {
    'lib/a.ts': lines('export const a1 = 1;', 'export const a2 = 2;', 'export const a3 = 3;', 'export const a4 = 4;', 'export const a5 = 5;'),
    'lib/b.ts': lines('export const b = 1;'),
    'lib/c.ts': lines('export const c = 1;'),
    'lib/d.ts': lines('export const d = 1;'),
  },
  '2.0.0': {
    // Upstream changes a's first line; ShardMind changed its last.
    'lib/a.ts': lines('export const a1 = 10;', 'export const a2 = 2;', 'export const a3 = 3;', 'export const a4 = 4;', 'export const a5 = 5;'),
    'lib/b.ts': lines('export const b = 2;'),
    // Upstream changes the very line ShardMind changed.
    'lib/c.ts': lines('export const c = 2;'),
    // d.ts is gone, e.ts is new.
    'lib/e.ts': lines('export const e = 1;'),
  },
};

/** ShardMind's copies, header aside. */
export const OURS: Record<string, string> = {
  'a.ts': lines('export const a1 = 1;', 'export const a2 = 2;', 'export const a3 = 3;', 'export const a4 = 4;', 'export const a5 = 50; // ShardMind'),
  'b.ts': UPSTREAM['1.0.0']['lib/b.ts']!,
  'c.ts': lines('export const c = 99; // ShardMind'),
  'd.ts': UPSTREAM['1.0.0']['lib/d.ts']!,
};

export function recordFor(files: (keyof typeof OURS)[]): VendorRecord {
  const entries: VendorRecord['files'] = {};
  for (const f of files) {
    const modified = OURS[f] !== UPSTREAM['1.0.0'][`lib/${f}`];
    entries[f] = modified ? { upstream: `lib/${f}`, modified, change: `local change to ${f}.` } : { upstream: `lib/${f}`, modified };
  }
  return {
    schemaVersion: 1,
    kit: 'demo-kit',
    package: 'demo-pkg',
    version: '1.0.0',
    repository: 'https://github.com/example/demo',
    tag: 'v1.0.0',
    commit: V1_COMMIT,
    tarball: { url: 'https://registry.npmjs.org/demo-pkg/-/demo-pkg-1.0.0.tgz', integrity: 'sha512-v1' },
    sourceRoot: 'source',
    license: 'MIT',
    copyright: 'Demo Author',
    modifiedBy: 'Brenno Ferrari',
    files: entries,
  };
}

/** A temp folder with the upstreams and a kit vendored from v1 holding `files`. */
export async function makeVendorFixture(files: (keyof typeof OURS)[]): Promise<{
  root: string;
  kitDir: string;
  source: UpstreamSource;
  cleanup: () => Promise<void>;
}> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'vendor-fixture-'));
  const trees: Record<string, string> = {};
  for (const [version, tree] of Object.entries(UPSTREAM)) {
    const dir = path.join(root, 'upstream', version);
    for (const [rel, text] of Object.entries(tree)) {
      await fsp.mkdir(path.dirname(path.join(dir, 'source', rel)), { recursive: true });
      await fsp.writeFile(path.join(dir, 'source', rel), text);
    }
    trees[version === '1.0.0' ? V1_COMMIT : V2_COMMIT] = dir;
  }
  const kitDir = path.join(root, 'source', 'demo-kit');
  await fsp.mkdir(kitDir, { recursive: true });
  const record = recordFor(files);
  await writeRecord(kitDir, record);
  for (const f of files) await fsp.writeFile(path.join(kitDir, f), headerFor(record, f) + OURS[f]);

  const source: UpstreamSource = {
    latestVersion: async () => '2.0.0',
    versionInfo: async (_pkg, version) => ({
      url: `https://registry.npmjs.org/demo-pkg/-/demo-pkg-${version}.tgz`,
      integrity: `sha512-v${version[0]}`,
    }),
    commitForTag: async (_repo, tag) => {
      if (tag === 'v1.0.0') return V1_COMMIT;
      if (tag === 'v2.0.0') return V2_COMMIT;
      throw new Error(`no tag ${tag}`);
    },
    checkout: async (_repo, commit) => {
      const dir = trees[commit];
      if (!dir) throw new Error(`no commit ${commit}`);
      return { root: dir, cleanup: async () => {} };
    },
  };
  return { root, kitDir, source, cleanup: () => fsp.rm(root, { recursive: true, force: true }) };
}
