/**
 * A real SIGINT while the executor is writing the vault (#186).
 *
 * #267's rollback contract aborts every pipeline at write N in-process.
 * This covers what it cannot: a signal delivered to a real `dist/cli.js`
 * process mid-write, through the actual handler and exit path. On POSIX a
 * native SIGINT; on Windows the stdin-ETX bridge (#155, #173), which runs
 * the same handler.
 *
 * The child holds at a vault write through a test-only preload
 * (helpers/hold-write.ts, #267's `beforeWrite` vocabulary), and the signal
 * is sent only once the hold has begun, so no run can pass by finishing
 * first. After the rollback the vault must be the tree it was before.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGitHubStub, type GitHubStub } from './helpers/github-stub.js';
import { buildTarballFixtures, cleanupTarballFixtures, type TarballFixtures } from './helpers/tarball.js';
import { ensureBuilt } from './helpers/build-once.js';
import { spawnCli, type CliResult } from './helpers/spawn-cli.js';
import {
  createEmptyVault,
  createInstalledVault,
  cleanupAllVaults,
  stripShardmindMetadata,
  type Vault,
} from './helpers/vault.js';
import { holdWriteNodeArgs, waitForHold } from './helpers/hold-write.js';
import { treeOf } from '../helpers/vault-tree.js';
import { stringify as stringifyYaml } from 'yaml';

const SLUG = 'acme/demo';
const REF = `github:${SLUG}`;
const VALUES = { user_name: 'Alice', org_name: 'Acme Labs', vault_purpose: 'engineering', qmd_enabled: true };
/** Which vault write to hold at: past the first few, well before the last. */
const HOLD_AT = 3;

let stub: GitHubStub;
let fixtures: TarballFixtures;
let scratch: string;
const vaults: Vault[] = [];

/** The vault tree, minus the paths `skip` names, for an equality check. */
async function snapshot(root: string, skip: (rel: string) => boolean = () => false): Promise<Record<string, string>> {
  return Object.fromEntries([...(await treeOf(root))].filter(([rel]) => !skip(rel)));
}

async function valuesFile(name: string): Promise<string> {
  const file = path.join(scratch, `${name}-values.yaml`);
  await fs.writeFile(file, stringifyYaml(VALUES), 'utf-8');
  return file;
}

/** Run `args` in `vault`, held at HOLD_AT's vault write, and SIGINT it there. */
async function interruptMidWrite(vault: Vault, args: string[]): Promise<{ result: CliResult; held: boolean }> {
  const marker = path.join(scratch, `held-${crypto.randomUUID()}`);
  const hold = waitForHold(marker);
  const result = await spawnCli(args, {
    cwd: vault.root,
    env: { SHARDMIND_GITHUB_API_BASE: stub.url, SHARDMIND_NO_UPDATE_CHECK: '1' },
    nodeArgs: holdWriteNodeArgs({ nth: HOLD_AT, marker }),
    signalAt: { signal: 'SIGINT', when: hold },
    timeoutMs: 60_000,
  });
  const held = await fs.stat(marker).then(() => true, () => false);
  return { result, held };
}

function expectCancelled(result: CliResult, held: boolean): void {
  const detail = `exitCode=${result.exitCode} signal=${result.signal}\nstdout=${result.stdout}\nstderr=${result.stderr}`;
  // The hold began before the signal: the run was mid-write, not finished.
  expect(held, detail).toBe(true);
  expect(result.exitCode, detail).toBe(130);
  // A cancel is not a crash (#225).
  expect(result.stdout + result.stderr).not.toMatch(/This is a bug in shardmind/);
}

beforeAll(async () => {
  await ensureBuilt();
  fixtures = await buildTarballFixtures();
  stub = await createGitHubStub({
    shards: { [SLUG]: { versions: { '0.1.0': fixtures.byVersion['0.1.0'], '0.2.0': fixtures.byVersion['0.2.0'] }, latest: '0.1.0' } },
  });
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'shardmind-e2e-sigint-write-'));
}, 120_000);

afterEach(async () => {
  stub.setLatest(SLUG, '0.1.0');
  for (const vault of vaults.splice(0)) await vault.cleanup();
});

afterAll(async () => {
  await stub?.close();
  await cleanupAllVaults();
  await cleanupTarballFixtures();
  if (scratch) await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5 });
});

describe('SIGINT while the executor writes the vault (#186)', () => {
  it('install: exits 130 and leaves the vault as it was', async () => {
    const vault = await createEmptyVault('sigint-write-install');
    vaults.push(vault);
    await fs.writeFile(path.join(vault.root, 'mine.md'), 'my own note\n');
    const before = await snapshot(vault.root);

    const { result, held } = await interruptMidWrite(vault, ['install', REF, '--yes', '--values', await valuesFile('install')]);

    expectCancelled(result, held);
    expect(await snapshot(vault.root)).toEqual(before);
  }, 90_000);

  it('update: exits 130 and restores every file, state.json and the template cache', async () => {
    const vault = await createInstalledVault({ stub, shardRef: REF, values: VALUES, prefix: 'sigint-write-update' });
    vaults.push(vault);
    stub.setLatest(SLUG, '0.2.0');
    // Update keeps its snapshot under .shardmind/backups (§4.12). It also
    // primes the latest-version cache when it resolves the release, before
    // any write (§4.15): a fact about the remote, true whether or not the
    // update completes, not vault content a rollback undoes.
    const notSnapshot = (rel: string) =>
      rel === '.shardmind/backups' || rel.startsWith('.shardmind/backups/') || rel === '.shardmind/update-check.json';
    const before = await snapshot(vault.root, notSnapshot);

    const { result, held } = await interruptMidWrite(vault, ['update', '--yes']);

    expectCancelled(result, held);
    expect(await snapshot(vault.root, notSnapshot)).toEqual(before);
  }, 120_000);

  it('adopt: exits 130 and leaves the user files and no engine state', async () => {
    const vault = await createInstalledVault({ stub, shardRef: REF, values: VALUES, prefix: 'sigint-write-adopt' });
    vaults.push(vault);
    await stripShardmindMetadata(vault);
    await fs.appendFile(path.join(vault.root, 'Home.md'), '\nmy edit\n');
    const before = await snapshot(vault.root);

    const { result, held } = await interruptMidWrite(vault, ['adopt', REF, '--yes', '--values', await valuesFile('adopt')]);

    expectCancelled(result, held);
    expect(await snapshot(vault.root)).toEqual(before);
  }, 120_000);
});
