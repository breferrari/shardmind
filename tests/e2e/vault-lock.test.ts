/**
 * One shardmind run per vault, through the built CLI (#253).
 *
 * The holder is seeded as a lock file: this test process's own PID is a run
 * that is alive; PID 999999 on this host is one that has gone.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ensureBuilt } from './helpers/build-once.js';
import { buildTarballFixtures, cleanupTarballFixtures, type TarballFixtures } from './helpers/tarball.js';
import { createGitHubStub, type GitHubStub } from './helpers/github-stub.js';
import { spawnCli } from './helpers/spawn-cli.js';
import { createInstalledVault, cleanupAllVaults, type Vault } from './helpers/vault.js';

const SLUG = 'acme/locked';
const REF = `github:${SLUG}`;
const DEFAULT_VALUES = { user_name: 'Alice', org_name: 'Acme Labs', vault_purpose: 'engineering', qmd_enabled: true };

let stub: GitHubStub;
let fixtures: TarballFixtures;

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
}, 90_000);

afterAll(async () => {
  await stub?.close();
  await cleanupTarballFixtures();
  await cleanupAllVaults();
});

const env = () => ({ SHARDMIND_GITHUB_API_BASE: stub.url });
const lockOf = (vault: Vault) => path.join(vault.root, '.shardmind.lock');

async function installedAt010(prefix: string): Promise<Vault> {
  stub.setLatest(SLUG, '0.1.0');
  const vault = await createInstalledVault({ stub, shardRef: REF, values: DEFAULT_VALUES, prefix });
  stub.setLatest(SLUG, '0.2.0');
  return vault;
}

async function seedLock(vault: Vault, pid: number, command = 'update'): Promise<void> {
  await fs.writeFile(
    lockOf(vault),
    JSON.stringify({ pid, hostname: os.hostname(), command, startedAt: '2026-10-04T12:00:00.000Z' }),
  );
}

describe('one run per vault (#253)', () => {
  it('refuses an update while another run holds the vault, naming it, and changes nothing', async () => {
    const vault = await installedAt010('lock-held');
    try {
      await seedLock(vault, process.pid, 'adopt');
      const stateBefore = await vault.readFile('.shardmind/state.json');
      const result = await spawnCli(['update', '--yes'], { cwd: vault.root, env: env() });
      expect(result.exitCode).toBe(1);
      const out = (result.stdout + result.stderr).replace(/\s+/g, ' ');
      expect(out).toContain('VAULT_LOCKED');
      expect(out).toContain(`adopt (PID ${process.pid}`);
      expect(out).toContain('.shardmind.lock');
      expect(await vault.readFile('.shardmind/state.json')).toBe(stateBefore);
      // The other run's lock is left alone.
      expect(JSON.parse(await fs.readFile(lockOf(vault), 'utf-8')).pid).toBe(process.pid);
    } finally {
      await vault.cleanup();
    }
  }, 60_000);

  it('takes over a lock whose run is gone, says so, and leaves no lock when it finishes', async () => {
    const vault = await installedAt010('lock-stale');
    try {
      await seedLock(vault, 999_999);
      const result = await spawnCli(['update', '--yes'], { cwd: vault.root, env: env() });
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      expect(result.stderr).toContain('took over .shardmind.lock');
      await expect(fs.access(lockOf(vault))).rejects.toThrow();
    } finally {
      await vault.cleanup();
    }
  }, 60_000);

  it('a dry run and status read the vault while another run holds it', async () => {
    const vault = await installedAt010('lock-readers');
    try {
      await seedLock(vault, process.pid);
      const dry = await spawnCli(['update', '--dry-run', '--yes'], { cwd: vault.root, env: env() });
      expect(dry.exitCode, dry.stdout + dry.stderr).toBe(0);
      const status = await spawnCli(['--json'], { cwd: vault.root, env: env() });
      expect(status.exitCode, status.stdout + status.stderr).toBe(0);
      expect(JSON.parse(status.stdout).ok).toBe(true);
    } finally {
      await vault.cleanup();
    }
  }, 60_000);

  it('a finished run leaves no lock behind, and a failed one neither', async () => {
    const vault = await installedAt010('lock-released');
    try {
      const ok = await spawnCli(['update', '--yes'], { cwd: vault.root, env: env() });
      expect(ok.exitCode, ok.stdout + ok.stderr).toBe(0);
      await expect(fs.access(lockOf(vault))).rejects.toThrow();
      // An install over the managed vault without --force refuses (non-interactive gate).
      const refused = await spawnCli(['install', REF, '.'], { cwd: vault.root, env: env() });
      expect(refused.exitCode).toBe(1);
      await expect(fs.access(lockOf(vault))).rejects.toThrow();
    } finally {
      await vault.cleanup();
    }
  }, 60_000);
});
