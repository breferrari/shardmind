/**
 * `update --dry-run --json` never stops for an answer it cannot get (#230).
 * At a decision the update would prompt for, it writes one JSON failure
 * document naming it (UPDATE_JSON_NEEDS_ANSWERS) instead of writing nothing.
 * `--yes` answers both reachable decisions. (New required values cannot be
 * reached with a valid schema: every value declares a default.)
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ensureBuilt } from './helpers/build-once.js';
import { createGitHubStub, type GitHubStub } from './helpers/github-stub.js';
import { spawnCli } from './helpers/spawn-cli.js';
import { createInstalledVault, cleanupAllVaults, type Vault } from './helpers/vault.js';
import { buildMutatedShard } from './tui/helpers/build-fixture-shard.js';

const VALUES = { user_name: 'Alice', org_name: 'Acme Labs', vault_purpose: 'engineering', qmd_enabled: true };

let stub: GitHubStub;
let outDir: string;
const vaults: Vault[] = [];

interface Fixture {
  slug: string;
  v01: string;
  v02: string;
}

/** A shard whose 0.2.0 is 0.1.0 plus `change`. */
async function fixture(slug: string, change: (workDir: string) => Promise<void>): Promise<Fixture> {
  const name = slug.split('/')[1]!;
  const base = { name, namespace: 'jsontest', outDir, dropHooks: true };
  const v01 = await buildMutatedShard({ ...base, version: '0.1.0', prefix: `${name}-0.1.0`, mutate: async () => {} });
  const v02 = await buildMutatedShard({ ...base, version: '0.2.0', prefix: `${name}-0.2.0`, mutate: change });
  return { slug, v01, v02 };
}

/** Installs 0.1.0, applies `edit`, then serves 0.2.0 as latest. */
async function installedThenBumped(f: Fixture, edit?: (vault: Vault) => Promise<void>): Promise<Vault> {
  stub.setVersion(f.slug, '0.1.0', f.v01);
  stub.setLatest(f.slug, '0.1.0');
  const vault = await createInstalledVault({ stub, shardRef: `github:${f.slug}`, values: VALUES, prefix: 'update-json' });
  vaults.push(vault);
  if (edit) await edit(vault);
  stub.setVersion(f.slug, '0.2.0', f.v02);
  stub.setLatest(f.slug, '0.2.0');
  return vault;
}

async function updateJson(vault: Vault, extra: string[] = []): Promise<{ doc: Record<string, unknown>; exitCode: number | null }> {
  const result = await spawnCli(['update', '--dry-run', '--json', ...extra], {
    cwd: vault.root,
    env: { SHARDMIND_GITHUB_API_BASE: stub.url },
  });
  return { doc: JSON.parse(result.stdout) as Record<string, unknown>, exitCode: result.exitCode };
}

let newModule: Fixture;
let removedFile: Fixture;
let bothPending: Fixture;
let plainBump: Fixture;

/** Adds a removable `notes` module with one file. */
async function addNotesModule(work: string): Promise<void> {
  const schemaPath = path.join(work, '.shardmind', 'shard-schema.yaml');
  const schema = parseYaml(await fs.readFile(schemaPath, 'utf-8')) as { modules: Record<string, unknown> };
  schema.modules['notes'] = { label: 'Notes', paths: ['notes/'], removable: true };
  await fs.writeFile(schemaPath, stringifyYaml(schema), 'utf-8');
  await fs.mkdir(path.join(work, 'notes'), { recursive: true });
  await fs.writeFile(path.join(work, 'notes', 'Inbox.md'), '# Inbox\n', 'utf-8');
}

beforeAll(async () => {
  await ensureBuilt();
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shardmind-e2e-update-json-'));
  stub = await createGitHubStub({
    shards: {
      'jsontest/new-module': { versions: {}, latest: '0.1.0' },
      'jsontest/removed-file': { versions: {}, latest: '0.1.0' },
      'jsontest/both-pending': { versions: {}, latest: '0.1.0' },
      'jsontest/plain-bump': { versions: {}, latest: '0.1.0' },
    },
  });
  newModule = await fixture('jsontest/new-module', addNotesModule);
  removedFile = await fixture('jsontest/removed-file', async (work) => {
    await fs.rm(path.join(work, 'CLAUDE.md'), { force: true });
  });
  bothPending = await fixture('jsontest/both-pending', async (work) => {
    await addNotesModule(work);
    await fs.rm(path.join(work, 'CLAUDE.md'), { force: true });
  });
  plainBump = await fixture('jsontest/plain-bump', async (work) => {
    await fs.writeFile(path.join(work, 'brain', 'Changelog.md'), '# Changelog\n', 'utf-8');
  });
}, 120_000);

