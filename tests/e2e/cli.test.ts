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
 * Coverage areas (see `docs/ARCHITECTURE.md §19.7` for the methodology):
 *   Bootstrap          — --version / --help
 *   Status             — not-in-vault, quick, verbose, update-available,
 *                        modified-files, corrupt state, offline fallback
 *   Install            — happy + dry-run + verbose + @version + errors +
 *                        collision + BACKUP_FAILED + SIGINT rollback +
 *                        --defaults flag (Invariant 1 mode) + flag conflict
 *                        + over-existing + skips wizard
 *   Install hook       — post-install hook ran + ctx fields + re-hash +
 *                        dry-run note
 *   Install Invariant 1— byte-equivalence vs minimal-shard via
 *                        `verifyInvariant1` (helpers/invariant1.ts)
 *   Install #ref       — branch install + unknown ref error
 *   Update             — no-install typed error, up-to-date, real bump,
 *                        auto-merge with edits, UPDATE_SOURCE_MISMATCH,
 *                        dry-run, SIGINT rollback
 *   Update #ref        — re-resolution on bump + up-to-date when SHA stable
 *   Update flags       — --release pin, --release + --include-prerelease conflict,
 *                        --include-prerelease against beta-only repo
 *   Property           — install determinism + dry-run safety under
 *                        arbitrary value subsets
 *   Adopt              — empty / matching / existing-install / dry-run /
 *                        --yes auto-keep-mine
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
import { verifyInvariant1 } from './helpers/invariant1.js';

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

// Two SHAs shared by ref-install scenarios — content is opaque to the
// stub, so any 40-char hex pair works. The tarballs they point at are
// the same fixtures the tag-install tests use; the ref-install path
// just addresses them by SHA instead of `v<version>`.
const REF_SHA_BASE = 'a'.repeat(40);
const REF_SHA_BUMP = 'b'.repeat(40);

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
        // Pre-seed a `main` ref for ref-install scenarios. Tests that
        // need to bump `main` to a new SHA call `stub.setRef(...)` to
        // change the mapping; tests that don't need it ignore it.
        refs: { main: REF_SHA_BASE },
        shaTarballs: { [REF_SHA_BASE]: fixtures.byVersion['0.1.0'] },
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

/**
 * Reset the `main` ref to its base SHA between ref-aware tests. Mirrors
 * `defaultLatest()` for tag installs — without it, a previous test's
 * `setRef` would leak into the next run and produce confusing "already
 * bumped" failures.
 */
