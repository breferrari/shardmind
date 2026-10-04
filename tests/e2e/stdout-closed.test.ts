/**
 * A reader that closes stdout early (`shardmind --json | head -1`) ends the
 * run quietly with 141, not with a bug report (#252). Each run here starts
 * with the reader of its stdout already gone, so its first write fails with
 * EPIPE, on all three OSes.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGitHubStub, type GitHubStub } from './helpers/github-stub.js';
import { buildTarballFixtures, cleanupTarballFixtures, type TarballFixtures } from './helpers/tarball.js';
import { DIST_CLI, ensureBuilt } from './helpers/build-once.js';
import { createInstalledVault, cleanupAllVaults, type Vault } from './helpers/vault.js';
import { createBrokenDist, type BrokenDist } from './helpers/broken-dist.js';

const SLUG = 'acme/demo';
const REF = `github:${SLUG}`;
const VALUES = { user_name: 'Alice', org_name: 'Acme Labs', vault_purpose: 'engineering', qmd_enabled: true };

let stub: GitHubStub;
let fixtures: TarballFixtures;
let outside: string;
const vaults: Vault[] = [];

interface ClosedRun {
  code: number | null;
  stderr: string;
}

/** Run the CLI with the reader of its stdout closed before it writes anything. */
function runWithClosedStdout(args: string[], opts: { cwd: string; cli?: string }): Promise<ClosedRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [opts.cli ?? DIST_CLI, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, SHARDMIND_GITHUB_API_BASE: stub.url, SHARDMIND_NO_UPDATE_CHECK: '1', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.destroy();
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf-8')));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out: ${args.join(' ')}`));
    }, 60_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

beforeAll(async () => {
  await ensureBuilt();
  fixtures = await buildTarballFixtures();
  stub = await createGitHubStub({
    shards: { [SLUG]: { versions: { '0.1.0': fixtures.byVersion['0.1.0'], '0.2.0': fixtures.byVersion['0.2.0'] }, latest: '0.1.0' } },
  });
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'shardmind-e2e-stdout-closed-'));
}, 120_000);

afterEach(async () => {
  stub.setLatest(SLUG, '0.1.0');
  for (const vault of vaults.splice(0)) await vault.cleanup();
});

afterAll(async () => {
  await stub?.close();
  await cleanupAllVaults();
  await cleanupTarballFixtures();
  if (outside) await fs.rm(outside, { recursive: true, force: true, maxRetries: 5 });
});

describe('a reader that closes stdout early', () => {
  it.each([
    ['status --json', ['--json']],
    ['the status view', []],
  ])('%s exits 141 with nothing on stderr', async (_name, args) => {
    const run = await runWithClosedStdout(args, { cwd: outside });
    expect(run.stderr).toBe('');
    expect(run.code).toBe(141);
  }, 90_000);

  // A run that fails on its own keeps its code; the closed pipe adds nothing.
  it('keeps the exit code of a run that fails on its own', async () => {
    const run = await runWithClosedStdout(['update', '--dry-run', '--json'], { cwd: outside });
    expect(run.stderr).toBe('');
    expect(run.code).toBe(1);
  }, 90_000);

  // The run is not cut short: the update finishes its write pass, so the
  // vault is fully on the new version, never half-written.
  it('lets update --yes finish: the vault ends fully updated', async () => {
    const vault = await createInstalledVault({ stub, shardRef: REF, values: VALUES, prefix: 'stdout-closed' });
    vaults.push(vault);
    stub.setLatest(SLUG, '0.2.0');
    const run = await runWithClosedStdout(['update', '--yes'], { cwd: vault.root });
    expect(run.stderr).toBe('');
    expect(run.code).toBe(141);
    const state = JSON.parse(await fs.readFile(path.join(vault.root, '.shardmind', 'state.json'), 'utf-8')) as { version: string };
    expect(state.version).toBe('0.2.0');
  }, 120_000);
});

describe('an EPIPE that is not stdout closing', () => {
  let dist: BrokenDist;

  beforeAll(async () => {
    dist = await createBrokenDist();
  }, 120_000);

  afterAll(async () => {
    await dist?.cleanup();
  });

  it('is still reported, and exits 1', async () => {
    await dist.setRootCommand(
      "throw Object.assign(new Error('EPIPE: broken pipe, write to a hook'), { code: 'EPIPE', syscall: 'write' });\n",
    );
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(process.execPath, [dist.cli], {
      cwd: dist.root,
      env: { ...process.env, SHARDMIND_NO_UPDATE_CHECK: '1', NO_COLOR: '1' },
      encoding: 'utf-8',
      timeout: 60_000,
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('EPIPE: broken pipe, write to a hook');
  }, 90_000);
});
