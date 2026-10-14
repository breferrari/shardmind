/**
 * `runUpdate` with a target (#407): an overlay updated beside a base shard,
 * from and into its own cache, values file and `state.json` entry, on a
 * transaction scoped to it. Spec: docs/IMPLEMENTATION.md §4.12 step 5,
 * §4.28 step 1; ARCHITECTURE §10.5.
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
import { readVaultState, shardLayout } from '../../source/core/state.js';
import { shardStateOf } from '../../source/runtime/state-schema.js';
import { detectDrift, foreignPathsOf } from '../../source/core/drift.js';
import { planUpdate, renderNewShard } from '../../source/core/update-planner.js';
import { runUpdate } from '../../source/core/update-executor.js';
import { buildRenderContext } from '../../source/core/renderer.js';
import type { ResolvedShard, VaultState } from '../../source/runtime/types.js';
import { makeShardSource } from '../helpers/make-shard-source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MINIMAL_SHARD = path.resolve(__dirname, '../../examples/minimal-shard');
const BASE_VALUES = { user_name: 'Alice', org_name: 'Acme Labs', vault_purpose: 'engineering' as const, qmd_enabled: true };

const manifestYaml = (version: string) =>
  ['apiVersion: v1', 'name: research', 'namespace: acme', `version: ${version}`, 'description: "An overlay"', 'persona: "Researchers"', 'license: MIT', ''].join('\n');
const SCHEMA_YAML = [
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
let scratch: string;

async function overlaySource(version: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(scratch, `overlay-${version}`);
  await makeShardSource(dir, files);
  await fsp.writeFile(path.join(dir, '.shardmind', 'shard.yaml'), manifestYaml(version));
  await fsp.writeFile(path.join(dir, '.shardmind', 'shard-schema.yaml'), SCHEMA_YAML);
  return dir;
}

beforeEach(async () => {
  vault = path.join(os.tmpdir(), `shardmind-update-composed-${crypto.randomUUID()}`);
  scratch = path.join(os.tmpdir(), `shardmind-update-composed-src-${crypto.randomUUID()}`);
  await fsp.mkdir(vault, { recursive: true });

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

  const v1 = await overlaySource('1.0.0', { 'research/Papers.md.njk': '# Papers\n\nOn {{ topic }}.\n' });
  const oManifest = await parseManifest(path.join(v1, '.shardmind', 'shard.yaml'));
  const oSchema = await parseSchema(path.join(v1, '.shardmind', 'shard-schema.yaml'));
  await runAddTransaction({
    vaultRoot: vault,
    manifest: oManifest,
    schema: oSchema,
    tempDir: v1,
    resolved: { namespace: 'acme', name: 'research', version: '1.0.0', source: 'github:acme/research', tarballUrl: 'n/a' },
    tarballSha256: 'overlay-sha-1',
    values: { topic: 'optics' },
    selections: defaultModuleSelections(oSchema),
    moveAside: [],
    keep: new Set(),
  });
});

afterEach(async () => {
  await fsp.rm(vault, { recursive: true, force: true });
  await fsp.rm(scratch, { recursive: true, force: true });
});

const read = (rel: string) => fsp.readFile(path.join(vault, rel), 'utf-8');

/** Update the overlay (index 1) to `v2`'s release, as the flow does for one shard of several. */
async function updateOverlay(v2: string, opts: { failOnFirstFile?: boolean } = {}) {
  const vaultState = (await readVaultState(vault))!;
  const index = 1;
  const states = vaultState.shards.map((entry) => shardStateOf(entry, 2));
  const state = states[index]!;
  const layout = shardLayout(state.shard, index)!;
  const manifest = await parseManifest(path.join(v2, '.shardmind', 'shard.yaml'));
  const schema = await parseSchema(path.join(v2, '.shardmind', 'shard-schema.yaml'));
  const values = { topic: 'optics' };
  const selections = state.modules;
  const renderContext = buildRenderContext(manifest, values, selections, undefined, vault);
  const drift = await detectDrift(vault, state, { cacheDir: layout.cacheDir, foreign: foreignPathsOf(states, index) });
  const filePlan = await renderNewShard(schema, v2, selections, renderContext);
  const plan = await planUpdate({
    vault: { root: vault, state, drift, cacheDir: layout.cacheDir },
    values: { old: values, new: values },
    newShard: { schema, selections, tempDir: v2, renderContext, filePlan },
    removedFileDecisions: {},
  });
  return runUpdate({
    vaultRoot: vault,
    plan,
    conflictResolutions: {},
    currentState: state,
    newManifest: manifest,
    newSchema: schema,
    newValues: values,
    newSelections: selections,
    resolved: { namespace: 'acme', name: 'research', version: manifest.version, source: 'github:acme/research', tarballUrl: 'n/a' },
    tarballSha256: 'overlay-sha-2',
    newTempDir: v2,
    target: { index, layout, composed: true },
    onProgress: opts.failOnFirstFile
      ? (ev) => {
          if (ev.kind === 'file') throw new Error('disk gave out');
        }
      : undefined,
  });
}

describe('runUpdate on one shard of several (#407)', () => {
  it("rewrites the overlay's files, cache, values and entry; leaves the base's as they were", async () => {
    const before = JSON.parse(await read('.shardmind/state.json')) as VaultState;
    const baseCache = await read('.shardmind/shard.yaml');
    const baseValues = await read('shard-values.yaml');
    const v2 = await overlaySource('2.0.0', { 'research/Papers.md.njk': '# Papers\n\nOn {{ topic }}, v2.\n', 'research/New.md': 'new\n' });

    await updateOverlay(v2);

    expect(await read('research/Papers.md')).toBe('# Papers\n\nOn optics, v2.\n');
    expect(await read('research/New.md')).toBe('new\n');
    expect(await read('.shardmind/shards/acme/research/shard.yaml')).toContain('version: 2.0.0');
    expect(await read('.shardmind/shards/acme/research/templates/research/Papers.md.njk')).toContain('v2');
    expect(await read('shard-values.acme.research.yaml')).toBe('topic: optics\n');
    const after = JSON.parse(await read('.shardmind/state.json')) as VaultState;
    expect(after.schema_version).toBe(3);
    expect(after.shards[0]).toEqual(before.shards[0]);
    expect(after.shards[1]).toMatchObject({ shard: 'acme/research', version: '2.0.0', tarball_sha256: 'overlay-sha-2' });
    expect(after.shards[1]).not.toHaveProperty('schema_version');
    expect(Object.keys(after.shards[1]!.files).sort()).toEqual(['research/New.md', 'research/Papers.md']);
    // The base's cache and values are not the overlay's to write.
    expect(await read('.shardmind/shard.yaml')).toBe(baseCache);
    expect(await read('shard-values.yaml')).toBe(baseValues);
  });

  it("rolls back the overlay alone: its cache, values and entry back, the base's untouched", async () => {
    const stateBefore = await read('.shardmind/state.json');
    const overlayCacheBefore = await read('.shardmind/shards/acme/research/shard.yaml');
    const v2 = await overlaySource('2.0.0', { 'research/Papers.md.njk': '# Papers\n\nOn {{ topic }}, v2.\n' });

    await expect(updateOverlay(v2, { failOnFirstFile: true })).rejects.toThrow(/disk gave out/);

    expect(await read('.shardmind/state.json')).toBe(stateBefore);
    expect(await read('.shardmind/shards/acme/research/shard.yaml')).toBe(overlayCacheBefore);
    expect(await read('research/Papers.md')).toBe('# Papers\n\nOn optics.\n');
  });
});
