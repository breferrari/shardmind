/**
 * `update --json` and `adopt --json` without `--dry-run` run the command
 * and answer with one result document (#348). Spec: OPERATIONS §--json
 * runs, IMPLEMENTATION §4.29 (A real run under --json).
 *
 * Two properties are pinned through a real `dist/cli.js`:
 * 1. **Plan equals outcome.** For the same vault and flags, each file's
 *    outcome in the real run is what `--dry-run --json` planned, and the
 *    vault on disk matches it, a conflict case included. A run that is
 *    stopped mid-write rolls back: `ok: false`, the vault as it was.
 * 2. **stdout is exactly one JSON document**, ending in one newline, even
 *    when a hook prints to stdout and stderr, and on the Ctrl+C path (130).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ensureBuilt } from './helpers/build-once.js';
import { createGitHubStub, type GitHubStub } from './helpers/github-stub.js';
import { buildTarballFixtures, cleanupTarballFixtures, type TarballFixtures } from './helpers/tarball.js';
import { spawnCli, type CliResult } from './helpers/spawn-cli.js';
import { createInstalledVault, cleanupAllVaults, stripShardmindMetadata, type Vault } from './helpers/vault.js';
import { holdWriteNodeArgs, waitForHold } from './helpers/hold-write.js';
import { buildMutatedShard } from './tui/helpers/build-fixture-shard.js';
import { treeOf } from '../helpers/vault-tree.js';

const SLUG = 'acme/demo';
const REF = `github:${SLUG}`;
const HOOKED = 'jsonexec/hooked';
const VALUES = { user_name: 'Alice', org_name: 'Acme Labs', vault_purpose: 'engineering', qmd_enabled: true };
const MY_LINE = 'My own line, not the shard’s.';

let stub: GitHubStub;
let fixtures: TarballFixtures;
let scratch: string;
const vaults: Vault[] = [];

const env = () => ({ SHARDMIND_GITHUB_API_BASE: stub.url, SHARDMIND_NO_UPDATE_CHECK: '1' });
const sha256 = (buf: Buffer | string) => crypto.createHash('sha256').update(buf).digest('hex');

interface FileOutcome {
  path: string;
  outcome: string;
  shardHash?: string;
  conflict?: { resolution: string; by: string };
}

/** The envelope every `--json` document carries; `result` and `error` are read loosely. */
interface JsonDocument {
  schemaVersion: number;
  command: string;
  ok: boolean;
  result?: any;
  error?: any;
}

/** stdout is one JSON document and nothing else, ending in exactly one newline. */
function oneDocument(result: CliResult): JsonDocument {
  const detail = `exit=${result.exitCode}\nstdout=${result.stdout}\nstderr=${result.stderr}`;
  expect(result.stdout.endsWith('}\n'), detail).toBe(true);
  expect(result.stdout.endsWith('}\n\n'), detail).toBe(false);
  return JSON.parse(result.stdout) as JsonDocument;
}

async function run(vault: Vault, args: string[]): Promise<CliResult> {
  return spawnCli(args, { cwd: vault.root, env: env(), timeoutMs: 90_000 });
}

async function valuesFile(name: string): Promise<string> {
  const file = path.join(scratch, `${name}-values.yaml`);
  await fs.writeFile(file, stringifyYaml(VALUES), 'utf-8');
  return file;
}

/** What each planned update action becomes, conflicts settled the headless way (keep_mine). */
const UPDATE_OUTCOME: Record<string, string> = {
  add: 'written',
  overwrite: 'replaced',
  auto_merge: 'merged',
  restore_missing: 'restored',
  keep_as_user: 'kept',
  delete: 'deleted',
  noop: 'unchanged',
  skip_volatile: 'unchanged',
  conflict: 'kept',
};

const ADOPT_OUTCOME: Record<string, string> = {
  matches: 'matched',
  differs: 'kept-mine',
  behind: 'updated-behind',
  'shard-only': 'installed',
};

async function snapshot(root: string, skip: (rel: string) => boolean = () => false): Promise<Record<string, string>> {
  return Object.fromEntries([...(await treeOf(root))].filter(([rel]) => !skip(rel)));
}

