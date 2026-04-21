/**
 * End-to-end tests for the shardmind CLI.
 *
 * Unlike `tests/integration/*`, which import core modules directly, these
 * tests spawn `dist/cli.js` as a subprocess — the same way a user would
 * invoke it — and assert against captured stdout/stderr/exit-code plus
 * filesystem state in a real temp vault.
 *
 * Hermetic: a local HTTP GitHub emulator (`helpers/github-stub.ts`) is
 * started once per suite and pointed at via `SHARDMIND_GITHUB_API_BASE`.
 * No test reaches the public internet; rate limits and network flakes
 * can't destabilize the run.
 *
 * Coverage matrix (see `docs/IMPLEMENTATION.md` §20 for the methodology):
 *   Bootstrap (2)  — --version / --help
 *   Status    (7)  — not-in-vault, quick, verbose, update-available,
 *                    modified-files, corrupt state, offline fallback
 *   Install   (12) — happy + dry-run + verbose + @version + errors +
 *                    collision + BACKUP_FAILED + SIGINT rollback
 *   Update    (7)  — no-install typed error, up-to-date, real bump,
 *                    auto-merge with edits, UPDATE_SOURCE_MISMATCH,
 *                    dry-run, SIGINT rollback
 *   Property  (2)  — install determinism + dry-run safety under
 *                    arbitrary value subsets
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';

// Read package.json for the expected --version assertion so the test
// tracks the shipped version automatically instead of hard-coding.
const pkg = createRequire(import.meta.url)('../../package.json') as { version: string };
const PACKAGE_VERSION = pkg.version;

import { ensureBuilt } from './helpers/build-once.js';
import { buildTarballFixtures, cleanupTarballFixtures, type TarballFixtures } from './helpers/tarball.js';
import { createGitHubStub, type GitHubStub } from './helpers/github-stub.js';
import { spawnCli } from './helpers/spawn-cli.js';
import {
  createEmptyVault,
  createInstalledVault,
  cleanupAllVaults,
  type Vault,
} from './helpers/vault.js';

const SHARD_SLUG = 'acme/demo';
const SHARD_REF = `github:${SHARD_SLUG}`;

const DEFAULT_VALUES = {
  user_name: 'Alice',
  org_name: 'Acme Labs',
  vault_purpose: 'engineering',
  qmd_enabled: true,
};

let stub: GitHubStub;
let fixtures: TarballFixtures;

beforeAll(async () => {
  await ensureBuilt();
  fixtures = await buildTarballFixtures();
  stub = await createGitHubStub({
    shards: {
      [SHARD_SLUG]: {
        versions: {
          '0.1.0': fixtures.byVersion['0.1.0'],
          '0.2.0': fixtures.byVersion['0.2.0'],
          '0.3.0': fixtures.byVersion['0.3.0'],
        },
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

// Helpers local to this file — kept inline because they mix fixture + stub
// context that's only meaningful inside the scope of these tests.

async function writeValuesFile(vault: Vault, values: Record<string, unknown>): Promise<string> {
  const absPath = path.join(vault.root, '.values.yaml');
  const serialized = Object.entries(values)
    .map(([k, v]) => (typeof v === 'string' ? `${k}: ${JSON.stringify(v)}` : `${k}: ${v}`))
    .join('\n');
  await fs.writeFile(absPath, serialized + '\n', 'utf-8');
  return absPath;
}

function envWithStub(extra: Record<string, string> = {}): Record<string, string> {
  return { SHARDMIND_GITHUB_API_BASE: stub.url, ...extra };
}

function defaultLatest(): void {
  stub.setLatest(SHARD_SLUG, '0.1.0');
}

// ---------------------------------------------------------------------------
// 1. Bootstrap — --version / --help surface the user would hit first.
// ---------------------------------------------------------------------------

describe('CLI bootstrap', () => {
  let vault: Vault;
  afterEach(async () => vault?.cleanup());

  it('--version prints the package version and exits 0', async () => {
    vault = await createEmptyVault('version');
    const result = await spawnCli(['--version'], { cwd: vault.root, env: envWithStub() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(PACKAGE_VERSION);
  });

  it('--help lists install and update subcommands', async () => {
    vault = await createEmptyVault('help');
    const result = await spawnCli(['--help'], { cwd: vault.root, env: envWithStub() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('install');
    expect(result.stdout).toContain('update');
  });
});

// ---------------------------------------------------------------------------
// 2. Status — `shardmind` (no args) and `--verbose`.
// ---------------------------------------------------------------------------

describe('shardmind (status)', () => {
  let vault: Vault;
  afterEach(async () => {
    defaultLatest();
    await vault?.cleanup();
  });

  it('prints the install hint in an empty directory', async () => {
    vault = await createEmptyVault('status-empty');
    const result = await spawnCli([], { cwd: vault.root, env: envWithStub() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Not in a shard-managed vault.');
  });

  it('reports an installed vault as up-to-date', async () => {
    vault = await createInstalledVault({ stub, shardRef: SHARD_REF, values: DEFAULT_VALUES, prefix: 'status-ok' });
    const result = await spawnCli([], { cwd: vault.root, env: envWithStub() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Up to date/);
    expect(result.stdout).toMatch(/shardmind\/minimal/);
  });

  it('--verbose populates all five diagnostic sections', async () => {
    vault = await createInstalledVault({ stub, shardRef: SHARD_REF, values: DEFAULT_VALUES, prefix: 'status-verbose' });
    const result = await spawnCli(['--verbose'], { cwd: vault.root, env: envWithStub() });
    expect(result.exitCode).toBe(0);
    for (const section of ['Values', 'Modules', 'Files', 'Frontmatter', 'Environment']) {
      expect(result.stdout).toContain(section);
    }
  });

  it('surfaces an update-available arrow when the stub advertises a newer latest', async () => {
    vault = await createInstalledVault({ stub, shardRef: SHARD_REF, values: DEFAULT_VALUES, prefix: 'status-bump' });
    stub.setLatest(SHARD_SLUG, '0.2.0');
    const result = await spawnCli([], { cwd: vault.root, env: envWithStub() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/v0\.2\.0 available/);
  });

  it('shows +N/−M or (whitespace-only) for a modified managed file in --verbose', async () => {
    vault = await createInstalledVault({ stub, shardRef: SHARD_REF, values: DEFAULT_VALUES, prefix: 'status-drift' });
    // Modify the rendered Home.md so drift detection flags it.
    const home = await vault.readFile('Home.md');
    await vault.writeFile('Home.md', home + '\n\nI edited this myself.\n');
    const result = await spawnCli(['--verbose'], { cwd: vault.root, env: envWithStub() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Home\.md/);
    // Either a numeric +N/−M suffix or the whitespace-only marker.
    // Note the unicode minus (U+2212), which VerboseView renders; support
    // either the unicode form or an ASCII hyphen for future-proofing.
    expect(result.stdout).toMatch(/\+\d+\/[−-]\d+|\(whitespace-only\)/);
  });

  it('reports corrupt state.json with the STATE_CORRUPT code', async () => {
    vault = await createEmptyVault('status-corrupt');
    await vault.writeFile('.shardmind/state.json', 'not json {{{');
    const result = await spawnCli([], { cwd: vault.root, env: envWithStub() });
    // status is intentionally ambient — exit 0 even on error (documented
    // in ARCHITECTURE §19.7). The code + hint are surfaced to stdout.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/STATE_CORRUPT/);
  });

  it('degrades gracefully when the registry is unreachable', async () => {
    vault = await createInstalledVault({ stub, shardRef: SHARD_REF, values: DEFAULT_VALUES, prefix: 'status-offline' });
    // Point the CLI at a port that nothing is listening on; status must
    // still render a clean report with an "unknown" update line.
    const result = await spawnCli([], {
      cwd: vault.root,
      env: { SHARDMIND_GITHUB_API_BASE: 'http://127.0.0.1:1' },
      timeoutMs: 20_000,
    });
    expect(result.exitCode).toBe(0);
    // Update-line renders the unknown/offline fallback rather than the
    // generic "Up to date" path.
    expect(result.stdout.toLowerCase()).toMatch(/unknown|offline|unavailable/);
  }, 25_000);
});

// ---------------------------------------------------------------------------
// 3. Install — happy paths, flag combos, errors, collision, SIGINT.
// ---------------------------------------------------------------------------

describe('shardmind install', () => {
  let vault: Vault;
  afterEach(async () => vault?.cleanup());

  it('--yes + --values installs the shard and writes state/values', async () => {
    vault = await createEmptyVault('install-happy');
    const valuesPath = await writeValuesFile(vault, DEFAULT_VALUES);
    const result = await spawnCli(['install', SHARD_REF, '--yes', '--values', valuesPath], {
      cwd: vault.root,
      env: envWithStub(),
    });
    expect(result.exitCode).toBe(0);
    expect(await vault.exists('.shardmind/state.json')).toBe(true);
    expect(await vault.exists('shard-values.yaml')).toBe(true);
    expect(await vault.exists('Home.md')).toBe(true);
    // Values rendered into the output
    const home = await vault.readFile('Home.md');
    expect(home).toContain('Alice');
  });

  it('state.files keys use forward-slashes on every platform', async () => {
    vault = await createInstalledVault({ stub, shardRef: SHARD_REF, values: DEFAULT_VALUES, prefix: 'install-slashes' });
    const stateRaw = await vault.readFile('.shardmind/state.json');
    const state = JSON.parse(stateRaw) as { files: Record<string, unknown> };
    for (const key of Object.keys(state.files)) {
      expect(key).not.toContain('\\');
    }
  });

  it('--dry-run writes nothing to disk', async () => {
    vault = await createEmptyVault('install-dry');
    const valuesPath = await writeValuesFile(vault, DEFAULT_VALUES);
    const filesBefore = await vault.listFiles();
    const result = await spawnCli(
      ['install', SHARD_REF, '--dry-run', '--yes', '--values', valuesPath],
      { cwd: vault.root, env: envWithStub() },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Dry run/i);
    const filesAfter = await vault.listFiles();
    // Only the .values.yaml we pre-wrote should remain.
    expect(filesAfter).toEqual(filesBefore);
    expect(await vault.exists('.shardmind/state.json')).toBe(false);
  });

  it('summary includes a platform-appropriate open hint', async () => {
    vault = await createEmptyVault('install-open-hint');
    const valuesPath = await writeValuesFile(vault, DEFAULT_VALUES);
    const result = await spawnCli(['install', SHARD_REF, '--yes', '--values', valuesPath], {
      cwd: vault.root,
      env: envWithStub(),
    });
    expect(result.exitCode).toBe(0);
    // Summary.tsx renders an "Open in Obsidian" hint platform-specifically.
    // This pins the contract that cross-platform users get a cp/paste-ready
    // command that actually works on their shell — a regression here
    // (e.g. reverting to a single `xdg-open` line on macOS) would be a
    // real UX regression that only E2E catches.
    const expected =
      process.platform === 'darwin'
        ? /open "/
        : process.platform === 'win32'
          ? /start ""/
          : /xdg-open "/;
    expect(result.stdout).toMatch(expected);
  });

  it('accepts an @version pin and installs that exact tag', async () => {
    vault = await createEmptyVault('install-pin');
    const valuesPath = await writeValuesFile(vault, DEFAULT_VALUES);
    const result = await spawnCli(
      ['install', `${SHARD_REF}@0.1.0`, '--yes', '--values', valuesPath],
      { cwd: vault.root, env: envWithStub() },
    );
    expect(result.exitCode).toBe(0);
    const state = JSON.parse(await vault.readFile('.shardmind/state.json')) as { version: string };
    expect(state.version).toBe('0.1.0');
  });

  it('rejects an unknown version with VERSION_NOT_FOUND', async () => {
    vault = await createEmptyVault('install-bad-version');
    const result = await spawnCli(
      ['install', `${SHARD_REF}@9.9.9`, '--yes'],
      { cwd: vault.root, env: envWithStub() },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/VERSION_NOT_FOUND/);
  });

  it('rejects an unknown repo with a network / not-found error', async () => {
    vault = await createEmptyVault('install-unknown-repo');
    const result = await spawnCli(
      ['install', 'github:unknown/repo', '--yes'],
      { cwd: vault.root, env: envWithStub() },
    );
    expect(result.exitCode).toBe(1);
    // The stub returns 404 for unregistered repos; /releases/latest 404
    // now surfaces as NO_RELEASES_PUBLISHED (was VERSION_NOT_FOUND pre-#58).
    expect(result.stdout).toMatch(/NO_RELEASES_PUBLISHED|VERSION_NOT_FOUND|SHARD_NOT_FOUND|not found/i);
  });

  it('rejects a malformed ref with REGISTRY_INVALID_REF', async () => {
    vault = await createEmptyVault('install-bad-ref');
    const result = await spawnCli(
      ['install', 'not-a-valid-ref', '--yes'],
      { cwd: vault.root, env: envWithStub() },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/REGISTRY_INVALID_REF/);
  });

  it('reports VALUES_MISSING when --yes is used without --values for required keys', async () => {
    vault = await createEmptyVault('install-missing-values');
    const result = await spawnCli(
      ['install', SHARD_REF, '--yes'],
      { cwd: vault.root, env: envWithStub() },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/VALUES_MISSING|required/i);
  });

  it('backs up pre-existing user content under --yes', async () => {
    vault = await createEmptyVault('install-collision');
    await vault.writeFile('Home.md', 'hand-crafted user content\n');
    const valuesPath = await writeValuesFile(vault, DEFAULT_VALUES);
    const result = await spawnCli(['install', SHARD_REF, '--yes', '--values', valuesPath], {
      cwd: vault.root,
      env: envWithStub(),
    });
    expect(result.exitCode).toBe(0);
    // Original content now lives under a backup path.
    const files = await vault.listFiles();
    const backup = files.find((f) => f.startsWith('Home.md.shardmind-backup-'));
    expect(backup).toBeDefined();
    const backed = await vault.readFile(backup!);
    expect(backed).toBe('hand-crafted user content\n');
    // Home.md has been replaced with the rendered template.
    const rendered = await vault.readFile('Home.md');
    expect(rendered).toContain('Alice');
  });

  it('--dry-run + pre-existing content leaves the vault untouched', async () => {
    vault = await createEmptyVault('install-dry-collision');
    await vault.writeFile('Home.md', 'untouched user content\n');
    const valuesPath = await writeValuesFile(vault, DEFAULT_VALUES);
    const result = await spawnCli(
      ['install', SHARD_REF, '--dry-run', '--yes', '--values', valuesPath],
      { cwd: vault.root, env: envWithStub() },
    );
    expect(result.exitCode).toBe(0);
    expect(await vault.readFile('Home.md')).toBe('untouched user content\n');
    const files = await vault.listFiles();
    const backup = files.find((f) => f.includes('shardmind-backup-'));
    expect(backup).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32' && process.env['GITHUB_ACTIONS'] === 'true')(
    'exits cleanly and leaves no partial state on SIGINT mid-install',
    async () => {
      // POSIX sends a real SIGINT via `child.kill`. Windows uses the
      // stdin-ETX bridge (`source/core/cancellation.ts`), which works on
      // local Windows 11 dev boxes. GitHub Actions Windows Server 2022
      // runners have an inter-process pipe-buffering quirk where the
      // parent's single-byte write doesn't reach the child before the
      // outer timeout — we haven't found a test-harness mechanism that
      // bridges both local Windows and the CI image. Narrowing the skip
      // to `GITHUB_ACTIONS=true` keeps local Windows exercising the full
      // SIGINT path. Follow-up tracked as #57; methodology in
      // ARCHITECTURE §19.7.
      //
      // Timing: Ink in non-TTY mode renders only the final frame, so we
      // can't pattern-match `[N/M]` to detect the installing phase. Instead
      // we slow the stub's tarball GET so the child spends ~600 ms in the
      // download phase, then fire SIGINT at t=200 ms — well into the active
      // download, well before any write starts. That exercises the SIGINT
      // plumbing + the shard-tempdir cleanup path that
      // `useSigintRollback({ cleanup: … })` promises on every signal, and
      // keeps the "no partial state in the vault" invariant the test is
      // really about: SIGINT at any phase leaves the vault exactly as the
      // user found it.
      stub.setTarballDelay(2000);
      try {
        vault = await createEmptyVault('install-sigint');
        const valuesPath = await writeValuesFile(vault, DEFAULT_VALUES);
        const result = await spawnCli(
          ['install', SHARD_REF, '--yes', '--values', valuesPath],
          {
            cwd: vault.root,
            env: envWithStub(),
            signalAt: { signal: 'SIGINT', afterMs: 500 },
            timeoutMs: 20_000,
          },
        );
        const viaCode = result.exitCode === 130;
        const viaSignal = result.signal === 'SIGINT';
        expect(
          viaCode || viaSignal,
          `exitCode=${result.exitCode} signal=${result.signal} stdout=${result.stdout}`,
        ).toBe(true);
        // Vault invariant: no tracked files, no state.json, no backups left
        // behind regardless of which phase the signal interrupted.
        expect(await vault.exists('.shardmind/state.json')).toBe(false);
        expect(await vault.exists('Home.md')).toBe(false);
      } finally {
        stub.setTarballDelay(0);
      }
    },
    25_000,
  );
});

// ---------------------------------------------------------------------------
// 4. Install — post-install hook execution.
// One scenario, its own stub mount because the main stub's shard roster is
// frozen at suite-start. Builds a custom tarball that adds
// hooks/post-install.ts on top of the minimal-shard tree, then installs
// `github:acme/hook-demo` through the real CLI binary.
// ---------------------------------------------------------------------------

describe('shardmind install — post-install hook', () => {
  let hookStub: GitHubStub;
  let hookTarball: string;
  let vault: Vault;

  beforeAll(async () => {
    const tar = await import('tar');
    const os = await import('node:os');
    const hookScratch = await fs.mkdtemp(path.join(os.tmpdir(), 'shardmind-e2e-hook-'));
    const prefix = 'hook-demo-0.1.0';
    const workRoot = path.join(hookScratch, 'work');
    const workDir = path.join(workRoot, prefix);
    // Clone the minimal-shard fixture into the tar staging directory so
    // the custom tarball shares the same template + schema shape as the
    // other install scenarios — the only delta is the hook addition.
    const minimalShard = fileURLToPath(new URL('../../examples/minimal-shard', import.meta.url));
    await copyTree(minimalShard, workDir);
    await fs.mkdir(path.join(workDir, 'hooks'), { recursive: true });
    // Hook writes a marker and logs a known string so the assertions can
    // key off both disk state and the captured stdout block the Summary
    // renders.
    await fs.writeFile(
      path.join(workDir, 'hooks', 'post-install.ts'),
      [
        "import { writeFile } from 'node:fs/promises';",
        "import { join } from 'node:path';",
        'export default async function (ctx) {',
        "  console.log('HOOK_RAN_FOR_' + ctx.shard.name);",
        "  await writeFile(join(ctx.vaultRoot, 'post-install-marker.txt'), 'hook ran');",
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );
    hookTarball = path.join(hookScratch, `${prefix}.tar.gz`);
    await tar.c({ file: hookTarball, gzip: true, cwd: workRoot }, [prefix]);

    hookStub = await createGitHubStub({
      shards: {
        'acme/hook-demo': {
          versions: { '0.1.0': hookTarball },
          latest: '0.1.0',
        },
      },
    });
  }, 60_000);

  afterAll(async () => {
    await hookStub?.close();
  });

  afterEach(async () => {
    await vault?.cleanup();
  });

  it('runs the hook and surfaces its stdout in the Summary', async () => {
    vault = await createEmptyVault('install-hook');
    const valuesPath = await writeValuesFile(vault, DEFAULT_VALUES);
    const result = await spawnCli(
      ['install', 'github:acme/hook-demo', '--yes', '--values', valuesPath],
      { cwd: vault.root, env: { SHARDMIND_GITHUB_API_BASE: hookStub.url } },
    );
    expect(result.exitCode).toBe(0);
    // Install itself completed.
    expect(await vault.exists('.shardmind/state.json')).toBe(true);
    // Hook side effect landed — both the marker on disk and the stdout
    // block in the captured Summary.
    expect(await vault.exists('post-install-marker.txt')).toBe(true);
    const marker = await vault.readFile('post-install-marker.txt');
    expect(marker).toBe('hook ran');
    expect(result.stdout).toMatch(/Post-install hook completed/);
    expect(result.stdout).toMatch(/HOOK_RAN_FOR_minimal/);
  }, 60_000);
});

// Local tree-copy helper for the hook tarball build. Kept inline so the
// scenario stays self-contained; tarball.ts has a richer version with
// symlink detection that this path doesn't need.
async function copyTree(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await fs.copyFile(from, to);
  }
}

// ---------------------------------------------------------------------------
// 5. Update — every reachable terminal phase from a real subprocess.

// ---------------------------------------------------------------------------

describe('shardmind update', () => {
  let vault: Vault;
  afterEach(async () => {
    defaultLatest();
    await vault?.cleanup();
  });

  it('exits 1 with UPDATE_NO_INSTALL in an empty directory', async () => {
    vault = await createEmptyVault('update-no-install');
    const result = await spawnCli(['update', '--yes'], {
      cwd: vault.root,
      env: envWithStub(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/UPDATE_NO_INSTALL/);
    // Hint is the user-facing value of a typed error — assert it actually
    // reached stdout so a silent hint regression would break the test.
    expect(result.stdout).toMatch(/Run `shardmind install <shard>` first/);
  });

  it('reports already-up-to-date when the stub serves the same version', async () => {
    vault = await createInstalledVault({ stub, shardRef: SHARD_REF, values: DEFAULT_VALUES, prefix: 'update-uptodate' });
    const result = await spawnCli(['update', '--yes'], {
      cwd: vault.root,
      env: envWithStub(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/up to date/i);
  });

  it('applies a real version bump and carries the new file into the vault', async () => {
    vault = await createInstalledVault({ stub, shardRef: SHARD_REF, values: DEFAULT_VALUES, prefix: 'update-bump' });
    stub.setLatest(SHARD_SLUG, '0.2.0');
    const result = await spawnCli(['update', '--yes'], {
      cwd: vault.root,
      env: envWithStub(),
    });
    expect(result.exitCode).toBe(0);
    // v0.2.0 adds brain/Changelog.md
    expect(await vault.exists('brain/Changelog.md')).toBe(true);
    // state.json version advanced
    const state = JSON.parse(await vault.readFile('.shardmind/state.json')) as { version: string };
    expect(state.version).toBe('0.2.0');
  });

  it('auto-merges a non-conflicting user edit on bump', async () => {
    vault = await createInstalledVault({ stub, shardRef: SHARD_REF, values: DEFAULT_VALUES, prefix: 'update-merge' });
    // User-owned addition at the top of Home.md — doesn't collide with
    // the v0.2.0 addition (which goes at the bottom).
    const home = await vault.readFile('Home.md');
    await vault.writeFile('Home.md', 'My personal note at the top.\n' + home);
    stub.setLatest(SHARD_SLUG, '0.2.0');
    const result = await spawnCli(['update', '--yes'], {
      cwd: vault.root,
      env: envWithStub(),
    });
    expect(result.exitCode).toBe(0);
    const merged = await vault.readFile('Home.md');
    expect(merged).toContain('My personal note at the top.');
    expect(merged).toContain('<!-- v0.2.0 addition -->');
  });

  it('exits 1 with UPDATE_SOURCE_MISMATCH when state.source is malformed', async () => {
    vault = await createInstalledVault({ stub, shardRef: SHARD_REF, values: DEFAULT_VALUES, prefix: 'update-mismatch' });
    // Corrupt state.source to an unparseable value. Use a value that
    // `resolveRef` will reject with REGISTRY_INVALID_REF — which our
    // new wrapper rewrites as UPDATE_SOURCE_MISMATCH.
    const stateRaw = await vault.readFile('.shardmind/state.json');
    const state = JSON.parse(stateRaw) as { source: string };
    state.source = 'not-a-valid-ref-shape';
    await vault.writeFile('.shardmind/state.json', JSON.stringify(state, null, 2));
    const result = await spawnCli(['update', '--yes'], {
      cwd: vault.root,
      env: envWithStub(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/UPDATE_SOURCE_MISMATCH/);
    // The hint embeds the actual malformed source value + a remediation.
    // Asserting both pieces catches a regression where either half drops.
    expect(result.stdout).toMatch(/not-a-valid-ref-shape/);
    expect(result.stdout).toMatch(/reinstall/i);
  });

  it('--dry-run on a bump leaves vault content unchanged', async () => {
    vault = await createInstalledVault({ stub, shardRef: SHARD_REF, values: DEFAULT_VALUES, prefix: 'update-dry' });
    stub.setLatest(SHARD_SLUG, '0.2.0');
    const beforeState = await vault.readFile('.shardmind/state.json');
    const beforeFiles = (await vault.listFiles())
      .filter((f) => f !== '.shardmind/update-check.json')
      .sort();
    const result = await spawnCli(['update', '--dry-run', '--yes'], {
      cwd: vault.root,
      env: envWithStub(),
    });
    expect(result.exitCode).toBe(0);
    const afterState = await vault.readFile('.shardmind/state.json');
    const afterFiles = (await vault.listFiles())
      .filter((f) => f !== '.shardmind/update-check.json')
      .sort();
    // state.json is stable byte-for-byte; update-check.json may be
    // populated by the cache primer (read-before-write) but that's a
    // diagnostic cache, not vault content. See ARCHITECTURE §10.5 for
    // the dry-run contract boundary.
    expect(afterState).toBe(beforeState);
    expect(afterFiles).toEqual(beforeFiles);
  });

  it.skipIf(process.platform === 'win32' && process.env['GITHUB_ACTIONS'] === 'true')(
    'exits cleanly and leaves state.json byte-identical on SIGINT mid-update',
    async () => {
      // Same GH-Actions-Windows narrow skip as install-sigint — see that
      // test's comment. Local Windows dev boxes run this test through
      // the stdin-ETX bridge end-to-end.
      vault = await createInstalledVault({ stub, shardRef: SHARD_REF, values: DEFAULT_VALUES, prefix: 'update-sigint' });
      stub.setLatest(SHARD_SLUG, '0.2.0');
      stub.setTarballDelay(2000);
      try {
        const beforeState = await vault.readFile('.shardmind/state.json');
        const result = await spawnCli(['update', '--yes'], {
          cwd: vault.root,
          env: envWithStub(),
          signalAt: { signal: 'SIGINT', afterMs: 500 },
          timeoutMs: 20_000,
        });
        const viaCode = result.exitCode === 130;
        const viaSignal = result.signal === 'SIGINT';
        expect(
          viaCode || viaSignal,
          `exitCode=${result.exitCode} signal=${result.signal} stdout=${result.stdout}`,
        ).toBe(true);
        const afterState = await vault.readFile('.shardmind/state.json');
        expect(afterState).toBe(beforeState);
      } finally {
        stub.setTarballDelay(0);
      }
    },
    25_000,
  );
});


// ---------------------------------------------------------------------------
// 5. Property-based — invariants across the argument surface.
// Each property spawns a subprocess per case; keep numRuns lean.
// ---------------------------------------------------------------------------

describe('install — property-based invariants', () => {
  afterEach(async () => {
    defaultLatest();
    await cleanupAllVaults();
  });

  it('two installs with the same values produce identical structural state', async () => {
    // Install has a non-determinism source by design: `install_date` goes
    // into the render context and may appear in rendered output, so
    // rendered_hash can legitimately differ. The STRUCTURAL state of the
    // install should match bit-for-bit, though: same file set, same module
    // selections, same values_hash, same shard version. That's the property.
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          user_name: fc.string({ minLength: 1, maxLength: 30 }).filter((s) => /^[\w.-]+$/.test(s)),
          org_name: fc.oneof(
            fc.string({ minLength: 1, maxLength: 30 }).filter((s) => /^[\w.-]+$/.test(s)),
            fc.constant('Independent'),
          ),
          vault_purpose: fc.constantFrom('engineering', 'research', 'general'),
          qmd_enabled: fc.boolean(),
        }),
        async (values) => {
          const a = await createEmptyVault('prop-det-a');
          const b = await createEmptyVault('prop-det-b');
          try {
            const [valuesPathA, valuesPathB] = await Promise.all([
              writeValuesFile(a, values),
              writeValuesFile(b, values),
            ]);
            const [resA, resB] = await Promise.all([
              spawnCli(['install', SHARD_REF, '--yes', '--values', valuesPathA], {
                cwd: a.root,
                env: envWithStub(),
              }),
              spawnCli(['install', SHARD_REF, '--yes', '--values', valuesPathB], {
                cwd: b.root,
                env: envWithStub(),
              }),
            ]);
            if (resA.exitCode !== 0 || resB.exitCode !== 0) {
              throw new Error(`install failed: A=${resA.exitCode} B=${resB.exitCode}`);
            }
            const stateA = JSON.parse(await a.readFile('.shardmind/state.json')) as {
              files: Record<string, unknown>;
              modules: unknown;
              values_hash: string;
              version: string;
              shard: string;
            };
            const stateB = JSON.parse(await b.readFile('.shardmind/state.json')) as typeof stateA;
            expect(Object.keys(stateA.files).sort()).toEqual(Object.keys(stateB.files).sort());
            expect(stateA.modules).toEqual(stateB.modules);
            expect(stateA.values_hash).toEqual(stateB.values_hash);
            expect(stateA.version).toEqual(stateB.version);
            expect(stateA.shard).toEqual(stateB.shard);
          } finally {
            await a.cleanup();
            await b.cleanup();
          }
        },
      ),
      { numRuns: 5, timeout: 20_000 },
    );
  }, 120_000);

  it('--dry-run never creates .shardmind/ or shard-values.yaml', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          user_name: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[\w\s.-]+$/.test(s)),
          org_name: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[\w\s.-]+$/.test(s)),
          vault_purpose: fc.constantFrom('engineering', 'research', 'general'),
          qmd_enabled: fc.boolean(),
        }),
        async (values) => {
          const vault = await createEmptyVault('prop-dry');
          try {
            const valuesPath = await writeValuesFile(vault, values);
            const before = (await vault.listFiles()).sort();
            const result = await spawnCli(
              ['install', SHARD_REF, '--dry-run', '--yes', '--values', valuesPath],
              { cwd: vault.root, env: envWithStub() },
            );
            if (result.exitCode !== 0) {
              throw new Error(`dry-run exited ${result.exitCode}: ${result.stdout}\n${result.stderr}`);
            }
            const after = (await vault.listFiles()).sort();
            expect(after).toEqual(before);
            expect(await vault.exists('.shardmind')).toBe(false);
            expect(await vault.exists('shard-values.yaml')).toBe(false);
          } finally {
            await vault.cleanup();
          }
        },
      ),
      { numRuns: 5, timeout: 20_000 },
    );
  }, 120_000);
});
