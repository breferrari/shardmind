/**
 * A `--json` run never waits on a prompt (#198). Ink decides whether it can
 * prompt from stdin.isTTY, so in a terminal `adopt --dry-run --json` without
 * --yes or --values entered its wizard while rendering nothing under --json,
 * and hung; piped, it refused with ADOPT_NON_INTERACTIVE_WITHOUT_VALUES. Each
 * `--json` command runs here without --yes or --values, once piped and once
 * with stdout and stdin faked as a terminal, and the two must match.
 *
 * Faked rather than a real PTY so it runs on Windows too;
 * tests/e2e/tui/json-pty.test.ts does the same under node-pty on macOS and
 * Linux.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { DIST_CLI, ensureBuilt } from './helpers/build-once.js';
import { createGitHubStub, type GitHubStub } from './helpers/github-stub.js';
import { buildTarballFixtures, cleanupTarballFixtures, type TarballFixtures } from './helpers/tarball.js';
import { createInstalledVault, cleanupAllVaults, stripShardmindMetadata, type Vault } from './helpers/vault.js';
import { FAKE_TTY_IMPORT } from '../helpers/fake-tty.js';

const SLUG = 'acme/demo';
const REF = `github:${SLUG}`;
const VALUES = { user_name: 'Alice', org_name: 'Acme Labs', vault_purpose: 'engineering', qmd_enabled: true };
// Ink's isRawModeSupported reads stdin.isTTY; a stub setRawMode keeps Ink happy.
const STDIN_TTY =
  'data:text/javascript,' +
  encodeURIComponent('process.stdin.isTTY = true; process.stdin.setRawMode = () => process.stdin;');

let stub: GitHubStub;
let fixtures: TarballFixtures;
const vaults: Vault[] = [];

/** Async on purpose: the stub serves from this process. */
function runCli(cwd: string, args: string[], tty: boolean): Promise<{ stdout: string; status: number | null; timedOut: boolean }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('SHARDMIND_') || key === 'NO_COLOR' || key === 'FORCE_COLOR' || key === 'CI') delete env[key];
  }
  Object.assign(env, { TERM: 'xterm-256color', SHARDMIND_GITHUB_API_BASE: stub.url, SHARDMIND_NO_UPDATE_CHECK: '1' });
  const preload = tty ? ['--import', FAKE_TTY_IMPORT, '--import', STDIN_TTY] : [];
  const child = spawn(process.execPath, [...preload, DIST_CLI, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.setEncoding('utf-8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.resume();
  return new Promise((resolve) => {
    // A run stuck in an invisible prompt never exits; report that rather than hang.
    const timer = setTimeout(() => {
      child.kill();
      resolve({ stdout, status: null, timedOut: true });
    }, 30_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ stdout, status, timedOut: false });
    });
  });
}

async function installed(prefix: string): Promise<Vault> {
  const vault = await createInstalledVault({ stub, shardRef: REF, values: VALUES, prefix });
  vaults.push(vault);
  return vault;
}

beforeAll(async () => {
  await ensureBuilt();
  fixtures = await buildTarballFixtures();
  stub = await createGitHubStub({ shards: { [SLUG]: { versions: { '0.1.0': fixtures.byVersion['0.1.0'] }, latest: '0.1.0' } } });
}, 120_000);

afterEach(async () => {
  for (const vault of vaults.splice(0)) await vault.cleanup();
});

afterAll(async () => {
  await stub?.close();
  await cleanupAllVaults();
  await cleanupTarballFixtures();
});

describe('--json with no --yes or --values, terminal vs piped', () => {
  it.each([
    ['status', ['--json'], false],
    ['update', ['update', '--dry-run', '--json'], false],
    ['adopt', ['adopt', REF, '--dry-run', '--json'], true],
  ])('%s answers in a terminal exactly as piped', async (_name, args, unmanaged) => {
    const vault = await installed('json-prompt');
    if (unmanaged) await stripShardmindMetadata(vault);
    const piped = await runCli(vault.root, args, false);
    const terminal = await runCli(vault.root, args, true);
    expect(terminal.timedOut).toBe(false);
    expect(terminal.stdout).toBe(piped.stdout);
    expect(terminal.status).toBe(piped.status);
  }, 120_000);
});
