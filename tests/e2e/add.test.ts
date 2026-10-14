/**
 * `shardmind add` end to end (#396): `dist/cli.js` installs a base shard,
 * adds an overlay beside it, and the vault holds both at schema 3. Status
 * reports both shards (#406), and update updates both, the base first,
 * each running its own post-update hook (#407).
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

/** A post-update hook that appends its shard's name to `hook-order.log`. */
const ORDER_HOOK =
  `import { appendFile } from 'node:fs/promises';\nimport { join } from 'node:path';\n` +
  `export default async function (ctx: { vaultRoot: string; shard: { name: string } }): Promise<void> {\n` +
  `  await appendFile(join(ctx.vaultRoot, 'hook-order.log'), ctx.shard.name + '\\n');\n}\n`;

/**
 * Give the release a post-update hook that logs its shard's name. Under
 * `.shardmind/hooks/`, which is never installed: at `hooks/` both shards
 * would ship the same vault file, and update refuses that (R2).
 */
async function withOrderHook(work: string): Promise<void> {
  const manifestPath = path.join(work, '.shardmind', 'shard.yaml');
  const manifest = parseYaml(await fs.readFile(manifestPath, 'utf-8')) as Record<string, unknown>;
  manifest['hooks'] = { 'post-update': '.shardmind/hooks/post-update.ts' };
  await fs.writeFile(manifestPath, stringifyYaml(manifest));
  await fs.mkdir(path.join(work, '.shardmind', 'hooks'), { recursive: true });
  await fs.writeFile(path.join(work, '.shardmind', 'hooks', 'post-update.ts'), ORDER_HOOK);
}

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
  const base = (version: string) =>
    buildMutatedShard({
      name: 'base',
      namespace: 'compose',
      version,
      prefix: `base-${version}`,
      outDir: scratch,
      dropHooks: true,
      mutate: async (work) => {
        if (version === '0.1.0') return;
        await fs.appendFile(path.join(work, 'CLAUDE.md'), `\nRelease ${version}.\n`);
        await withOrderHook(work);
      },
    });
  const overlay = (version: string) =>
    buildMutatedShard({
      name: 'research',
      namespace: 'compose',
      version,
      prefix: `research-${version}`,
      outDir: scratch,
      dropHooks: true,
      mutate: async (work) => {
        // Paths of its own only: everything but the engine folder goes.
        for (const entry of await fs.readdir(work)) {
          if (entry !== '.shardmind') await fs.rm(path.join(work, entry), { recursive: true, force: true });
        }
        await fs.mkdir(path.join(work, 'research'), { recursive: true });
        await fs.writeFile(path.join(work, 'research', 'Index.md'), version === '0.1.0' ? '# Research\n' : `# Research ${version}\n`);
        const schemaPath = path.join(work, '.shardmind', 'shard-schema.yaml');
        const schema = parseYaml(await fs.readFile(schemaPath, 'utf-8')) as Record<string, unknown>;
        schema['modules'] = {};
        schema['signals'] = [];
        schema['frontmatter'] = {};
        await fs.writeFile(schemaPath, stringifyYaml(schema));
        if (version !== '0.1.0') await withOrderHook(work);
      },
    });
  const [base1, base2, overlay1, overlay2] = await Promise.all([base('0.1.0'), base('0.2.0'), overlay('0.1.0'), overlay('0.2.0')]);
  stub = await createGitHubStub({
    shards: {
      [BASE]: { versions: { '0.1.0': base1, '0.2.0': base2 }, latest: '0.1.0' },
      [OVERLAY]: { versions: { '0.1.0': overlay1, '0.2.0': overlay2 }, latest: '0.1.0' },
    },
  });
}, 180_000);

afterEach(async () => {
  stub.setLatest(BASE, '0.1.0');
  stub.setLatest(OVERLAY, '0.1.0');
  for (const vault of vaults.splice(0)) await vault.cleanup();
});

afterAll(async () => {
  await stub?.close();
  await cleanupAllVaults();
  if (scratch) await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5 });
});

