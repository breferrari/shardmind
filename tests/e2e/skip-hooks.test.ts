/**
 * `--skip-hooks` end to end (#199): install, update and adopt run no hook,
 * report each declared hook as skipped, and record no bootstrap fingerprint,
 * so the next run with hooks performs bootstrap (Invariant 4).
 *
 * The shard's hooks leave marker files in the vault: a marker's absence is
 * the proof a hook did not run.
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

const SLUG = 'skiphooks/hooked';
const REF = `github:${SLUG}`;
const VALUES = { user_name: 'Alice', org_name: 'Acme Labs', vault_purpose: 'engineering', qmd_enabled: true };

let stub: GitHubStub;
let scratch: string;
const vaults: Vault[] = [];

const env = () => ({ SHARDMIND_GITHUB_API_BASE: stub.url, SHARDMIND_NO_UPDATE_CHECK: '1' });

/** A hook that writes its slot's marker file into the vault. */
const markerHook = (file: string) =>
  `import { writeFile } from 'node:fs/promises';\nimport { join } from 'node:path';\n` +
  `export default async function (ctx: { vaultRoot: string }): Promise<void> {\n` +
  `  await writeFile(join(ctx.vaultRoot, ${JSON.stringify(file)}), 'ran');\n}\n`;

async function run(vault: Vault, args: string[]): Promise<CliResult> {
  return spawnCli(args, { cwd: vault.root, env: env(), timeoutMs: 90_000 });
}

async function fingerprint(vault: Vault): Promise<unknown> {
  const state = JSON.parse(await fs.readFile(path.join(vault.root, '.shardmind', 'state.json'), 'utf-8')) as Record<string, unknown>;
  return state['bootstrap_fingerprint'];
}

async function pending(vault: Vault): Promise<unknown> {
  const state = JSON.parse(await fs.readFile(path.join(vault.root, '.shardmind', 'state.json'), 'utf-8')) as Record<string, unknown>;
  return state['bootstrap_pending'];
}

async function newVault(prefix: string): Promise<{ vault: Vault; values: string }> {
  const vault = await createEmptyVault(prefix);
  vaults.push(vault);
  const values = path.join(scratch, `${prefix}-values.yaml`);
  await fs.writeFile(values, stringifyYaml(VALUES), 'utf-8');
  return { vault, values };
}

/** stdout is one JSON document. */
function documentOf(result: CliResult): { ok: boolean; result: { hooks: unknown[]; durationMs: number } } {
  expect(result.stdout.endsWith('}\n'), `exit=${result.exitCode}\n${result.stdout}\n${result.stderr}`).toBe(true);
  return JSON.parse(result.stdout) as { ok: boolean; result: { hooks: unknown[]; durationMs: number } };
}

beforeAll(async () => {
  await ensureBuilt();
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'shardmind-e2e-skip-hooks-'));
  const hooked = (version: string) =>
    buildMutatedShard({
      name: 'hooked',
      namespace: 'skiphooks',
      version,
      prefix: `skip-hooks-${version}`,
      outDir: scratch,
      mutate: async (work) => {
        const manifestPath = path.join(work, '.shardmind', 'shard.yaml');
        const manifest = parseYaml(await fs.readFile(manifestPath, 'utf-8')) as Record<string, unknown>;
        manifest['hooks'] = {
          bootstrap: { script: 'hooks/bootstrap.ts', fingerprint: 'v1' },
          personalize: 'hooks/personalize.ts',
          'post-update': 'hooks/post-update.ts',
        };
        await fs.writeFile(manifestPath, stringifyYaml(manifest), 'utf-8');
        await fs.mkdir(path.join(work, 'hooks'), { recursive: true });
        await fs.writeFile(path.join(work, 'hooks', 'bootstrap.ts'), markerHook('bootstrapped.txt'), 'utf-8');
        await fs.writeFile(path.join(work, 'hooks', 'personalize.ts'), markerHook('personalized.txt'), 'utf-8');
        await fs.writeFile(path.join(work, 'hooks', 'post-update.ts'), markerHook('updated.txt'), 'utf-8');
        if (version === '0.2.0') await fs.writeFile(path.join(work, 'brain', 'Changelog.md'), '# Changelog\n', 'utf-8');
      },
    });
  const [v1, v2] = await Promise.all([hooked('0.1.0'), hooked('0.2.0')]);
  stub = await createGitHubStub({ shards: { [SLUG]: { versions: { '0.1.0': v1, '0.2.0': v2 }, latest: '0.1.0' } } });
}, 180_000);

afterEach(async () => {
  stub.setLatest(SLUG, '0.1.0');
  for (const vault of vaults.splice(0)) await vault.cleanup();
});

afterAll(async () => {
  await stub?.close();
  await cleanupAllVaults();
  if (scratch) await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5 });
});