beforeAll(async () => {
  await ensureBuilt();
  fixtures = await buildTarballFixtures();
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'shardmind-e2e-json-execute-'));
  // A shard whose post-update hook prints to stdout and stderr, so a hook's
  // output provably never reaches the document.
  const hooked = (version: string) =>
    buildMutatedShard({
      name: 'hooked',
      namespace: 'jsonexec',
      version,
      prefix: `hooked-${version}`,
      outDir: scratch,
      mutate: async (work) => {
        const manifestPath = path.join(work, '.shardmind', 'shard.yaml');
        const manifest = parseYaml(await fs.readFile(manifestPath, 'utf-8')) as Record<string, unknown>;
        manifest['hooks'] = { 'post-update': 'hooks/post-update.ts' };
        await fs.writeFile(manifestPath, stringifyYaml(manifest), 'utf-8');
        await fs.mkdir(path.join(work, 'hooks'), { recursive: true });
        await fs.writeFile(
          path.join(work, 'hooks', 'post-update.ts'),
          'export default async function () {\n  console.log(\'{"hook":"stdout"} HOOK-STDOUT\');\n  console.error("HOOK-STDERR");\n}\n',
          'utf-8',
        );
        if (version === '0.2.0') {
          await fs.writeFile(path.join(work, 'brain', 'Changelog.md'), '# Changelog\n', 'utf-8');
        }
      },
    });
  const [h1, h2] = await Promise.all([hooked('0.1.0'), hooked('0.2.0')]);
  stub = await createGitHubStub({
    shards: {
      [SLUG]: { versions: { '0.1.0': fixtures.byVersion['0.1.0'], '0.2.0': fixtures.byVersion['0.2.0'] }, latest: '0.1.0' },
      [HOOKED]: { versions: { '0.1.0': h1, '0.2.0': h2 }, latest: '0.1.0' },
    },
  });
}, 180_000);

afterEach(async () => {
  stub.setLatest(SLUG, '0.1.0');
  stub.setLatest(HOOKED, '0.1.0');
  for (const vault of vaults.splice(0)) await vault.cleanup();
});

afterAll(async () => {
  await stub?.close();
  await cleanupAllVaults();
  await cleanupTarballFixtures();
  if (scratch) await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5 });
});

describe('update --json runs the update (#348)', () => {
  it('each file’s outcome is what --dry-run --json planned, a conflict kept by the headless rule', async () => {
    const vault = await createInstalledVault({ stub, shardRef: REF, values: VALUES, prefix: 'json-exec-update' });
    vaults.push(vault);
    // 0.2.0 appends to Home.md; so does the user: a conflict.
    await vault.writeFile('Home.md', `${await vault.readFile('Home.md')}\n${MY_LINE}\n`);
    stub.setLatest(SLUG, '0.2.0');

    const plan = oneDocument(await run(vault, ['update', '--dry-run', '--json']));
    expect(plan.ok).toBe(true);
    const planned = plan.result.files as Array<{ path: string; action: string }>;
    expect(planned.find((f) => f.path === 'Home.md')?.action).toBe('conflict');

    const real = await run(vault, ['update', '--json']);
    expect(real.exitCode).toBe(0);
    const doc = oneDocument(real);
    expect(doc).toMatchObject({ schemaVersion: 1, command: 'update', ok: true, result: { dryRun: false, fromVersion: '0.1.0', toVersion: '0.2.0' } });
    const files = doc.result.files as FileOutcome[];

    // Plan equals outcome, path for path.
    expect(files.map((f) => [f.path, f.outcome])).toEqual(planned.map((f) => [f.path, UPDATE_OUTCOME[f.action]]));
    // The conflict is listed as settled by the headless rule, and the user's line is still there.
    expect(files.find((f) => f.path === 'Home.md')).toMatchObject({ outcome: 'kept', conflict: { resolution: 'keep_mine', by: 'json-default' } });
    expect(await vault.readFile('Home.md')).toContain(MY_LINE);
    // Every file the run wrote whole holds what the document says.
    for (const f of files.filter((x) => ['written', 'replaced', 'restored'].includes(x.outcome))) {
      expect(sha256(await fs.readFile(path.join(vault.root, f.path))), f.path).toBe(f.shardHash);
    }
    expect(doc.result.backupDir).toMatch(/^\.shardmind\/backups\/update-/);
    const state = JSON.parse(await vault.readFile('.shardmind/state.json')) as { version: string };
    expect(state.version).toBe('0.2.0');
  }, 180_000);

  it('an up-to-date vault answers upToDate with nothing written, exit 0', async () => {
    const vault = await createInstalledVault({ stub, shardRef: REF, values: VALUES, prefix: 'json-exec-uptodate' });
    vaults.push(vault);
    const before = await snapshot(vault.root, (rel) => rel === '.shardmind/update-check.json');
    const result = await run(vault, ['update', '--json']);
    expect(result.exitCode).toBe(0);
    expect(oneDocument(result)).toMatchObject({ ok: true, result: { dryRun: false, upToDate: true, files: [] } });
    expect(await snapshot(vault.root, (rel) => rel === '.shardmind/update-check.json')).toEqual(before);
  }, 120_000);

  it('a hook that prints to stdout and stderr never reaches the document', async () => {
    const vault = await createInstalledVault({ stub, shardRef: `github:${HOOKED}`, values: VALUES, prefix: 'json-exec-hook' });
    vaults.push(vault);
    stub.setLatest(HOOKED, '0.2.0');
    const result = await run(vault, ['update', '--json']);
    expect(result.exitCode).toBe(0);
    const doc = oneDocument(result);
    expect(result.stdout).not.toContain('HOOK-STDOUT');
    expect(result.stdout).not.toContain('HOOK-STDERR');
    expect(doc.result.hooks).toEqual([expect.objectContaining({ slot: 'post-update', outcome: 'completed', exitCode: 0 })]);
  }, 180_000);
});

