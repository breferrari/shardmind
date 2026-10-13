/**
 * `shardmind add` end to end (#396): `dist/cli.js` installs a base shard,
 * adds an overlay beside it, and the vault holds both at schema 3. Until
 * status and update run across shards (#397), both refuse the composed vault
 * with the several-shards message; this pins that interim.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ensureBuilt } from './helpers/build-once.js';
import { createGitHubStub, type GitHubStub } from './helpers/github-stub.js';
import { spawnCli, type CliResult } from './helpers/spawn-cli.js';
import { createEmptyVault, cleanupAllVaults, type Vault } from './helpers/vault.js';
import { buildMutatedShard } from './tui/helpers/build-fixture-shard.js';

const BASE = 'compose/base';
const OVERLAY = 'compose/research';
const VALUES = { user_name: 'Alice', org_name: 'Acme Labs', vault_purpose: 'engineering', qmd_enabled: true };

let stub: GitHubStub;
let scratch: string;
const vaults: Vault[] = [];
const env = () => ({ SHARDMIND_GITHUB_API_BASE: stub.url, SHARDMIND_NO_UPDATE_CHECK: '1' });

async function run(vault: Vault, args: string[]): Promise<CliResult> {
  return spawnCli(args, { cwd: vault.root, env: env(), timeoutMs: 90_000 });
}

beforeAll(async () => {
  await ensureBuilt();
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'shardmind-e2e-add-'));
  const base = await buildMutatedShard({ name: 'base', namespace: 'compose', version: '0.1.0', prefix: 'base-0.1.0', outDir: scratch, dropHooks: true, mutate: async () => {} });
  const overlay = await buildMutatedShard({
    name: 'research',
    namespace: 'compose',
    version: '0.1.0',
    prefix: 'research-0.1.0',
    outDir: scratch,
    dropHooks: true,
    mutate: async (work) => {
      // Paths of its own only: everything but the engine folder goes.
      for (const entry of await fs.readdir(work)) {
        if (entry !== '.shardmind') await fs.rm(path.join(work, entry), { recursive: true, force: true });
      }
      await fs.mkdir(path.join(work, 'research'), { recursive: true });
      await fs.writeFile(path.join(work, 'research', 'Index.md'), '# Research\n');
      const schemaPath = path.join(work, '.shardmind', 'shard-schema.yaml');
      const schema = parseYaml(await fs.readFile(schemaPath, 'utf-8')) as Record<string, unknown>;
      schema['modules'] = {};
      schema['signals'] = [];
      schema['frontmatter'] = {};
      await fs.writeFile(schemaPath, stringifyYaml(schema));
    },
  });
  stub = await createGitHubStub({
    shards: {
      [BASE]: { versions: { '0.1.0': base }, latest: '0.1.0' },
      [OVERLAY]: { versions: { '0.1.0': overlay }, latest: '0.1.0' },
    },
  });
}, 180_000);

afterEach(async () => {
  for (const vault of vaults.splice(0)) await vault.cleanup();
});

afterAll(async () => {
  await stub?.close();
  await cleanupAllVaults();
  if (scratch) await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5 });
});

describe('shardmind add (#396)', () => {
  it('adds an overlay beside an installed shard; status and update refuse the composed vault until #397', async () => {
    const vault = await createEmptyVault('e2e-add');
    vaults.push(vault);
    const values = path.join(scratch, 'values.yaml');
    await fs.writeFile(values, stringifyYaml(VALUES), 'utf-8');
    const install = await run(vault, ['install', `github:${BASE}`, '.', '--yes', '--values', values]);
    expect(install.exitCode, install.stderr).toBe(0);

    const add = await run(vault, ['add', `github:${OVERLAY}`, '--yes']);
    expect(add.exitCode, `${add.stdout}\n${add.stderr}`).toBe(0);
    expect(add.stdout).toContain('Added compose/research@0.1.0 beside compose/base');

    const state = JSON.parse(await vault.readFile('.shardmind/state.json')) as { schema_version: number; shards: Array<{ shard: string }> };
    expect(state.schema_version).toBe(3);
    expect(state.shards.map((s) => s.shard)).toEqual(['compose/base', 'compose/research']);
    expect(await vault.readFile('research/Index.md')).toBe('# Research\n');
    expect(await vault.exists('shard-values.compose.research.yaml')).toBe(true);

    for (const args of [[], ['update', '--yes']]) {
      const refused = await run(vault, args);
      expect(`${refused.stdout}${refused.stderr}`.replace(/\s+/g, ' ')).toContain('several shards');
    }
  }, 180_000);

  it('refuses outside a vault, with ADD_NO_INSTALL', async () => {
    const vault = await createEmptyVault('e2e-add-none');
    vaults.push(vault);
    const add = await run(vault, ['add', `github:${OVERLAY}`, '--yes']);
    expect(add.exitCode).toBe(1);
    expect(`${add.stdout}${add.stderr}`).toContain('ADD_NO_INSTALL');
  }, 90_000);
});