afterEach(async () => {
  for (const vault of vaults.splice(0)) await vault.cleanup();
});

afterAll(async () => {
  await stub?.close();
  await cleanupAllVaults();
  if (outDir) await fs.rm(outDir, { recursive: true, force: true, maxRetries: 5 });
});

interface Refusal {
  ok: false;
  error: { code: string; message: string; hint?: string };
}
interface Plan {
  ok: true;
  result: { counts: Record<string, number>; files: Array<{ path: string; action: string }> };
}

const editClaude = async (v: Vault): Promise<void> => {
  await v.writeFile('CLAUDE.md', `${await v.readFile('CLAUDE.md')}\nMy edit.\n`);
};

function actionOf(plan: Plan, file: string): string | undefined {
  return plan.result.files.find((f) => f.path === file)?.action;
}

describe('update --dry-run --json that would need answers', () => {
  it('names a new optional module instead of writing nothing, and --yes includes it', async () => {
    const vault = await installedThenBumped(newModule);
    const refused = await updateJson(vault);
    expect(refused.exitCode).toBe(1);
    const { error } = refused.doc as unknown as Refusal;
    expect(error.code).toBe('UPDATE_JSON_NEEDS_ANSWERS');
    expect(error.message).toMatch(/new optional modules \(notes\)/);
    expect(error.hint).toContain('--yes');

    const answered = (await updateJson(vault, ['--yes'])).doc as unknown as Plan;
    expect(answered.ok).toBe(true);
    expect(actionOf(answered, 'notes/Inbox.md')).toBe('add');
  }, 120_000);

  it('names a removed file the user edited instead of writing nothing, and --yes keeps it', async () => {
    const vault = await installedThenBumped(removedFile, editClaude);
    const refused = await updateJson(vault);
    expect(refused.exitCode).toBe(1);
    const { error } = refused.doc as unknown as Refusal;
    expect(error.code).toBe('UPDATE_JSON_NEEDS_ANSWERS');
    expect(error.message).toMatch(/removed files you edited \(CLAUDE\.md\)/);
    expect(error.hint).toContain('--yes');

    const answered = (await updateJson(vault, ['--yes'])).doc as unknown as Plan;
    expect(answered.ok).toBe(true);
    expect(actionOf(answered, 'CLAUDE.md')).toBe('keep_as_user');
  }, 120_000);

  it('names both decisions when both are pending, so --yes decides nothing unannounced', async () => {
    const vault = await installedThenBumped(bothPending, editClaude);
    const refused = await updateJson(vault);
    const { error } = refused.doc as unknown as Refusal;
    expect(error.code).toBe('UPDATE_JSON_NEEDS_ANSWERS');
    expect(error.message).toMatch(/new optional modules \(notes\)/);
    expect(error.message).toMatch(/removed files you edited \(CLAUDE\.md\)/);
  }, 120_000);

  it('still emits the plan without --yes when nothing needs an answer', async () => {
    const vault = await installedThenBumped(plainBump);
    const { doc, exitCode } = await updateJson(vault);
    expect(exitCode).toBe(0);
    expect(doc).toMatchObject({ ok: true });
  }, 120_000);

  it('answers an up-to-date vault with an empty plan instead of nothing', async () => {
    stub.setVersion(plainBump.slug, '0.1.0', plainBump.v01);
    stub.setLatest(plainBump.slug, '0.1.0');
    const vault = await createInstalledVault({ stub, shardRef: `github:${plainBump.slug}`, values: VALUES, prefix: 'update-json-current' });
    vaults.push(vault);
    const { doc, exitCode } = await updateJson(vault);
    expect(exitCode).toBe(0);
    const plan = doc as unknown as Plan;
    expect(plan.ok).toBe(true);
    expect(plan.result.files).toEqual([]);
    expect(Object.values(plan.result.counts).every((n) => n === 0)).toBe(true);
  }, 120_000);
});
