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
import { noPty, ptyCaps } from './helpers/pty-gates.js';
import { stripConptyFraming, stripConptyWraps } from './helpers/conpty-framing.js';
import { createBrokenDist } from '../helpers/broken-dist.js';
import { spawnSync } from 'node:child_process';

const SLUG = 'acme/demo';
const REF = `github:${SLUG}`;
const VALUES = { user_name: 'Alice', org_name: 'Acme Labs', vault_purpose: 'engineering', qmd_enabled: true };
const ESC = '\x1b';
/**
 * Wider than any line these runs print. ConPTY re-renders a line longer than
 * the terminal once the output scrolls, breaking it with a cursor move
 * (`\x1b[<row>;<cols>H`, #174). That is the terminal's wrapping, not the
 * CLI's output, and allowing cursor moves would hide the #198 bug, so the
 * terminal is made wide enough that nothing wraps.
 */
const COLS = 500;

let stub: GitHubStub;
let fixtures: TarballFixtures;
const vaults: Vault[] = [];

async function installed(prefix: string): Promise<Vault> {
  const vault = await createInstalledVault({ stub, shardRef: REF, values: VALUES, prefix });
  vaults.push(vault);
  return vault;
}

/**
 * Masks the values of a plan's content-hash fields, and nothing else. The
 * minimal shard renders the current time into its templates (a `date:`
 * frontmatter field), so `shardHash` / `userHash` differ between two runs a
 * second apart. Every other byte, escape bytes included, is left as it is.
 */
export function maskPlanHashes(text: string): string {
  return text.replace(/"(shardHash|userHash)": "[0-9a-f]{64}"/g, '"$1": "<hash>"');
}

/**
 * A terminal capture as the child wrote it. A POSIX PTY passes the bytes
 * through; Windows ConPTY wraps them in its own framing, which is stripped
 * exactly (helpers/conpty-framing.ts, #174) and nothing else, so any other
 * escape byte still fails. With `wrapped` (a terminal narrower than its
 * lines), ConPTY's exact line wraps for that size are undone too. The line
 * discipline's CRLF is the one other normalisation.
 */
function fromTerminal(raw: string, wrapped?: { rows: number; cols: number }): string {
  let own = raw;
  if (!ptyCaps().verbatim) {
    own = stripConptyFraming(own, process.execPath);
    if (wrapped) own = stripConptyWraps(own, wrapped.rows, wrapped.cols);
  }
  return own.replace(/\r\n/g, '\n');
}

/** The same run, piped and in a terminal, with plan hashes masked. */
async function bothWays(cwd: string, args: string[]): Promise<{ piped: string; terminal: string }> {
  const env = { SHARDMIND_GITHUB_API_BASE: stub.url, SHARDMIND_NO_UPDATE_CHECK: '1' };
  const maskHashes = maskPlanHashes;
  const piped = await spawnCli(args, { cwd, env });
  const handle = await spawnCliPty(args, { cwd, cols: COLS, env: { ...env, TERM: 'xterm-256color' } });
  try {
    await handle.waitForExit();
    return { piped: maskHashes(piped.stdout), terminal: maskHashes(fromTerminal(handle.raw())) };
  } finally {
    handle.dispose();
  }
}

// Runs everywhere: the mask must not hide what the equivalence test checks.
describe('maskPlanHashes', () => {
  const doc = '{\n  "path": "Home.md",\n  "shardHash": "' + 'a'.repeat(64) + '",\n  "action": "add"\n}\n';

  it('masks only shardHash and userHash values', () => {
    expect(maskPlanHashes(doc)).toBe('{\n  "path": "Home.md",\n  "shardHash": "<hash>",\n  "action": "add"\n}\n');
    const other = '{ "tarballSha": "' + 'b'.repeat(64) + '" }';
    expect(maskPlanHashes(other)).toBe(other);
  });

  it('still tells apart a stray escape byte', () => {
    expect(maskPlanHashes(`${ESC}[?25l${doc}`)).not.toBe(maskPlanHashes(doc));
  });

  it('still tells apart a changed non-hash field', () => {
    expect(maskPlanHashes(doc.replace('"add"', '"overwrite"'))).not.toBe(maskPlanHashes(doc));
  });
});

describe.skipIf(noPty())('--json in a real terminal (#198)', () => {
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
    // Every run here answers with a document, an up-to-date update included (#230).
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

  // The runs above use a terminal wider than any line. This one keeps the
  // 80x24 default, so lines overflow and ConPTY rewraps them (#174): its exact
  // wrap sequence for this size is undone, and anything else still fails.
  it('adopt --dry-run --json --yes in an 80x24 terminal is byte-identical once ConPTY wraps are undone', async () => {
    const vault = await installed('json-pty-narrow');
    await stripShardmindMetadata(vault);
    const args = ['adopt', REF, '--dry-run', '--json', '--yes'];
    const env = { SHARDMIND_GITHUB_API_BASE: stub.url, SHARDMIND_NO_UPDATE_CHECK: '1' };
    const piped = await spawnCli(args, { cwd: vault.root, env });
    const handle = await spawnCliPty(args, { cwd: vault.root, cols: 80, rows: 24, env: { ...env, TERM: 'xterm-256color' } });
    try {
      await handle.waitForExit();
      const raw = handle.raw();
      const terminal = maskPlanHashes(fromTerminal(raw, { rows: 24, cols: 80 }));
      // Lines did overflow: the plan's hashes are wider than the terminal.
      expect(piped.stdout.split('\n').some((line) => line.length > 80)).toBe(true);
      expect(terminal).not.toContain(ESC);
      expect(terminal).toBe(maskPlanHashes(piped.stdout));
    } finally {
      handle.dispose();
    }
  }, 90_000);

  // A throw that escapes every command still answers a --json caller with one
  // failure document, in a terminal as piped (#225).
  it('a crash outside every command under --json is byte-identical to the piped run', async () => {
    const dist = await createBrokenDist();
    try {
      // update --json loads its headless runner's chunk (#302).
      await dist.setChunk('update', "throw new TypeError('boom from a broken module under json');\n");
      const args = ['update', '--dry-run', '--json'];
      const env = { SHARDMIND_NO_UPDATE_CHECK: '1' };
      const piped = spawnSync(process.execPath, [dist.cli, ...args], {
        cwd: dist.root,
        env: { ...process.env, ...env },
        encoding: 'utf-8',
        timeout: 60_000,
      });
      const handle = await spawnCliPty(args, { cwd: dist.root, cli: dist.cli, cols: COLS, env: { ...env, TERM: 'xterm-256color' } });
      try {
        await handle.waitForExit();
        const terminal = fromTerminal(handle.raw());
        expect(JSON.parse(piped.stdout)).toMatchObject({ ok: false, command: 'update', error: { code: null } });
        if (ptyCaps().verbatim) {
          expect(terminal).not.toContain(ESC);
          // A terminal shows stderr too: the document, then the plain-text report.
          expect(terminal).toBe(piped.stdout + piped.stderr);
        } else {
          // ConPTY repaints the stderr report that follows the document
          // (it hides the cursor and turns its blank lines into absolute
          // cursor moves), so only the document, which a --json caller
          // reads, can be held to byte identity there (#174).
          const document = terminal.slice(0, piped.stdout.length);
          expect(document).toBe(piped.stdout);
          expect(document).not.toContain(ESC);
        }
      } finally {
        handle.dispose();
      }
    } finally {
      await dist.cleanup();
    }
  }, 90_000);
});
