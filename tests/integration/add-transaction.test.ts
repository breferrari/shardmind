/**
 * `runAddTransaction` (#396): an overlay installed beside a base shard, on
 * the `add` transaction. Spec: docs/IMPLEMENTATION.md §4.28 step 1b,
 * §4.30 step 10; ARCHITECTURE §10.4a.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { parseManifest } from '../../source/core/manifest.js';
import { parseSchema, buildValuesValidator } from '../../source/core/schema.js';
import { defaultModuleSelections, resolveComputedDefaults } from '../../source/core/install-planner.js';
import { runInstall, runAddTransaction } from '../../source/core/install-executor.js';
import type { ResolvedShard, VaultState } from '../../source/runtime/types.js';
import { makeShardSource } from '../helpers/make-shard-source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MINIMAL_SHARD = path.resolve(__dirname, '../../examples/minimal-shard');
const BASE_VALUES = { user_name: 'Alice', org_name: 'Acme Labs', vault_purpose: 'engineering' as const, qmd_enabled: true };

const OVERLAY_MANIFEST = [
  'apiVersion: v1',
  'name: research',
  'namespace: acme',
  'version: 1.0.0',
  'description: "An overlay"',
  'persona: "Researchers"',
  'license: MIT',
  '',
].join('\n');
const OVERLAY_SCHEMA = [
  'schema_version: 1',
  'values:',
  '  topic:',
  '    type: string',
  '    message: Topic',
  '    default: physics',
  '    group: setup',
  'groups:',
  '  - id: setup',
  '    label: Setup',
  '',
].join('\n');

let vault: string;
let overlaySrc: string;

beforeEach(async () => {
  vault = path.join(os.tmpdir(), `shardmind-add-tx-${crypto.randomUUID()}`);
  overlaySrc = path.join(os.tmpdir(), `shardmind-add-src-${crypto.randomUUID()}`);
  await fsp.mkdir(vault, { recursive: true });
  await makeShardSource(overlaySrc, {
    'research/Papers.md.njk': 'Papers on {{ topic }}\n',
  });
  await fsp.writeFile(path.join(overlaySrc, '.shardmind', 'shard.yaml'), OVERLAY_MANIFEST);
  await fsp.writeFile(path.join(overlaySrc, '.shardmind', 'shard-schema.yaml'), OVERLAY_SCHEMA);

  // The base shard, installed as install does.
  const manifest = await parseManifest(path.join(MINIMAL_SHARD, '.shardmind', 'shard.yaml'));
  const schema = await parseSchema(path.join(MINIMAL_SHARD, '.shardmind', 'shard-schema.yaml'));
  const resolved: ResolvedShard = { namespace: 'shardmind', name: 'minimal', version: '0.1.0', source: 'github:shardmind/minimal', tarballUrl: 'n/a' };
  await runInstall({
    vaultRoot: vault,
    manifest,
    schema,
    tempDir: MINIMAL_SHARD,
    resolved,
    tarballSha256: 'base-sha',
    values: buildValuesValidator(schema).parse(resolveComputedDefaults(schema, BASE_VALUES)),
    selections: defaultModuleSelections(schema),
  });
});

afterEach(async () => {
  await fsp.rm(vault, { recursive: true, force: true });
  await fsp.rm(overlaySrc, { recursive: true, force: true });
});

async function addOverlay(over: { signal?: AbortSignal; dryRun?: boolean } = {}) {
  const manifest = await parseManifest(path.join(overlaySrc, '.shardmind', 'shard.yaml'));
  const schema = await parseSchema(path.join(overlaySrc, '.shardmind', 'shard-schema.yaml'));
  return runAddTransaction({
    vaultRoot: vault,
    manifest,
    schema,
    tempDir: overlaySrc,
    resolved: { namespace: 'acme', name: 'research', version: '1.0.0', source: 'github:acme/research', tarballUrl: 'n/a' },
    tarballSha256: 'overlay-sha',
    values: { topic: 'optics' },
    selections: defaultModuleSelections(schema),
    moveAside: [],
    keep: new Set(),
    ...over,
  });
}

const read = (rel: string) => fsp.readFile(path.join(vault, rel), 'utf-8');
const exists = (rel: string) => fsp.access(path.join(vault, rel)).then(() => true, () => false);

describe('runAddTransaction (#396)', () => {
  it('appends the overlay to shards[]: schema 3, the base entry as it was, its cache and values at the reserved paths', async () => {
    const before = JSON.parse(await read('.shardmind/state.json')) as Record<string, unknown>;
    await addOverlay();
    const raw = JSON.parse(await read('.shardmind/state.json')) as VaultState;
    expect(raw.schema_version).toBe(3);
    expect(raw.shards.map((s) => s.shard)).toEqual(['shardmind/minimal', 'acme/research']);
    const { schema_version: _v, ...baseEntry } = before;
    expect(raw.shards[0]).toEqual(baseEntry);
    expect(raw.shards[1]!.files['research/Papers.md']).toMatchObject({ ownership: 'managed' });
    expect(await read('research/Papers.md')).toBe('Papers on optics\n');
    expect(await exists('.shardmind/shards/acme/research/shard.yaml')).toBe(true);
    expect(await exists('.shardmind/shards/acme/research/shard-schema.yaml')).toBe(true);
    expect(await exists('.shardmind/shards/acme/research/templates/research/Papers.md.njk')).toBe(true);
    expect(await read('shard-values.acme.research.yaml')).toBe('topic: optics\n');
    // The base's values and cache are untouched.
    expect(await read('shard-values.yaml')).toContain('Alice');
    expect(await exists('.shardmind/shard.yaml')).toBe(true);
  });

  it('rolls back a cancelled add: state.json byte for byte, nothing of the overlay left', async () => {
    const stateBefore = await read('.shardmind/state.json');
    const abort = new AbortController();
    abort.abort();
    await expect(addOverlay({ signal: abort.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(await read('.shardmind/state.json')).toBe(stateBefore);
    expect(await exists('research')).toBe(false);
    expect(await exists('.shardmind/shards')).toBe(false);
    expect(await exists('shard-values.acme.research.yaml')).toBe(false);
  });

  it('rolls back an add that fails while writing the overlay', async () => {
    const stateBefore = await read('.shardmind/state.json');
    // A folder where the overlay writes its values file: the exclusive
    // write fails after its files and cache were written.
    await fsp.mkdir(path.join(vault, 'shard-values.acme.research.yaml'));
    await expect(addOverlay()).rejects.toBeTruthy();
    expect(await read('.shardmind/state.json')).toBe(stateBefore);
    expect(await exists('research')).toBe(false);
    expect(await exists('.shardmind/shards')).toBe(false);
    // The folder in the way is the user's: left.
    expect(await exists('shard-values.acme.research.yaml')).toBe(true);
  });

  it('a dry run writes nothing', async () => {
    const stateBefore = await read('.shardmind/state.json');
    await addOverlay({ dryRun: true });
    expect(await read('.shardmind/state.json')).toBe(stateBefore);
    expect(await exists('research')).toBe(false);
    expect(await exists('.shardmind/shards')).toBe(false);
  });
});