describe('adopt --json runs the adopt (#348)', () => {
  it('each file’s outcome is what --dry-run --json planned; the differing file is kept by the headless rule', async () => {
    const vault = await createInstalledVault({ stub, shardRef: REF, values: VALUES, prefix: 'json-exec-adopt' });
    vaults.push(vault);
    await stripShardmindMetadata(vault);
    await vault.writeFile('Home.md', `${await vault.readFile('Home.md')}\n${MY_LINE}\n`);
    const values = await valuesFile('adopt');

    const plan = oneDocument(await run(vault, ['adopt', REF, '--values', values, '--dry-run', '--json']));
    const planned = plan.result.files as Array<{ path: string; classification: string }>;
    expect(planned.find((f) => f.path === 'Home.md')?.classification).toBe('differs');

    const real = await run(vault, ['adopt', REF, '--values', values, '--json']);
    expect(real.exitCode).toBe(0);
    const doc = oneDocument(real);
    expect(doc).toMatchObject({ command: 'adopt', ok: true, result: { dryRun: false, mode: 'keep-all-mine', backupDir: null } });
    const files = doc.result.files as FileOutcome[];
    expect(files.map((f) => [f.path, f.outcome])).toEqual(planned.map((f) => [f.path, ADOPT_OUTCOME[f.classification]]));
    expect(files.find((f) => f.path === 'Home.md')).toMatchObject({ outcome: 'kept-mine', conflict: { resolution: 'keep_mine', by: 'json-default' } });
    expect(await vault.readFile('Home.md')).toContain(MY_LINE);
    expect(await vault.exists('.shardmind/state.json')).toBe(true);
  }, 180_000);

  it('a --mode decides instead, and the document says so', async () => {
    const vault = await createInstalledVault({ stub, shardRef: REF, values: VALUES, prefix: 'json-exec-adopt-mode' });
    vaults.push(vault);
    await stripShardmindMetadata(vault);
    await vault.writeFile('Home.md', `${await vault.readFile('Home.md')}\n${MY_LINE}\n`);
    const result = await run(vault, ['adopt', REF, '--values', await valuesFile('adopt-mode'), '--mode', 'use-all-theirs', '--json']);
    const doc = oneDocument(result);
    expect(doc.result.mode).toBe('use-all-theirs');
    expect((doc.result.files as FileOutcome[]).find((f) => f.path === 'Home.md')).toMatchObject({
      outcome: 'used-shard',
      conflict: { resolution: 'use_shard', by: 'mode' },
    });
    expect(await vault.readFile('Home.md')).not.toContain(MY_LINE);
  }, 180_000);
});

describe('a --json run stopped mid-write rolls back and still answers with one document (#348)', () => {
  /** Run `args`, held at the 3rd vault write, and SIGINT it there. */
  async function interruptMidWrite(vault: Vault, args: string[]): Promise<{ result: CliResult; held: boolean }> {
    const marker = path.join(scratch, `held-${crypto.randomUUID()}`);
    const hold = waitForHold(marker);
    const result = await spawnCli(args, {
      cwd: vault.root,
      env: env(),
      nodeArgs: holdWriteNodeArgs({ nth: 3, marker }),
      signalAt: { signal: 'SIGINT', when: hold },
      timeoutMs: 60_000,
    });
    return { result, held: await fs.stat(marker).then(() => true, () => false) };
  }

  it('update: CANCELLED, exit 130, the vault as it was', async () => {
    const vault = await createInstalledVault({ stub, shardRef: REF, values: VALUES, prefix: 'json-exec-cancel-update' });
    vaults.push(vault);
    stub.setLatest(SLUG, '0.2.0');
    const notSnapshot = (rel: string) =>
      rel === '.shardmind/backups' || rel.startsWith('.shardmind/backups/') || rel === '.shardmind/update-check.json';
    const before = await snapshot(vault.root, notSnapshot);

    const { result, held } = await interruptMidWrite(vault, ['update', '--json']);
    expect(held).toBe(true);
    expect(result.exitCode).toBe(130);
    expect(oneDocument(result)).toMatchObject({ command: 'update', ok: false, error: { code: 'CANCELLED' } });
    expect(await snapshot(vault.root, notSnapshot)).toEqual(before);
  }, 120_000);

  it('adopt: CANCELLED, exit 130, the user’s files and no engine state', async () => {
    const vault = await createInstalledVault({ stub, shardRef: REF, values: VALUES, prefix: 'json-exec-cancel-adopt' });
    vaults.push(vault);
    await stripShardmindMetadata(vault);
    await vault.writeFile('Home.md', `${await vault.readFile('Home.md')}\n${MY_LINE}\n`);
    const before = await snapshot(vault.root);

    const { result, held } = await interruptMidWrite(vault, ['adopt', REF, '--values', await valuesFile('adopt-cancel'), '--json']);
    expect(held).toBe(true);
    expect(result.exitCode).toBe(130);
    expect(oneDocument(result)).toMatchObject({ command: 'adopt', ok: false, error: { code: 'CANCELLED' } });
    expect(await snapshot(vault.root)).toEqual(before);
  }, 120_000);
});
