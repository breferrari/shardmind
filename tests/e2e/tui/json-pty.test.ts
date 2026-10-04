/**
 * `--json` in a real terminal writes exactly what it writes to a pipe (#198).
 *
 * Each scenario runs once piped (`spawnCli`) and once under node-pty, and
 * the terminal's bytes must equal the piped stdout with no escape byte at
 * all. That one assertion covers Ink's cursor and synchronized-output codes,
 * colour, and anything else a mounted Ink app would add. The terminal's line
 * discipline turns LF into CRLF, which is the only normalisation.
 *
 * Layer 2: macOS and Linux only (#174). tests/e2e/json-tty.test.ts covers
 * Windows with a faked TTY.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createGitHubStub, type GitHubStub } from '../helpers/github-stub.js';
import { buildTarballFixtures, cleanupTarballFixtures, type TarballFixtures } from '../helpers/tarball.js';
import { ensureBuilt } from '../helpers/build-once.js';
import { spawnCli } from '../helpers/spawn-cli.js';
import { createInstalledVault, cleanupAllVaults, stripShardmindMetadata, type Vault } from '../helpers/vault.js';
import { spawnCliPty } from './helpers/pty-cli.js';

const SLUG = 'acme/demo';
const REF = `github:${SLUG}`;
const VALUES = { user_name: 'Alice', org_name: 'Acme Labs', vault_purpose: 'engineering', qmd_enabled: true };
const ESC = '\x1b';

let stub: GitHubStub;
let fixtures: TarballFixtures;
const vaults: Vault[] = [];

async function installed(prefix: string): Promise<Vault> {
  const vault = await createInstalledVault({ stub, shardRef: REF, values: VALUES, prefix });
  vaults.push(vault);
  return vault;
}

/** The same run, piped and in a terminal. */
async function bothWays(cwd: string, args: string[]): Promise<{ piped: string; terminal: string }> {
  const env = { SHARDMIND_GITHUB_API_BASE: stub.url, SHARDMIND_NO_UPDATE_CHECK: '1' };
  const piped = await spawnCli(args, { cwd, env });
  const handle = await spawnCliPty(args, { cwd, env: { ...env, TERM: 'xterm-256color' } });
  try {
    await handle.waitForExit();
    return { piped: piped.stdout, terminal: handle.raw().replace(/\r\n/g, '\n') };
  } finally {
    handle.dispose();
  }
}

describe.skipIf(process.platform === 'win32')('--json in a real terminal (#198)', () => {
  beforeAll(async () => {
    await ensureBuilt();
    fixtures = await buildTarballFixtures();
    stub = await createGitHubStub({
      shards: { [SLUG]: { versions: { '0.1.0': fixtures.byVersion['0.1.0'] }, latest: '0.1.0' } },
    });
  }, 120_000);

  afterEach(async () => {
    for (const vault of vaults.splice(0)) await vault.cleanup();
  });

  afterAll(async () => {
    await stub?.close();
    await cleanupAllVaults();
    await cleanupTarballFixtures();
  });

  it.each([
    ['status --json', ['--json']],
    ['update --dry-run --json', ['update', '--dry-run', '--json']],
    // A run that would otherwise go on to act: refused the same way in both.
    ['update --json without --dry-run', ['update', '--json']],
  ])('%s on an installed vault is byte-identical to the piped run', async (_name, args) => {
    const vault = await installed('json-pty');
    const { piped, terminal } = await bothWays(vault.root, args);
    expect(terminal).not.toContain(ESC);
    expect(terminal).toBe(piped);
    expect(() => JSON.parse(terminal)).not.toThrow();
  }, 90_000);

  it.each([
    ['with --yes', ['--yes']],
    // Without values a terminal would offer the wizard, which --json never
    // renders; the piped run refuses, and so must the terminal run.
    ['without values', []],
  ])('adopt --dry-run --json on an unmanaged clone %s is byte-identical to the piped run', async (_name, extra) => {
    const vault = await installed('json-pty-adopt');
    await stripShardmindMetadata(vault);
    const { piped, terminal } = await bothWays(vault.root, ['adopt', REF, '--dry-run', '--json', ...extra]);
    expect(terminal).not.toContain(ESC);
    expect(terminal).toBe(piped);
  }, 90_000);
});