function defaultRef(): void {
  stub.setRef(SHARD_SLUG, 'main', REF_SHA_BASE, fixtures.byVersion['0.1.0']);
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

  it('--help lists install, update, and adopt subcommands', async () => {
    vault = await createEmptyVault('help');
    const result = await spawnCli(['--help'], { cwd: vault.root, env: envWithStub() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('install');
    expect(result.stdout).toContain('update');
    expect(result.stdout).toContain('adopt');
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
    // The stub returns 404 for unregistered repos; the post-#76
    // `/releases?per_page=N` 404 surfaces as SHARD_NOT_FOUND
    // (was VERSION_NOT_FOUND pre-#58, NO_RELEASES_PUBLISHED pre-#76).
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

  it('--yes installs successfully without --values when every schema value has a default', async () => {
    vault = await createEmptyVault('install-yes-defaults');
    const result = await spawnCli(
      ['install', SHARD_REF, '--yes'],
      { cwd: vault.root, env: envWithStub() },
    );
    expect(result.exitCode).toBe(0);
    expect(await vault.exists('.shardmind/state.json')).toBe(true);
    expect(await vault.exists('shard-values.yaml')).toBe(true);
  });

  it('--defaults installs the shard non-interactively using schema defaults', async () => {
    // Invariant 1 mode: no --values, all defaults, all modules. Pins the
    // happy path the byte-equivalence test (later in this file) builds on.
    vault = await createEmptyVault('install-defaults');
    const result = await spawnCli(
      ['install', SHARD_REF, '--defaults'],
      { cwd: vault.root, env: envWithStub() },
    );
    expect(result.exitCode).toBe(0);
    expect(await vault.exists('.shardmind/state.json')).toBe(true);
    expect(await vault.exists('shard-values.yaml')).toBe(true);
    // Schema defaults render through to disk: org_name='Independent',
    // user_name='' (empty literal default in examples/minimal-shard's schema).
    const home = await vault.readFile('Home.md');
    expect(home).toContain('Vault entry point for Independent');
    // shard-values.yaml carries the defaults verbatim.
    const values = await vault.readFile('shard-values.yaml');
    expect(values).toContain("org_name: Independent");
    expect(values).toContain('vault_purpose: engineering');
    expect(values).toContain('qmd_enabled: false');
  });

  it('--defaults rejects --values with INSTALL_FLAG_CONFLICT before any network call', async () => {
    // Pre-flight check: --defaults uses schema defaults; --values would
    // override them. The two are contradictory by construction. Mirrors
    // UPDATE_FLAG_CONFLICT (#76) for --release + --include-prerelease.
    vault = await createEmptyVault('install-defaults-with-values');
    const valuesPath = await writeValuesFile(vault, DEFAULT_VALUES);
    const result = await spawnCli(
      ['install', SHARD_REF, '--defaults', '--values', valuesPath],
      { cwd: vault.root, env: envWithStub() },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/INSTALL_FLAG_CONFLICT/);
    expect(result.stdout).toMatch(/--defaults and --values cannot be combined/);
    // Pre-flight check: nothing on disk.
    expect(await vault.exists('.shardmind/state.json')).toBe(false);
    expect(await vault.exists('shard-values.yaml')).toBe(false);
  });

  it('--defaults refuses to overwrite an existing install with INSTALL_DEFAULTS_OVER_EXISTING', async () => {
    // --defaults is the deterministic CI mode: the existing-install gate
    // requires interactive input that --defaults can't provide, so the
    // engine errors cleanly before any network call. Hint points at
    // `shardmind update` or removing .shardmind/.
    vault = await createInstalledVault({
      stub,
      shardRef: SHARD_REF,
      values: DEFAULT_VALUES,
      prefix: 'install-defaults-over-existing',
    });
    const result = await spawnCli(
      ['install', SHARD_REF, '--defaults'],
      { cwd: vault.root, env: envWithStub() },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/INSTALL_DEFAULTS_OVER_EXISTING/);
    expect(result.stdout).toMatch(/already shardmind-managed/);
    expect(result.stdout).toMatch(/shardmind update/);
  });

  it('--defaults skips the wizard (no value prompts in stdout)', async () => {
    // Skipping the wizard is what makes --defaults usable in CI / scripts:
    // no terminal-interaction strings hit stdout, so a non-TTY parent never
    // sees a prompt that would block on stdin.
    vault = await createEmptyVault('install-defaults-no-wizard');
    const result = await spawnCli(
      ['install', SHARD_REF, '--defaults'],
      { cwd: vault.root, env: envWithStub() },
    );
    expect(result.exitCode).toBe(0);
    // The wizard's value-collection screen renders prompts using messages
    // from the schema; minimal-shard uses 'How will you use this vault?'
    // and 'Your name'. Their absence in the captured stdout pins the
    // wizard-skip path.
    expect(result.stdout).not.toMatch(/How will you use this vault\?/);
    expect(result.stdout).not.toMatch(/Your name/);
  });

  it('--defaults auto-backs-up pre-existing user content at a planned-write path', async () => {
    // The non-interactive backup path was previously gated on `--yes`;
    // the simplify pass widened it to fire on either flag (`yes ||
    // defaults`), since the collision UI requires interactive input
    // neither mode can provide. Pin the new branch end-to-end so a
    // future regression that re-narrows it to `--yes` is caught.
    vault = await createEmptyVault('install-defaults-collision');
    await vault.writeFile('Home.md', 'hand-crafted user content\n');
    const result = await spawnCli(
      ['install', SHARD_REF, '--defaults'],
      { cwd: vault.root, env: envWithStub() },
    );
    expect(result.exitCode).toBe(0);
    const files = await vault.listFiles();
    const backup = files.find((f) => f.startsWith('Home.md.shardmind-backup-'));
    expect(backup).toBeDefined();
    const backed = await vault.readFile(backup!);
    expect(backed).toBe('hand-crafted user content\n');
    // Home.md is the rendered template, not the user's original.
    const rendered = await vault.readFile('Home.md');
    expect(rendered).not.toBe('hand-crafted user content\n');
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
// 4. Install — Invariant 1 byte-equivalence gate.
// `shardmind install --defaults` must produce a vault that satisfies
// `verifyInvariant1` against `examples/minimal-shard/`. This is the
// CI test the spec promises (docs/SHARD-LAYOUT.md §Installation invariants).
// ---------------------------------------------------------------------------

describe('shardmind install — Invariant 1', () => {
  let vault: Vault;
  afterEach(async () => vault?.cleanup());

  it('--defaults produces a vault that satisfies Invariant 1 against examples/minimal-shard/', async () => {
    // The contract test. Source-of-truth for "clone" is the example dir
    // the tarball is built from — content-equivalent by construction
    // (tarball.ts copies the tree verbatim and bumps shard.yaml's version
    // field, which lives under .shardmind/ on both sides and is therefore
    // Tier 1-excluded clone-side and engine-metadata-excluded install-side).
    //
    // A clean report — three mismatch arrays empty, with `matched`
    // checked separately below — means the engine produced exactly the
    // file set the contract demands: every clone-side static file present
    // byte-equivalent, every clone-side `.njk` present at the stripped
    // install path, no Tier 1 leak, no `.shardmindignore` leak, no
    // extras beyond engine metadata.
    vault = await createEmptyVault('install-invariant1');
    const installResult = await spawnCli(
      ['install', SHARD_REF, '--defaults'],
      { cwd: vault.root, env: envWithStub() },
    );
    expect(installResult.exitCode).toBe(0);

    const cloneDir = fileURLToPath(new URL('../../examples/minimal-shard', import.meta.url));
    const report = await verifyInvariant1({ cloneDir, installDir: vault.root });

    // Failure messages need to point at the exact divergence — naming
    // each array in its own assertion gives vitest's diff a useful
    // header instead of one mega-object that hides which contract broke.
    expect(report.staticByteMismatches).toEqual([]);
    expect(report.missingFromInstall).toEqual([]);
    expect(report.extrasInInstall).toEqual([]);
    // Sanity check — minimal-shard has 6 paths after Tier 1 +
    // .shardmindignore filtering (1 .shardmindignore + 1 CLAUDE.md +
    // 1 .claude/commands/example-command.md + 3 `.njk` templates).
    expect(report.matched).toBe(6);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 5. Install — post-install hook execution.
// One scenario, its own stub mount because the main stub's shard roster is
// frozen at suite-start. Builds a custom tarball that adds
// hooks/post-install.ts on top of the minimal-shard tree, then installs
// `github:acme/hook-demo` through the real CLI binary.
// ---------------------------------------------------------------------------

describe('shardmind install — post-install hook', () => {
  let hookStub: GitHubStub;
  let hookTarball: string;
  let hookScratch: string;
  let vault: Vault;

  beforeAll(async () => {
    const tar = await import('tar');
    const os = await import('node:os');
    hookScratch = await fs.mkdtemp(path.join(os.tmpdir(), 'shardmind-e2e-hook-'));
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
        "import { writeFile, appendFile } from 'node:fs/promises';",
        "import { join } from 'node:path';",
        'export default async function (ctx) {',
        "  console.log('HOOK_RAN_FOR_' + ctx.shard.name);",
        "  await writeFile(join(ctx.vaultRoot, 'post-install-marker.txt'), 'hook ran');",
        // Always echo the full ctx so the new-fields tests below can
        // assert what the hook actually received. Existing tests don't
        // read this file, so they're unaffected.
        "  await writeFile(join(ctx.vaultRoot, '.hook-ctx.json'), JSON.stringify(ctx));",
        // Re-hash test marker: when SHARDMIND_REHASH_TEST=1 is set in
        // the hook's env, edit a managed file (Home.md). The post-hook
        // re-hash should pick up the new bytes and update state.json's
        // hash so a subsequent `shardmind` status reports zero drift.
        "  if (process.env.SHARDMIND_REHASH_TEST === '1') {",
        "    await appendFile(join(ctx.vaultRoot, 'Home.md'), '\\n<!-- POST-HOOK-EDIT -->\\n');",
        '  }',
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
    // Clean up the tarball staging dir. Without this, repeated test runs
    // leak %TEMP%\shardmind-e2e-hook-* directories (~200 KB each) that
    // Windows CI eventually fails to open new temp dirs inside.
    if (hookScratch) {
      await fs.rm(hookScratch, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
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

  it('passes valuesAreDefaults / newFiles / removedFiles into the hook ctx (#75)', async () => {
    // DEFAULT_VALUES diverges from the schema's literal defaults
    // (user_name: 'Alice' vs '', qmd_enabled: true vs false) so the
    // hook receives valuesAreDefaults: false. newFiles + removedFiles
    // are empty on every clean install per spec line 130.
    vault = await createEmptyVault('install-hook-ctx');
    const valuesPath = await writeValuesFile(vault, DEFAULT_VALUES);
    const result = await spawnCli(
      ['install', 'github:acme/hook-demo', '--yes', '--values', valuesPath],
      { cwd: vault.root, env: { SHARDMIND_GITHUB_API_BASE: hookStub.url } },
    );
    expect(result.exitCode).toBe(0);
    const ctx = JSON.parse(await vault.readFile('.hook-ctx.json')) as {
      valuesAreDefaults: boolean;
      newFiles: string[];
      removedFiles: string[];
      values: Record<string, unknown>;
    };
    expect(ctx.valuesAreDefaults).toBe(false);
    expect(ctx.newFiles).toEqual([]);
    expect(ctx.removedFiles).toEqual([]);
    expect(ctx.values).toMatchObject({ user_name: 'Alice', qmd_enabled: true });
  }, 60_000);

  it('reports valuesAreDefaults: true when every value matches the schema default (#75)', async () => {
    // Pin the Invariant 2 positive branch end-to-end. The hook-demo
    // tarball is built from examples/minimal-shard, whose literal
    // defaults are user_name='' / org_name='Independent' /
    // vault_purpose='engineering' / qmd_enabled=false. Passing those
    // verbatim must yield valuesAreDefaults: true so a hook author
    // gating managed-file edits with `if (!ctx.valuesAreDefaults)`
    // can trust the signal.
    vault = await createEmptyVault('install-hook-ctx-defaults');
    const valuesPath = await writeValuesFile(vault, {
      user_name: '',
      org_name: 'Independent',
      vault_purpose: 'engineering',
      qmd_enabled: false,
    });
    const result = await spawnCli(
      ['install', 'github:acme/hook-demo', '--yes', '--values', valuesPath],
      { cwd: vault.root, env: { SHARDMIND_GITHUB_API_BASE: hookStub.url } },
    );
    expect(result.exitCode).toBe(0);
    const ctx = JSON.parse(await vault.readFile('.hook-ctx.json')) as {
      valuesAreDefaults: boolean;
    };
    expect(ctx.valuesAreDefaults).toBe(true);
  }, 60_000);

  it('--defaults populates valuesAreDefaults: true without a --values file (#78)', async () => {
    // Sibling to the test above, but driven by `--defaults` instead of
    // `--yes --values <file>`. Pins that the Invariant 1 mode produces
    // the same hook ctx as a hand-rolled defaults values file: any
    // future divergence (e.g. `--defaults` skipping computed-default
    // resolution) would silently break Invariant 2 for hook authors.
    vault = await createEmptyVault('install-defaults-hook-ctx');
    const result = await spawnCli(
      ['install', 'github:acme/hook-demo', '--defaults'],
      { cwd: vault.root, env: { SHARDMIND_GITHUB_API_BASE: hookStub.url } },
    );
    expect(result.exitCode).toBe(0);
    const ctx = JSON.parse(await vault.readFile('.hook-ctx.json')) as {
      valuesAreDefaults: boolean;
      newFiles: string[];
      removedFiles: string[];
    };
    expect(ctx.valuesAreDefaults).toBe(true);
    expect(ctx.newFiles).toEqual([]);
    expect(ctx.removedFiles).toEqual([]);
  }, 60_000);

  it('re-hashes managed files after a hook that edits one (#75)', async () => {
    // Hook appends to Home.md under SHARDMIND_REHASH_TEST=1. After
    // install completes, state.json's `rendered_hash` for Home.md must
    // reflect the post-edit bytes so `shardmind` status sees zero
    // drift — that's the spec's enforceable claim
    // (docs/SHARD-LAYOUT.md §Hooks, state, and re-hash semantics).
    vault = await createEmptyVault('install-hook-rehash');
    const valuesPath = await writeValuesFile(vault, DEFAULT_VALUES);
    const result = await spawnCli(
      ['install', 'github:acme/hook-demo', '--yes', '--values', valuesPath],
      {
        cwd: vault.root,
        env: { SHARDMIND_GITHUB_API_BASE: hookStub.url, SHARDMIND_REHASH_TEST: '1' },
      },
    );
    expect(result.exitCode).toBe(0);

    const homeContent = await vault.readFile('Home.md');
    expect(homeContent).toContain('<!-- POST-HOOK-EDIT -->');

    const { sha256 } = await import('../../source/core/fs-utils.js');
    const expectedHash = sha256(homeContent);

    const state = JSON.parse(await vault.readFile('.shardmind/state.json')) as {
      files: Record<string, { rendered_hash: string }>;
    };
    expect(state.files['Home.md']).toBeDefined();
    expect(state.files['Home.md']!.rendered_hash).toBe(expectedHash);
  }, 60_000);

  it('surfaces "skipped (dry run)" when a hook is declared under --dry-run', async () => {
    // Pins the machine-level dry-run→deferred routing fix from Copilot
    // review commit a82db6b. Previously both install + update machines
    // set `hookSummary = null` under dryRun, silently defeating the
    // four-branch Summary renderer's `deferred` note — which contradicted
    // docs/ARCHITECTURE.md §9.3's statement that `deferred` is the
    // dry-run shape. Without this E2E guard, a future refactor could
    // silently regress back to the null-in-dry-run shape and the unit
    // tests wouldn't notice (they test the render given `deferred: true`,
    // not the machine's production of it).
    vault = await createEmptyVault('install-hook-dryrun');
    const valuesPath = await writeValuesFile(vault, DEFAULT_VALUES);
    const result = await spawnCli(
      ['install', 'github:acme/hook-demo', '--dry-run', '--yes', '--values', valuesPath],
      { cwd: vault.root, env: { SHARDMIND_GITHUB_API_BASE: hookStub.url } },
    );
    expect(result.exitCode).toBe(0);
    // Dry run: no writes.
    expect(await vault.exists('.shardmind/state.json')).toBe(false);
    expect(await vault.exists('post-install-marker.txt')).toBe(false);
    // But the summary must ANNOUNCE the hook would have fired — even
    // though its body didn't execute. Ink soft-wraps; collapse whitespace
    // before the substring check so terminal width can't flake the
    // assertion.
    const collapsed = result.stdout.replace(/\s+/g, ' ');
    expect(collapsed).toContain('Post-install hook skipped (dry run).');
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
// 5. Ref installs (#76) — branch / tag / SHA addressing.
// `github:owner/repo#<ref>` resolves to a commit SHA via /commits/<ref>,
// pins the install to that SHA, and re-resolves the same ref on every
// future `shardmind update` so the vault tracks the moving ref.
// ---------------------------------------------------------------------------

describe('shardmind install — #ref syntax', () => {
  let vault: Vault;
  afterEach(async () => {
    defaultRef();
    defaultLatest();
    await vault?.cleanup();
  });

  it('installs from #main and records ref + resolvedSha in state.json', async () => {
    vault = await createEmptyVault('install-ref-main');
    const valuesPath = await writeValuesFile(vault, DEFAULT_VALUES);
    const result = await spawnCli(
      ['install', `${SHARD_REF}#main`, '--yes', '--values', valuesPath],
      { cwd: vault.root, env: envWithStub() },
    );
    expect(result.exitCode).toBe(0);

    const state = JSON.parse(await vault.readFile('.shardmind/state.json')) as {
      ref?: string;
      resolvedSha?: string;
      version: string;
    };
    expect(state.ref).toBe('main');
    expect(state.resolvedSha).toBe(REF_SHA_BASE);
    // state.version still tracks manifest.version (the v0.1.0 fixture's
    // shard.yaml `version` field) regardless of ref addressing.
    expect(state.version).toBe('0.1.0');
  });

  it('exits 1 with REF_NOT_FOUND for an unknown ref', async () => {
    vault = await createEmptyVault('install-ref-bogus');
    const result = await spawnCli(
      ['install', `${SHARD_REF}#does-not-exist`, '--yes'],
      { cwd: vault.root, env: envWithStub() },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/REF_NOT_FOUND/);
    // Ref name shows up in the message so the user knows what was missing.
    expect(result.stdout).toContain('does-not-exist');
  });
});

describe('shardmind update — #ref re-resolution', () => {
  let vault: Vault;
  afterEach(async () => {
    defaultRef();
    defaultLatest();
    await vault?.cleanup();
  });

  it('re-fetches when the tracked ref bumps to a new SHA', async () => {
    vault = await createEmptyVault('update-ref-bump');
    const valuesPath = await writeValuesFile(vault, DEFAULT_VALUES);

    // Install via ref: state.ref='main', state.resolvedSha=BASE.
    const installResult = await spawnCli(
      ['install', `${SHARD_REF}#main`, '--yes', '--values', valuesPath],
      { cwd: vault.root, env: envWithStub() },
    );
    expect(installResult.exitCode).toBe(0);

    // Branch HEAD bumps upstream — `main` now points at a new SHA
    // backed by the v0.2.0 tarball (which adds `brain/Changelog.md`).
    stub.setRef(SHARD_SLUG, 'main', REF_SHA_BUMP, fixtures.byVersion['0.2.0']);

    const updateResult = await spawnCli(['update', '--yes'], {
      cwd: vault.root,
      env: envWithStub(),
    });
    expect(updateResult.exitCode).toBe(0);

    const state = JSON.parse(await vault.readFile('.shardmind/state.json')) as {
      ref?: string;
      resolvedSha?: string;
      version: string;
    };
    expect(state.ref).toBe('main');
    expect(state.resolvedSha).toBe(REF_SHA_BUMP);
    expect(state.version).toBe('0.2.0');
    // The v0.2.0-only file now exists — proves the tarball was fetched
    // and the merge engine ran.
    expect(await vault.exists('brain/Changelog.md')).toBe(true);
  });

  it('reports up-to-date when the ref still points at the same SHA', async () => {
    vault = await createEmptyVault('update-ref-stable');
    const valuesPath = await writeValuesFile(vault, DEFAULT_VALUES);
    const installResult = await spawnCli(
      ['install', `${SHARD_REF}#main`, '--yes', '--values', valuesPath],
      { cwd: vault.root, env: envWithStub() },
    );
    expect(installResult.exitCode).toBe(0);

    // No setRef — main keeps pointing at REF_SHA_BASE.
    const updateResult = await spawnCli(['update', '--yes'], {
      cwd: vault.root,
      env: envWithStub(),
    });
    expect(updateResult.exitCode).toBe(0);
    expect(updateResult.stdout).toMatch(/up to date/i);
  });
});

describe('shardmind update — flag combinations', () => {
  let vault: Vault;
  afterEach(async () => {
    defaultLatest();
    await vault?.cleanup();
  });

  it('--release pins to the requested tag and skips latest-resolution', async () => {
    vault = await createInstalledVault({
      stub,
      shardRef: SHARD_REF,
      values: DEFAULT_VALUES,
      prefix: 'update-pin-release',
    });
    // Stub still advertises 0.1.0 as latest — `--release 0.2.0` should
    // win regardless of what the listing says.
    const result = await spawnCli(['update', '--yes', '--release', '0.2.0'], {
      cwd: vault.root,
      env: envWithStub(),
    });
    expect(result.exitCode).toBe(0);

    const state = JSON.parse(await vault.readFile('.shardmind/state.json')) as { version: string };
    expect(state.version).toBe('0.2.0');
    // v0.2.0-only file is present.
    expect(await vault.exists('brain/Changelog.md')).toBe(true);
  });

  it('rejects --release + --include-prerelease with UPDATE_FLAG_CONFLICT', async () => {
    vault = await createInstalledVault({
      stub,
      shardRef: SHARD_REF,
      values: DEFAULT_VALUES,
      prefix: 'update-flag-conflict',
    });
    const result = await spawnCli(
      ['update', '--yes', '--release', '0.2.0', '--include-prerelease'],
      { cwd: vault.root, env: envWithStub() },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/UPDATE_FLAG_CONFLICT/);
  });
});

// `--include-prerelease` against a beta-only repo needs a stub mount
// whose `releases` listing carries no stable entries. Inline fixture so
// the main stub's `acme/demo` keeps its conventional shape.
describe('shardmind update — --include-prerelease against a beta-only repo', () => {
  let betaStub: GitHubStub;
  let vault: Vault;

  beforeAll(async () => {
    betaStub = await createGitHubStub({
      shards: {
        ['beta/only']: {
          versions: {
            '2.0.0-beta.1': fixtures.byVersion['0.2.0'],
          },
          // `latest` is unused here because `releases` overrides the
          // single-stable derivation.
          latest: '2.0.0-beta.1',
          releases: [{ tag_name: 'v2.0.0-beta.1', prerelease: true }],
        },
      },
    });
  }, 60_000);

  afterAll(async () => {
    await betaStub?.close();
  });

  afterEach(async () => {
    await vault?.cleanup();
  });

  function envWithBetaStub(): Record<string, string> {
    return { SHARDMIND_GITHUB_API_BASE: betaStub.url };
  }

  it('default update on a beta-only repo throws NO_RELEASES_PUBLISHED with an --include-prerelease hint', async () => {
    vault = await createInstalledVault({
      stub: betaStub,
      shardRef: 'github:beta/only@2.0.0-beta.1',
      values: DEFAULT_VALUES,
      prefix: 'update-beta-default',
    });
    const result = await spawnCli(['update', '--yes'], {
      cwd: vault.root,
      env: envWithBetaStub(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/NO_RELEASES_PUBLISHED/);
    expect(result.stdout).toMatch(/--include-prerelease/);
  });

  it('--include-prerelease widens to the prerelease and reports up-to-date', async () => {
    vault = await createInstalledVault({
      stub: betaStub,
      shardRef: 'github:beta/only@2.0.0-beta.1',
      values: DEFAULT_VALUES,
      prefix: 'update-beta-widen',
    });
    const result = await spawnCli(['update', '--yes', '--include-prerelease'], {
      cwd: vault.root,
      env: envWithBetaStub(),
    });
    expect(result.exitCode).toBe(0);
    // Same prerelease tarball the install used; the bump-detection logic
    // confirms tarball_sha256 + version match → up-to-date.
    expect(result.stdout).toMatch(/up to date/i);
  });
});


// ---------------------------------------------------------------------------
// 6. Property-based — invariants across the argument surface.
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
      // Per-case budget 45s: a single case spawns TWO concurrent CLI
      // subprocesses, each doing a full install against the stub. macOS
      // CI runners occasionally hit 20-25s under contention — same class
      // of variance PR #59 compensated for by bumping the default E2E
      // test timeout 15s → 45s (commit f14f1066).
      { numRuns: 5, timeout: 45_000 },
    );
    // Outer budget must envelope the fast-check worst case:
    // numRuns(5) × per-case(45s) = 225s theoretical max + ~15s for
    // setup/teardown/fast-check overhead. 240s sized to absorb that
    // without the outer vitest timeout racing the fast-check ceiling.
    // Typical-case wall-clock is ~20s; the outer budget is a
    // safety-catch for CI variance, not the expected runtime.
  }, 240_000);

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
      // 45s per case for macOS CI variance parity — see the sibling
      // property test above for rationale. This property spawns only
      // ONE install per case (vs. the sibling's two), so it's unlikely
      // to hit the 20s ceiling, but keeping the budget consistent
      // prevents future drift when the test body grows.
      { numRuns: 5, timeout: 45_000 },
    );
    // Outer budget envelopes the fast-check worst case: 5 × 45s + overhead.
    // Same sizing as the sibling property above.
  }, 240_000);
});

// ---------------------------------------------------------------------------
// 11. Adopt — `shardmind adopt <shard>` retrofits the engine onto an
// existing un-managed vault. Spec: docs/SHARD-LAYOUT.md §Adopt semantics.
// ---------------------------------------------------------------------------

describe('shardmind adopt', () => {
  let vault: Vault;
  afterEach(async () => vault?.cleanup());

  it('--yes adopts an empty vault — every shard file installs fresh', async () => {
    vault = await createEmptyVault('adopt-empty');
    const valuesPath = await writeValuesFile(vault, DEFAULT_VALUES);
    const result = await spawnCli(['adopt', SHARD_REF, '--yes', '--values', valuesPath], {
      cwd: vault.root,
      env: envWithStub(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Adopted');
    expect(result.stdout).toContain('installed fresh');
    expect(await vault.exists('.shardmind/state.json')).toBe(true);
    expect(await vault.exists('shard-values.yaml')).toBe(true);
    expect(await vault.exists('Home.md')).toBe(true);
  });

  it('classifies a vault that matches the shard byte-for-byte as `matched` (no overwrites)', async () => {
    // Pre-install via `createInstalledVault` so the user vault contains
    // the post-install bytes, then strip engine state to simulate a
    // git clone of those bytes. Adopt should classify static-content
    // files as `matches` and install_date templates as `differs` (the
    // user's install_date floats with `Date.now`, so re-render produces
    // different bytes — this is the spec's post-render-byte-equality
    // rule playing out).
    vault = await createInstalledVault({
      stub,
      shardRef: SHARD_REF,
      values: DEFAULT_VALUES,
      prefix: 'adopt-matching',
    });
    // Strip `.shardmind/` + `shard-values.yaml` to simulate a fresh
    // clone of the install output.
    await fs.rm(path.join(vault.root, '.shardmind'), { recursive: true, force: true });
    await fs.rm(path.join(vault.root, 'shard-values.yaml'), { force: true });

    const valuesPath = await writeValuesFile(vault, DEFAULT_VALUES);
    const result = await spawnCli(['adopt', SHARD_REF, '--yes', '--values', valuesPath], {
      cwd: vault.root,
      env: envWithStub(),
    });
    expect(result.exitCode).toBe(0);
    // At least the static-content files (CLAUDE.md, the example
    // command, the values-only settings template) match exactly.
    expect(result.stdout).toMatch(/\d+ matched the shard exactly/);
    // Engine metadata was written.
    expect(await vault.exists('.shardmind/state.json')).toBe(true);
    const state = JSON.parse(await vault.readFile('.shardmind/state.json')) as {
      files: Record<string, { ownership: string }>;
    };
    // Every file in state.files is either managed (matches / use_shard)
    // or modified (keep_mine).
    const ownerships = Object.values(state.files).map((f) => f.ownership);
    for (const o of ownerships) expect(['managed', 'modified']).toContain(o);
  });

  it('rejects adopt when the vault is already shardmind-managed', async () => {
    vault = await createInstalledVault({
      stub,
      shardRef: SHARD_REF,
      values: DEFAULT_VALUES,
      prefix: 'adopt-already',
    });
    const valuesPath = await writeValuesFile(vault, DEFAULT_VALUES);
    const result = await spawnCli(['adopt', SHARD_REF, '--yes', '--values', valuesPath], {
      cwd: vault.root,
      env: envWithStub(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain('ADOPT_EXISTING_INSTALL');
    expect(result.stdout + result.stderr).toMatch(/shardmind update/);
  });

  it('--dry-run writes nothing', async () => {
    vault = await createEmptyVault('adopt-dry');
    const valuesPath = await writeValuesFile(vault, DEFAULT_VALUES);
    const filesBefore = (await vault.listFiles()).sort();
    const result = await spawnCli(
      ['adopt', SHARD_REF, '--dry-run', '--yes', '--values', valuesPath],
      { cwd: vault.root, env: envWithStub() },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Dry run/i);
    const filesAfter = (await vault.listFiles()).sort();
    expect(filesAfter).toEqual(filesBefore);
    expect(await vault.exists('.shardmind/state.json')).toBe(false);
    expect(await vault.exists('shard-values.yaml')).toBe(false);
  });

  it('--yes auto-keep-mine on a divergent file preserves user bytes + records as managed', async () => {
    // Pre-install, strip engine state, modify CLAUDE.md, re-adopt.
    // Under --yes adopt picks `keep_mine` for every differs entry, so
    // the modified bytes survive intact and state records ownership =
    // 'modified' with the user's hash.
    vault = await createInstalledVault({
      stub,
      shardRef: SHARD_REF,
      values: DEFAULT_VALUES,
      prefix: 'adopt-keepmine',
    });
    await fs.rm(path.join(vault.root, '.shardmind'), { recursive: true, force: true });
    await fs.rm(path.join(vault.root, 'shard-values.yaml'), { force: true });

    const myCustomBytes = '# CLAUDE — bespoke override\n';
    await vault.writeFile('CLAUDE.md', myCustomBytes);

    const valuesPath = await writeValuesFile(vault, DEFAULT_VALUES);
    const result = await spawnCli(['adopt', SHARD_REF, '--yes', '--values', valuesPath], {
      cwd: vault.root,
      env: envWithStub(),
    });
    expect(result.exitCode).toBe(0);

    const claudeAfter = await vault.readFile('CLAUDE.md');
    expect(claudeAfter).toBe(myCustomBytes);

    const state = JSON.parse(await vault.readFile('.shardmind/state.json')) as {
      files: Record<string, { ownership: string }>;
    };
    expect(state.files['CLAUDE.md']?.ownership).toBe('modified');
  });
});
