/**
 * `createInstalledVault` builds each distinct installed fixture once per test
 * file and copies it after that (#218). Each install was a full CLI
 * subprocess whose only job was fixture setup, so a scenario like
 * "install, then update" ran two CLI processes in one 30 s budget, and on a
 * loaded Windows runner that crossed the budget.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureBuilt } from './helpers/build-once.js';
import { buildTarballFixtures, cleanupTarballFixtures, type TarballFixtures } from './helpers/tarball.js';
import { createGitHubStub, type GitHubStub } from './helpers/github-stub.js';
import { spawnCli } from './helpers/spawn-cli.js';
import {
  createInstalledVault,
  cleanupAllVaults,
  installedTemplateCount,
  listRecursive,
  type InstallRunner,
  type Vault,
} from './helpers/vault.js';

const SLUG = 'acme/demo';
const REF = `github:${SLUG}`;
const VALUES = { user_name: 'Alice', org_name: 'Acme Labs', vault_purpose: 'engineering', qmd_enabled: true };

let fixtures: TarballFixtures;
let stub: GitHubStub;
const vaults: Vault[] = [];

/** The real install, counted. */
function countingInstall(): { run: InstallRunner; calls: () => number } {
  let calls = 0;
  const run: InstallRunner = (args, opts) => {
    calls += 1;
    return spawnCli(args, opts);
  };
  return { run, calls: () => calls };
}

async function make(values: Record<string, unknown>, run: InstallRunner, shardRef = REF): Promise<Vault> {
  const vault = await createInstalledVault({ stub, shardRef, values, prefix: 'fixture-cache', install: run });
  vaults.push(vault);
  return vault;
}

async function snapshot(vault: Vault): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of await listRecursive(vault.root)) {
    out[rel] = (await fs.readFile(path.join(vault.root, rel))).toString('base64');
  }
  return out;
}

beforeAll(async () => {
  await ensureBuilt();
  fixtures = await buildTarballFixtures();
  stub = await createGitHubStub({
    shards: {
      [SLUG]: {
        versions: { '0.1.0': fixtures.byVersion['0.1.0'], '0.2.0': fixtures.byVersion['0.2.0'] },
        latest: '0.1.0',
      },
    },
  });
}, 120_000);

afterEach(async () => {
  stub.setLatest(SLUG, '0.1.0');
  for (const vault of vaults.splice(0)) await vault.cleanup();
  // Templates last for the whole file by design; each test here starts cold.
  await cleanupAllVaults();
});

afterAll(async () => {
  await stub?.close();
  await cleanupAllVaults();
  await cleanupTarballFixtures();
});

const ISO_TIME = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g;

/**
 * The vault's tree with install time taken out: templates render the install
 * time (a `date:` frontmatter field), and state.json records it and the
 * hashes of those renders. Everything else must match byte for byte.
 */
async function comparable(vault: Vault): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of await listRecursive(vault.root)) {
    let text = (await fs.readFile(path.join(vault.root, rel), 'utf-8')).replace(ISO_TIME, '<time>');
    if (rel === '.shardmind/state.json') text = text.replace(/"[0-9a-f]{64}"/g, '"<hash>"');
    out[rel] = text;
  }
  return out;
}

/** `shardmind --json` for a vault, without its install and update times. */
async function statusOf(vault: Vault): Promise<Record<string, unknown>> {
  const result = await spawnCli(['--json'], { cwd: vault.root, env: { SHARDMIND_GITHUB_API_BASE: stub.url } });
  const doc = JSON.parse(result.stdout) as { result: Record<string, unknown> };
  delete doc.result['installedAt'];
  delete doc.result['updatedAt'];
  return doc.result;
}

