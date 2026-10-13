/**
 * Status on a vault holding several shards (#406): each shard's own report,
 * the base's at the top as before. Spec: ARCHITECTURE §10.2 / §10.3a,
 * IMPLEMENTATION §4.14.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { buildStatusReport } from '../../source/core/status.js';
import { statusResult } from '../../source/core/json-output.js';
import { writeVaultState } from '../../source/core/state.js';
import { sha256 } from '../../source/core/fs-utils.js';
import type { ShardEntry } from '../../source/runtime/types.js';
import { makeShardState } from '../helpers/index.js';

const MINIMAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../examples/minimal-shard/.shardmind');
const VALUES = { user_name: 'Alice', org_name: 'Acme', vault_purpose: 'engineering', qmd_enabled: false };

let vault: string;

beforeEach(async () => {
  vault = path.join(os.tmpdir(), `shardmind-status-composed-${crypto.randomUUID()}`);
  await fsp.mkdir(vault, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(vault, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<string> {
  await fsp.mkdir(path.dirname(path.join(vault, rel)), { recursive: true });
  await fsp.writeFile(path.join(vault, rel), content);
  return sha256(content);
}

/** A cached manifest and schema for a shard, at `cacheDir`. */
async function cache(cacheDir: string, over: Record<string, unknown>): Promise<void> {
  const manifest = parseYaml(await fsp.readFile(path.join(MINIMAL, 'shard.yaml'), 'utf-8')) as Record<string, unknown>;
  await write(path.join(cacheDir, 'shard.yaml'), stringifyYaml({ ...manifest, ...over }));
  await write(path.join(cacheDir, 'shard-schema.yaml'), await fsp.readFile(path.join(MINIMAL, 'shard-schema.yaml'), 'utf-8'));
}

const entry = (shard: string, version: string, files: Record<string, string>): ShardEntry => {
  const { schema_version: _v, ...rest } = makeShardState({
    shard,
    version,
    source: `github:${shard}`,
    files: Object.fromEntries(Object.entries(files).map(([p, hash]) => [p, { template: null, rendered_hash: hash, ownership: 'managed' as const }])),
  });
  return rest;
};

/** A base (shardmind/minimal 0.1.0) and an overlay (acme/research 1.2.0) sharing the notes/ folder. */
async function composedVault(): Promise<void> {
  const home = await write('Home.md', 'home\n');
  const baseNote = await write('notes/Base.md', 'base note\n');
  const index = await write('research/Index.md', 'index\n');
  const shared = await write('notes/Research.md', 'research note\n');
  await cache('.shardmind', {});
  await cache('.shardmind/shards/acme/research', { name: 'research', namespace: 'acme', version: '1.2.0' });
  await write('shard-values.yaml', stringifyYaml(VALUES));
  await write('shard-values.acme.research.yaml', stringifyYaml(VALUES));
  await writeVaultState(vault, {
    schema_version: 3,
    shards: [
      entry('shardmind/minimal', '0.1.0', { 'Home.md': home, 'notes/Base.md': baseNote }),
      entry('acme/research', '1.2.0', { 'research/Index.md': index, 'notes/Research.md': shared }),
    ],
  });
}

const report = () => buildStatusReport(vault, { verbose: false, skipUpdateCheck: true });

describe('status on a vault holding several shards (#406)', () => {
  it('reports each shard, the base first, the top level being the base', async () => {
    await composedVault();
    const r = (await report())!;
    expect(r.shards!.map((s) => [`${s.manifest.namespace}/${s.manifest.name}`, s.manifest.version])).toEqual([
      ['shardmind/minimal', '0.1.0'],
      ['acme/research', '1.2.0'],
    ]);
    expect(r.manifest.name).toBe('minimal');
    expect(r.drift.managed).toBe(2);
    expect(r.shards![1]!.drift.managed).toBe(2);
  });

  it("counts an edited overlay file as the overlay's, not the base's", async () => {
    await composedVault();
    await write('research/Index.md', 'edited\n');
    const r = (await report())!;
    expect(r.drift.modified).toBe(0);
    expect(r.shards![1]!.drift.modifiedPaths).toEqual(['research/Index.md']);
  });

  it("reads no other shard's file, nor any values file, as a shard's orphan", async () => {
    await composedVault();
    await write('notes/Mine.md', 'my own\n');
    const r = (await report())!;
    expect(r.drift.orphanedPaths).toEqual(['notes/Mine.md']);
    expect(r.shards![1]!.drift.orphanedPaths).toEqual(['notes/Mine.md']);
  });

  it("degrades only the overlay's block when its cache is gone", async () => {
    await composedVault();
    await fsp.rm(path.join(vault, '.shardmind', 'shards'), { recursive: true });
    const r = (await report())!;
    expect(r.shards![0]!.warnings).toEqual([]);
    expect(r.shards![1]!.warnings.map((w) => w.message).join('\n')).toMatch(/Cached shard manifest/);
    // Named at the top level too.
    expect(r.warnings.map((w) => w.message).join('\n')).toMatch(/acme\/research: Cached shard manifest/);
  });

  it('--json lists each shard; the top-level fields stay the base\'s', async () => {
    await composedVault();
    const doc = statusResult(await report());
    if (!doc.installed) throw new Error('expected installed');
    expect(doc.shard).toBe('shardmind/minimal');
    expect(doc.shards.map((s) => [s.shard, s.version])).toEqual([
      ['shardmind/minimal', '0.1.0'],
      ['acme/research', '1.2.0'],
    ]);
    expect(doc.shards[0]).not.toHaveProperty('environment');
  });

  it('a one-shard vault lists itself, and its top-level fields are as before', async () => {
    const home = await write('Home.md', 'home\n');
    await cache('.shardmind', {});
    await write('shard-values.yaml', stringifyYaml(VALUES));
    await writeVaultState(vault, { schema_version: 3, shards: [entry('shardmind/minimal', '0.1.0', { 'Home.md': home })] });
    const doc = statusResult(await report());
    if (!doc.installed) throw new Error('expected installed');
    expect(doc.shards).toHaveLength(1);
    const { shards: _s, installed: _i, environment: _e, ...top } = doc;
    const { warnings: w0, ...first } = doc.shards[0]!;
    expect({ ...first, warnings: w0 }).toEqual(top);
  });
});