describe('--skip-hooks (#199)', () => {
  it('install runs no hook and owes the bootstrap; a plain update, already up to date, runs it', async () => {
    const { vault, values } = await newVault('skip-install');
    const install = await run(vault, ['install', REF, '.', '--yes', '--values', values, '--skip-hooks']);
    expect(install.exitCode, install.stderr).toBe(0);
    expect(await vault.exists('bootstrapped.txt')).toBe(false);
    expect(await vault.exists('personalized.txt')).toBe(false);
    expect(install.stdout).toContain('Bootstrap hook skipped (--skip-hooks).');
    expect(install.stdout).toContain('Personalize hook skipped (--skip-hooks).');
    expect(await fingerprint(vault)).toBeUndefined();
    expect(await pending(vault)).toBe(true);

    // Ruling (c): still on 0.1.0, nothing to update, yet the owed bootstrap runs.
    const update = await run(vault, ['update', '--yes']);
    expect(update.exitCode, update.stderr).toBe(0);
    expect(update.stdout).toMatch(/up to date/i);
    expect(await vault.exists('bootstrapped.txt')).toBe(true);
    expect(await pending(vault)).toBeUndefined();
    expect(await fingerprint(vault)).toBe('v1');
    // A skipped personalize is skipped for good: update never runs it.
    expect(await vault.exists('personalized.txt')).toBe(false);
  }, 120_000);

  it('an up-to-date update --json reports the owed bootstrap it ran', async () => {
    const { vault, values } = await newVault('skip-uptodate-json');
    const install = await run(vault, ['install', REF, '.', '--yes', '--values', values, '--skip-hooks']);
    expect(install.exitCode, install.stderr).toBe(0);
    const doc = documentOf(await run(vault, ['update', '--json']));
    expect(doc.ok).toBe(true);
    expect(doc.result.hooks).toEqual([{ slot: 'bootstrap', outcome: 'completed', exitCode: 0 }]);
    // The hook ran, so the run took time (a run with nothing to do reports 0).
    expect(doc.result.durationMs).toBeGreaterThan(0);
    expect(await vault.exists('bootstrapped.txt')).toBe(true);
    expect(await pending(vault)).toBeUndefined();
  }, 120_000);

  it('an up-to-date update --dry-run --json carries no hooks and keeps the bootstrap owed', async () => {
    const { vault, values } = await newVault('skip-uptodate-dry-json');
    const install = await run(vault, ['install', REF, '.', '--yes', '--values', values, '--skip-hooks']);
    expect(install.exitCode, install.stderr).toBe(0);
    const result = await run(vault, ['update', '--dry-run', '--json']);
    const doc = JSON.parse(result.stdout) as { ok: boolean; result: Record<string, unknown> };
    expect(doc.ok, result.stderr).toBe(true);
    expect(doc.result['upToDate']).toBe(true);
    // The terminal previews the owed bootstrap; a dry-run document carries no hooks (OPERATIONS §--json).
    expect(doc.result).not.toHaveProperty('hooks');
    expect(await vault.exists('bootstrapped.txt')).toBe(false);
    expect(await pending(vault)).toBe(true);
  }, 120_000);

  it('update --json --skip-hooks reports bootstrap and post-update skipped with the reason, and keeps the fingerprint', async () => {
    const { vault, values } = await newVault('skip-update');
    const install = await run(vault, ['install', REF, '.', '--yes', '--values', values]);
    expect(install.exitCode, install.stderr).toBe(0);
    expect(await fingerprint(vault)).toBe('v1');
    await fs.rm(path.join(vault.root, 'bootstrapped.txt'));

    stub.setLatest(SLUG, '0.2.0');
    const doc = documentOf(await run(vault, ['update', '--json', '--skip-hooks']));
    expect(doc.ok).toBe(true);
    expect(doc.result.hooks).toEqual([
      { slot: 'bootstrap', outcome: 'skipped', reason: 'skip-hooks' },
      { slot: 'post-update', outcome: 'skipped', reason: 'skip-hooks' },
    ]);
    expect(await vault.exists('updated.txt')).toBe(false);
    expect(await vault.exists('bootstrapped.txt')).toBe(false);
    expect(await fingerprint(vault)).toBe('v1');
  }, 120_000);

  it('adopt --json --skip-hooks reports each install-side hook skipped, and owes the bootstrap', async () => {
    const { vault, values } = await newVault('skip-adopt');
    const doc = documentOf(await run(vault, ['adopt', REF, '--json', '--yes', '--values', values, '--skip-hooks']));
    expect(doc.ok).toBe(true);
    expect(doc.result.hooks).toEqual([
      { slot: 'bootstrap', outcome: 'skipped', reason: 'skip-hooks' },
      { slot: 'personalize', outcome: 'skipped', reason: 'skip-hooks' },
    ]);
    expect(await vault.exists('bootstrapped.txt')).toBe(false);
    expect(await fingerprint(vault)).toBeUndefined();
    expect(await pending(vault)).toBe(true);
  }, 120_000);
});