describe('createInstalledVault fixture cache', () => {
  it('installs once, then copies a byte-identical vault', async () => {
    const { run, calls } = countingInstall();
    const first = await make(VALUES, run);
    const second = await make(VALUES, run);
    expect(calls()).toBe(1);
    expect(second.root).not.toBe(first.root);
    expect(await snapshot(second)).toEqual(await snapshot(first));
  }, 60_000);

  it('installs again for different values', async () => {
    const { run, calls } = countingInstall();
    await make(VALUES, run);
    await make({ ...VALUES, user_name: 'Bob' }, run);
    expect(calls()).toBe(2);
  }, 60_000);

  it('installs again for a different ref', async () => {
    const { run, calls } = countingInstall();
    await make(VALUES, run);
    await make(VALUES, run, `${REF}@0.2.0`);
    expect(calls()).toBe(2);
  }, 60_000);

  it('installs again after setLatest changes what the stub serves, and hits again once it is back', async () => {
    const { run, calls } = countingInstall();
    await make(VALUES, run);
    stub.setLatest(SLUG, '0.2.0');
    const bumped = await make(VALUES, run);
    expect(calls()).toBe(2);
    const state = JSON.parse(await bumped.readFile('.shardmind/state.json')) as { version: string };
    expect(state.version).toBe('0.2.0');
    stub.setLatest(SLUG, '0.1.0');
    await make(VALUES, run);
    expect(calls()).toBe(2);
  }, 90_000);

  it('gives each copy its own files', async () => {
    const { run } = countingInstall();
    const first = await make(VALUES, run);
    const second = await make(VALUES, run);
    await first.writeFile('Home.md', 'edited in the first copy');
    expect(await second.readFile('Home.md')).not.toBe('edited in the first copy');
    const third = await make(VALUES, run);
    expect(await third.readFile('Home.md')).not.toBe('edited in the first copy');
  }, 60_000);

  it('gives a copy that matches a fresh real install with the same inputs', async () => {
    const { run, calls } = countingInstall();
    await make(VALUES, run);
    const copy = await make(VALUES, run);
    const fresh = await createInstalledVault({ stub, shardRef: REF, values: VALUES, prefix: 'fixture-fresh', fresh: true, install: run });
    vaults.push(fresh);
    expect(calls()).toBe(2); // the first install and the fresh one; the copy spawned nothing
    expect(await comparable(copy)).toEqual(await comparable(fresh));
    // The engine sees the copy as the install it is: same report, no drift.
    const status = await statusOf(copy);
    expect(status).toEqual(await statusOf(fresh));
    expect(status['files']).toMatchObject({ counts: { modified: 0, missing: 0, orphaned: 0 } });
  }, 90_000);

  it('records no absolute path in an installed vault', async () => {
    const { run } = countingInstall();
    const vault = await make(VALUES, run);
    const forms = [vault.root, vault.root.split(path.sep).join('/'), JSON.stringify(vault.root).slice(1, -1)];
    for (const rel of await listRecursive(vault.root)) {
      const content = await fs.readFile(path.join(vault.root, rel), 'utf-8');
      for (const form of forms) expect(content, rel).not.toContain(form);
    }
  }, 60_000);

  it('never caches a vault that mentions its own path, as a hook writing ctx.vaultRoot would', async () => {
    let calls = 0;
    const run: InstallRunner = async (args, opts) => {
      calls += 1;
      const result = await spawnCli(args, opts);
      await fs.writeFile(path.join(opts.cwd, 'where-am-i.txt'), opts.cwd, 'utf-8');
      return result;
    };
    const values = { ...VALUES, user_name: 'Hooked' };
    await make(values, run);
    const second = await make(values, run);
    expect(calls).toBe(2);
    expect(await second.readFile('where-am-i.txt')).toBe(second.root);
  }, 90_000);

  it('installs again for a different stub serving the same shard', async () => {
    const other = await createGitHubStub({
      shards: { [SLUG]: { versions: { '0.1.0': fixtures.byVersion['0.1.0'], '0.2.0': fixtures.byVersion['0.2.0'] }, latest: '0.1.0' } },
    });
    try {
      const { run, calls } = countingInstall();
      await make(VALUES, run);
      vaults.push(await createInstalledVault({ stub: other, shardRef: REF, values: VALUES, prefix: 'fixture-other', install: run }));
      expect(calls()).toBe(2);
    } finally {
      await other.close();
    }
  }, 90_000);

  it('installs again when a tarball is rebuilt at the same path, and not when only its mtime moves', async () => {
    const dir = await fs.mkdtemp(path.join(path.dirname(fixtures.byVersion['0.1.0']), 'rebuilt-'));
    const tarball = path.join(dir, 'demo.tar.gz');
    await fs.copyFile(fixtures.byVersion['0.1.0'], tarball);
    const own = await createGitHubStub({ shards: { [SLUG]: { versions: { '0.1.0': tarball }, latest: '0.1.0' } } });
    try {
      const { run, calls } = countingInstall();
      const install = async (): Promise<void> => {
        vaults.push(await createInstalledVault({ stub: own, shardRef: REF, values: VALUES, prefix: 'fixture-rebuilt', install: run }));
      };
      await install();
      const later = new Date(Date.now() + 60_000);
      await fs.utimes(tarball, later, later);
      await install();
      expect(calls()).toBe(1);
      await fs.copyFile(fixtures.byVersion['0.2.0'], tarball);
      await install();
      expect(calls()).toBe(2);
    } finally {
      await own.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it.skipIf(process.platform === 'win32')('never caches a vault holding a symlink', async () => {
    let calls = 0;
    const run: InstallRunner = async (args, opts) => {
      calls += 1;
      const result = await spawnCli(args, opts);
      await fs.symlink(path.join(opts.cwd, 'Home.md'), path.join(opts.cwd, 'home-link.md'));
      return result;
    };
    const values = { ...VALUES, user_name: 'Linked' };
    await make(values, run);
    await make(values, run);
    expect(calls).toBe(2);
  }, 90_000);

  it("keeps a custom runner's side effects out of the default runner's vaults", async () => {
    const marking: InstallRunner = async (args, opts) => {
      const result = await spawnCli(args, opts);
      await fs.writeFile(path.join(opts.cwd, 'marker.txt'), 'x', 'utf-8');
      return result;
    };
    await make(VALUES, marking);
    const { run } = countingInstall();
    const plain = await make(VALUES, run);
    expect(await plain.exists('marker.txt')).toBe(false);
  }, 90_000);

  it('shares one install between concurrent calls with the same inputs', async () => {
    const { run, calls } = countingInstall();
    const [a, b] = await Promise.all([make(VALUES, run), make(VALUES, run)]);
    expect(calls()).toBe(1);
    expect(a.root).not.toBe(b.root);
    expect(await b.exists('.shardmind/state.json')).toBe(true);
    expect(installedTemplateCount()).toBe(1);
  }, 90_000);

  it.each([
    ['its real path', async (cwd: string) => fs.realpath(cwd)],
    ['a file: URL', async (cwd: string) => pathToFileURL(cwd).href],
    ['a different letter case on Windows', async (cwd: string) => (process.platform === 'win32' ? cwd.toUpperCase() : cwd)],
  ])('never caches a vault that mentions its path as %s', async (_name, spell) => {
    let calls = 0;
    const run: InstallRunner = async (args, opts) => {
      calls += 1;
      const result = await spawnCli(args, opts);
      await fs.writeFile(path.join(opts.cwd, 'where.txt'), await spell(opts.cwd), 'utf-8');
      return result;
    };
    const values = { ...VALUES, user_name: `Spelled-${calls}-${Math.random()}` };
    await make(values, run);
    await make(values, run);
    expect(calls).toBe(2);
  }, 90_000);

  it('removes its templates in cleanupAllVaults', async () => {
    const { run } = countingInstall();
    await make(VALUES, run);
    expect(installedTemplateCount()).toBeGreaterThan(0);
    await cleanupAllVaults();
    expect(installedTemplateCount()).toBe(0);
  }, 60_000);
});