describe('shardmind add (#396)', () => {
  /** A vault with the base installed and the overlay added, both at 0.1.0. */
  async function composed(prefix: string): Promise<Vault> {
    const vault = await createEmptyVault(prefix);
    vaults.push(vault);
    const values = path.join(scratch, 'values.yaml');
    await fs.writeFile(values, stringifyYaml(VALUES), 'utf-8');
    const install = await run(vault, ['install', `github:${BASE}`, '.', '--yes', '--values', values]);
    expect(install.exitCode, install.stderr).toBe(0);
    const add = await run(vault, ['add', `github:${OVERLAY}`, '--yes']);
    expect(add.exitCode, `${add.stdout}\n${add.stderr}`).toBe(0);
    return vault;
  }

  it('adds an overlay beside an installed shard; status reports both', async () => {
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

    // Status reports both shards (#406).
    const status = await run(vault, []);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain('compose/base');
    expect(status.stdout).toContain('compose/research');
  }, 180_000);

  it('updates both shards, the base first, each running its own post-update hook (#407)', async () => {
    const vault = await composed('e2e-add-update');
    stub.setLatest(BASE, '0.2.0');
    stub.setLatest(OVERLAY, '0.2.0');
    const update = await run(vault, ['update', '--yes']);
    expect(update.exitCode, `${update.stdout}\n${update.stderr}`).toBe(0);
    // One block per shard, in install order.
    const out = update.stdout;
    expect(out.indexOf('compose/base')).toBeGreaterThan(-1);
    expect(out.indexOf('compose/base')).toBeLessThan(out.indexOf('compose/research'));
    const state = JSON.parse(await vault.readFile('.shardmind/state.json')) as { shards: Array<{ shard: string; version: string }> };
    expect(state.shards.map((s) => [s.shard, s.version])).toEqual([
      ['compose/base', '0.2.0'],
      ['compose/research', '0.2.0'],
    ]);
    expect(await vault.readFile('CLAUDE.md')).toContain('Release 0.2.0.');
    expect(await vault.readFile('research/Index.md')).toBe('# Research 0.2.0\n');
    // Each shard's hook ran with its own context, the base's first (R4);
    // the overlay's log is in its own folder.
    expect((await vault.readFile('hook-order.log')).split(/\r?\n/).filter(Boolean)).toEqual(['base', 'research']);
    expect(await vault.exists('.shardmind/logs/compose/research')).toBe(true);
  }, 240_000);

  it('`update --json` answers each shard in shards; `update <shard>` updates that one alone (#407)', async () => {
    const vault = await composed('e2e-add-update-json');
    stub.setLatest(OVERLAY, '0.2.0');
    const one = await run(vault, ['update', 'compose/research', '--yes', '--json']);
    expect(one.exitCode, one.stderr).toBe(0);
    const doc = JSON.parse(one.stdout) as { ok: boolean; result: { shards: Array<{ shard: string }> } };
    expect(doc.ok).toBe(true);
    expect(doc.result.shards.map((s) => s.shard)).toEqual(['compose/research']);
    const state = JSON.parse(await vault.readFile('.shardmind/state.json')) as { shards: Array<{ version: string }> };
    expect(state.shards.map((s) => s.version)).toEqual(['0.1.0', '0.2.0']);

    const unknown = await run(vault, ['update', 'compose/nope', '--json']);
    expect(unknown.exitCode).toBe(1);
    expect((JSON.parse(unknown.stdout) as { error: { code: string } }).error.code).toBe('UPDATE_SHARD_UNKNOWN');
  }, 240_000);

  it('refuses outside a vault, with ADD_NO_INSTALL', async () => {
    const vault = await createEmptyVault('e2e-add-none');
    vaults.push(vault);
    const add = await run(vault, ['add', `github:${OVERLAY}`, '--yes']);
    expect(add.exitCode).toBe(1);
    expect(`${add.stdout}${add.stderr}`).toContain('ADD_NO_INSTALL');
  }, 90_000);
});
