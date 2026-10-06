/**
 * `adopt --from-version` files still at the base release (#325): a file whose
 * bytes equal the base release's render was never changed by the user, so it
 * is `behind`, not `differs`. Spec: docs/SHARD-LAYOUT.md §Adopt semantics,
 * docs/IMPLEMENTATION.md §4.17 (Behind the target).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { baseOutputHashes, classifyAdoption, partitionBehind } from '../../source/core/adopt-planner.js';
import type { ShardManifest, ShardSchema } from '../../source/runtime/types.js';
import { makeShardSource } from '../helpers/index.js';
import { sha256 } from '../../source/core/fs-utils.js';

const FIXED_DATE = new Date('2026-04-25T12:00:00Z');

const schema: ShardSchema = {
  schema_version: 1,
  values: {},
  groups: [{ id: 'setup', label: 'Setup' }],
  modules: {},
  signals: [],
  frontmatter: {},
  migrations: [],
};

const manifest: ShardManifest = { apiVersion: 'v1', name: 'demo', namespace: 'acme', version: '1.0.0', dependencies: [], hooks: {} };

const hash = (text: string): string => sha256(Buffer.from(text, 'utf-8'));

let root: string;
let shard: string;
let vault: string;

beforeEach(async () => {
  root = path.join(os.tmpdir(), `shardmind-adopt-behind-${crypto.randomUUID()}`);
  shard = path.join(root, 'shard');
  vault = path.join(root, 'vault');
  await fsp.mkdir(vault, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

async function vaultFiles(files: Record<string, string | Buffer>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(vault, rel)), { recursive: true });
    await fsp.writeFile(path.join(vault, rel), content);
  }
}

const classify = async (opts: { base?: ReadonlyMap<string, string>; renames?: ReadonlyMap<string, string> } = {}) => {
  const { base, renames } = opts;
  const plan = await classifyAdoption({ vaultRoot: vault, schema, manifest, tempDir: shard, values: {}, selections: {}, now: FIXED_DATE, ...(renames ? { renames } : {}) });
  return base ? partitionBehind(plan, base) : plan;
};

describe('partitionBehind: classifying against a base release (#325)', () => {
  it('a file equal to the base and not the target is behind, not differs', async () => {
    await makeShardSource(shard, { 'a.md': 'new\n' });
    await vaultFiles({ 'a.md': 'old\n' });
    const plan = await classify({ base: new Map([['a.md', hash('old\n')]]) });
    expect(plan.differs).toEqual([]);
    expect(plan.behind.map((c) => c.path)).toEqual(['a.md']);
    const c = plan.behind[0]!;
    if (c.kind !== 'differs') throw new Error('expected differs-shaped');
    expect(c.shardHash).toBe(hash('new\n'));
    expect(c.userHash).toBe(hash('old\n'));
  });

  it("a file the user edited stays differs, whatever the base", async () => {
    await makeShardSource(shard, { 'a.md': 'new\n' });
    await vaultFiles({ 'a.md': 'mine\n' });
    const plan = await classify({ base: new Map([['a.md', hash('old\n')]]) });
    expect(plan.differs.map((c) => c.path)).toEqual(['a.md']);
    expect(plan.behind).toEqual([]);
  });

  it('a base-identical file with no upstream change matches, and is not behind', async () => {
    await makeShardSource(shard, { 'a.md': 'same\n' });
    await vaultFiles({ 'a.md': 'same\n' });
    const plan = await classify({ base: new Map([['a.md', hash('same\n')]]) });
    expect(plan.matches.map((c) => c.path)).toEqual(['a.md']);
    expect(plan.behind).toEqual([]);
  });

  it('without a base, a differing file is differs, as before', async () => {
    await makeShardSource(shard, { 'a.md': 'new\n' });
    await vaultFiles({ 'a.md': 'old\n' });
    const plan = await classify();
    expect(plan.differs.map((c) => c.path)).toEqual(['a.md']);
    expect(plan.behind).toEqual([]);
  });

  it('a file the base does not have stays differs', async () => {
    await makeShardSource(shard, { 'a.md': 'new\n' });
    await vaultFiles({ 'a.md': 'old\n' });
    const plan = await classify({ base: new Map([['other.md', hash('old\n')]]) });
    expect(plan.differs.map((c) => c.path)).toEqual(['a.md']);
  });

  it("a renamed file is compared with the base at its old path, and moves", async () => {
    await makeShardSource(shard, { 'AGENTS.md': 'new\n' });
    await vaultFiles({ 'CLAUDE.md': 'old\n' });
    const plan = await classify({
      base: new Map([['CLAUDE.md', hash('old\n')]]),
      renames: new Map([['CLAUDE.md', 'AGENTS.md']]),
    });
    expect(plan.behind.map((c) => [c.path, c.kind === 'differs' ? c.movedFrom : undefined])).toEqual([['AGENTS.md', 'CLAUDE.md']]);
  });

  it('a binary file at the base is behind, flagged binary', async () => {
    const old = Buffer.from([0, 1, 2, 3, 0, 255]);
    await makeShardSource(shard);
    await fsp.writeFile(path.join(shard, 'img.bin'), Buffer.from([0, 9, 9, 9, 0]));
    await vaultFiles({ 'img.bin': old });
    const plan = await classify({ base: new Map([['img.bin', sha256(old)]]) });
    expect(plan.behind.map((c) => c.path)).toEqual(['img.bin']);
    expect(plan.behind[0]!.kind === 'differs' && plan.behind[0]!.isBinary).toBe(true);
  });

  it('a volatile file matches, base or not', async () => {
    await makeShardSource(shard, { 'log.md.njk': '{# shardmind: volatile #}\nnew\n' });
    await vaultFiles({ 'log.md': 'old\n' });
    const plan = await classify({ base: new Map([['log.md', hash('old\n')]]) });
    expect(plan.matches.map((c) => c.path)).toEqual(['log.md']);
    expect(plan.behind).toEqual([]);
  });
});

describe('baseOutputHashes (#325)', () => {
  it("hashes each output as rendered with the run's values", async () => {
    await makeShardSource(shard, { 'Home.md.njk': 'Hi {{ name }}\n', 'static.md': 'plain\n' });
    const base = await baseOutputHashes({ schema, manifest, tempDir: shard, values: { name: 'Ada' }, selections: {}, now: FIXED_DATE, vaultRoot: vault });
    expect(base.get('Home.md')).toBe(hash('Hi Ada\n'));
    expect(base.get('static.md')).toBe(hash('plain\n'));
  });

  it('leaves out an output that fails to render, and keeps the rest', async () => {
    await makeShardSource(shard, { 'Broken.md.njk': '{{ broken(', 'ok.md': 'ok\n' });
    const base = await baseOutputHashes({ schema, manifest, tempDir: shard, values: {}, selections: {}, now: FIXED_DATE, vaultRoot: vault });
    expect(base.has('Broken.md')).toBe(false);
    expect(base.get('ok.md')).toBe(hash('ok\n'));
  });

  it('a value that differs from the clone renders another base, so the file stays differs', async () => {
    await makeShardSource(shard, { 'Home.md.njk': 'Hi {{ name }}, v2\n' });
    const baseShard = path.join(root, 'base');
    await makeShardSource(baseShard, { 'Home.md.njk': 'Hi {{ name }}\n' });
    // Cloned with name Ada; this adopt resolves name Bob.
    await vaultFiles({ 'Home.md': 'Hi Ada\n' });
    const base = await baseOutputHashes({ schema, manifest, tempDir: baseShard, values: { name: 'Bob' }, selections: {}, now: FIXED_DATE, vaultRoot: vault });
    const plan = partitionBehind(
      await classifyAdoption({ vaultRoot: vault, schema, manifest, tempDir: shard, values: { name: 'Bob' }, selections: {}, now: FIXED_DATE }),
      base,
    );
    expect(plan.differs.map((c) => c.path)).toEqual(['Home.md']);
    expect(plan.behind).toEqual([]);
  });
});
