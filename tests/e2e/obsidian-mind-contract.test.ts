/**
 * v6 contract acceptance suite (issue #92).
 *
 * Drives the obsidian-mind-like fixture (tests/fixtures/shards/
 * obsidian-mind-like/) at three versions (6.0.0, 6.0.1, 6.1.0) through
 * the real CLI subprocess and asserts that every clause of
 * `docs/SHARD-LAYOUT.md`'s contract holds across the matrix:
 *
 *   - Install (defaults / custom values / collisions / hook ctx)
 *   - Update (no edits / non-conflicting edits / conflicts /
 *             new modules / removed files / value changes)
 *   - Adopt (clean clone / edited clone / user files / existing-install
 *            rejection / adopt→update)
 *   - Refs + versions (ref install / ref update / prerelease pin /
 *                       --release pin)
 *   - Additive principle (delete .shardmind/ ; install over no
 *                          .shardmind/ source)
 *   - Hook failure (throw mid-edit / timeout)
 *   - Adversarial (symlink / 1k ignore patterns / mixed-default-type
 *                  defaults / case-insensitive filesystem)
 *
 * Module-deselection scenarios (Claude-only / deselect perf / combined)
 * live in `tests/integration/obsidian-mind-contract.test.ts` because
 * the CLI has no non-interactive `--modules` flag — those go through
 * `runInstall` directly.
 *
 * Hermetic: built on the same `tests/e2e/helpers/github-stub.ts`
 * pattern as `tests/e2e/cli.test.ts`. No public network.
 *
 * Spec citations are inline at each `it(...)` so a future reader can
 * jump from test → spec section without spelunking through this file.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

import { ensureBuilt } from './helpers/build-once.js';
import {
  buildObsidianMindTarballs,
  cleanupObsidianMindTarballs,
  type ObsidianMindTarballs,
} from './helpers/obsidian-mind-tarball.js';
import { createGitHubStub, type GitHubStub } from './helpers/github-stub.js';
import { spawnCli } from './helpers/spawn-cli.js';
import {
  createEmptyVault,
  createInstalledVault,
  cleanupAllVaults,
  type Vault,
} from './helpers/vault.js';

const SHARD_SLUG = 'acme/obs-mind-like';
const SHARD_REF = `github:${SHARD_SLUG}`;

// Custom values that diverge from every literal default in the schema.
// Used by scenarios that need valuesAreDefaults=false in the hook ctx
// so the post-install hook's managed-file branch fires.
const CUSTOM_VALUES = {
  user_name: 'Alice',
  org_name: 'Acme Labs',
  vault_purpose: 'engineering',
  qmd_enabled: true,
  brain_capacity: 100,
};

// Values that match the schema's literal defaults exactly. Asserts
// Invariant 2's positive branch — a post-install hook receiving these
// must not modify any managed file.
const DEFAULT_VALUES = {
  user_name: '',
  org_name: 'Independent',
  vault_purpose: 'engineering',
  qmd_enabled: false,
  brain_capacity: 0,
};

let stub: GitHubStub;
let fixtures: ObsidianMindTarballs;

beforeAll(async () => {
  await ensureBuilt();
  fixtures = await buildObsidianMindTarballs();
  stub = await createGitHubStub({
    shards: {
      [SHARD_SLUG]: {
        versions: {
          '6.0.0': fixtures.byVersion['6.0.0'],
          '6.0.1': fixtures.byVersion['6.0.1'],
          '6.1.0': fixtures.byVersion['6.1.0'],
        },
        latest: '6.0.0',
      },
    },
  });
}, 90_000);

afterAll(async () => {
  await stub?.close();
  await cleanupObsidianMindTarballs();
  await cleanupAllVaults();
});

function envWithStub(extra: Record<string, string> = {}): Record<string, string> {
  return { SHARDMIND_GITHUB_API_BASE: stub.url, ...extra };
}

function defaultLatest(): void {
  stub.setLatest(SHARD_SLUG, '6.0.0');
}

async function writeValuesFile(
  vault: Vault,
  values: Record<string, unknown>,
): Promise<string> {
  const valuesPath = path.join(vault.root, '.values.yaml');
  await fs.writeFile(valuesPath, stringifyYaml(values), 'utf-8');
  return valuesPath;
}

interface HookCtxSnapshot {
  vaultRoot: string;
  values: Record<string, unknown>;
  modules: Record<string, 'included' | 'excluded'>;
  shard: { name: string; version: string };
  valuesAreDefaults: boolean;
  newFiles: string[];
  removedFiles: string[];
  previousVersion?: string;
}

async function readInstallHookCtx(vault: Vault): Promise<HookCtxSnapshot> {
  return JSON.parse(
    await vault.readFile('.hook-ctx-install.json'),
  ) as HookCtxSnapshot;
}

// ---------------------------------------------------------------------------
// Install scenarios — see issue #92 §Install + docs/SHARD-LAYOUT.md
// §Installation invariants.
// ---------------------------------------------------------------------------

describe('install (obsidian-mind-like)', () => {
  let vault: Vault;
  afterEach(async () => {
    defaultLatest();
    await vault?.cleanup();
  });

  it('--defaults installs every file, seeds state.json, and reports valuesAreDefaults=true', async () => {
    // Scenario 1 — docs/SHARD-LAYOUT.md §Installation invariants:
    // `shardmind install --defaults` produces the full vault tree;
    // valuesAreDefaults is true; the post-install hook's managed-file
    // branch is gated off by Invariant 2.
    vault = await createEmptyVault('obs-mind-defaults');
    const result = await spawnCli(['install', SHARD_REF, '--defaults'], {
      cwd: vault.root,
      env: envWithStub(),
    });
    expect(result.exitCode).toBe(0);

    expect(await vault.exists('.shardmind/state.json')).toBe(true);
    expect(await vault.exists('shard-values.yaml')).toBe(true);

    // All vault content modules + agent files present (default = all).
    for (const rel of [
      'CLAUDE.md',
      'AGENTS.md',
      'GEMINI.md',
      '.claude/settings.json',
      '.codex/config.json',
      '.gemini/config.json',
      '.mcp.json',
      'Home.md',
      'brain/North Star.md',
      'brain/Patterns.md',
      'work/README.md',
      'perf/Notes.md',
    ]) {
      expect(await vault.exists(rel)).toBe(true);
    }

    const ctx = await readInstallHookCtx(vault);
    expect(ctx.valuesAreDefaults).toBe(true);
    expect(ctx.newFiles).toEqual([]);
    expect(ctx.removedFiles).toEqual([]);

    // Invariant 2: hook did NOT modify the managed brain/North Star.md
    // when valuesAreDefaults is true.
    const northStar = await vault.readFile('brain/North Star.md');
    expect(northStar).not.toContain('North Star —');
  }, 60_000);

  it('--yes + custom --values renders into dotfolder .njk outputs and personalizes the managed file via the hook', async () => {
    // Scenario 2 — docs/SHARD-LAYOUT.md §Personalization model
    // (Nunjucks rendering + post-install hook): values flow into
    // dotfolder templates; the hook personalizes North Star.md when
    // valuesAreDefaults is false; post-hook re-hash captures the
    // edited bytes (§Hooks, state, and re-hash semantics).
    vault = await createEmptyVault('obs-mind-custom');
    const valuesPath = await writeValuesFile(vault, CUSTOM_VALUES);
    const result = await spawnCli(
      ['install', SHARD_REF, '--yes', '--values', valuesPath],
      { cwd: vault.root, env: envWithStub() },
    );
    expect(result.exitCode).toBe(0);

    // Dotfolder .njk rendered with user values, suffix stripped.
    const settings = JSON.parse(await vault.readFile('.claude/settings.json'));
    expect(settings).toMatchObject({
      user: 'Alice',
      org: 'Acme Labs',
      purpose: 'engineering',
      qmd: true,
    });

    // Hook personalized brain/North Star.md (managed-file mutation
    // gated on !valuesAreDefaults).
    const northStar = await vault.readFile('brain/North Star.md');
    expect(northStar).toContain('North Star — Alice');

    // Post-hook re-hash: state.json's rendered_hash for North Star.md
    // must match the post-edit bytes so a `shardmind` status reports
    // zero drift right after install.
    const { sha256 } = await import('../../source/core/fs-utils.js');
    const expectedHash = sha256(northStar);
    const state = JSON.parse(await vault.readFile('.shardmind/state.json')) as {
      files: Record<string, { rendered_hash: string }>;
    };
    expect(state.files['brain/North Star.md']?.rendered_hash).toBe(expectedHash);

    const ctx = await readInstallHookCtx(vault);
    expect(ctx.valuesAreDefaults).toBe(false);
    expect(ctx.values).toMatchObject({
      user_name: 'Alice',
      qmd_enabled: true,
    });
  }, 60_000);

  it('install into a non-empty directory backs up pre-existing user content under --yes', async () => {
    // Scenario 6 — docs/SHARD-LAYOUT.md §Layout — installed side
    // (collision review on conflicting paths). With --yes, the engine
    // routes every collision through the auto-backup branch so the
    // install is non-destructive.
    vault = await createEmptyVault('obs-mind-collision');
    // Pre-seed a file at a path the shard wants to write.
    await vault.writeFile('CLAUDE.md', '# my pre-existing CLAUDE.md\n');

    const valuesPath = await writeValuesFile(vault, CUSTOM_VALUES);
    const result = await spawnCli(
      ['install', SHARD_REF, '--yes', '--values', valuesPath],
      { cwd: vault.root, env: envWithStub() },
    );
    expect(result.exitCode).toBe(0);

    // Pre-existing content survives next to the original path under a
    // `<orig>.shardmind-backup-<ts>` name; the shard's CLAUDE.md is now
    // at the original path.
    const installedClaude = await vault.readFile('CLAUDE.md');
    expect(installedClaude).toContain('Claude — vault agent');

    const files = await vault.listFiles();
    const backup = files.find((f) => f.startsWith('CLAUDE.md.shardmind-backup-'));
    expect(backup).toBeDefined();
    const backedContent = await vault.readFile(backup!);
    expect(backedContent).toBe('# my pre-existing CLAUDE.md\n');
  }, 60_000);
});
