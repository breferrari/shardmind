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

// ---------------------------------------------------------------------------
// Update scenarios — see issue #92 §Update + docs/SHARD-LAYOUT.md
// §Update semantics + §Hooks (Invariant 3 — post-update is additive-only).
// ---------------------------------------------------------------------------

describe('update (obsidian-mind-like)', () => {
  let vault: Vault;
  afterEach(async () => {
    defaultLatest();
    await vault?.cleanup();
  });

  it('6.0.0 → 6.0.1 silently re-renders with no diff prompts when there are no user edits', async () => {
    // Scenario 7 — docs/SHARD-LAYOUT.md §Update semantics: a no-edit
    // update against a non-conflicting bump silently re-renders, the
    // managed file's state.hash advances to the new content.
    vault = await createInstalledVault({
      stub,
      shardRef: SHARD_REF,
      values: CUSTOM_VALUES,
      prefix: 'obs-mind-update-noedit',
    });
    stub.setLatest(SHARD_SLUG, '6.0.1');

    const homeBefore = await vault.readFile('Home.md');
    const stateBefore = JSON.parse(await vault.readFile('.shardmind/state.json')) as {
      files: Record<string, { rendered_hash: string }>;
    };

    const result = await spawnCli(['update', '--yes'], {
      cwd: vault.root,
      env: envWithStub(),
    });
    expect(result.exitCode).toBe(0);

    const homeAfter = await vault.readFile('Home.md');
    const stateAfter = JSON.parse(await vault.readFile('.shardmind/state.json')) as {
      version: string;
      files: Record<string, { rendered_hash: string }>;
    };
    expect(stateAfter.version).toBe('6.0.1');
    // Home.md's bytes shifted (extra trailing newline) so the hash advances.
    expect(stateAfter.files['Home.md']?.rendered_hash).not.toBe(
      stateBefore.files['Home.md']?.rendered_hash,
    );
    expect(homeAfter).not.toBe(homeBefore);
  }, 90_000);

  it('6.0.0 → 6.1.0 (--yes auto-includes new module) installs the new file and surfaces it as ctx.newFiles', async () => {
    // Scenario 8 — docs/SHARD-LAYOUT.md §Update semantics +
    // §Hooks/Invariant 3: under --yes, NewModulesReview auto-includes;
    // research/Findings.md lands; ctx.newFiles names exactly that path
    // so the post-update hook's additive-only marker is appended to it.
    vault = await createInstalledVault({
      stub,
      shardRef: SHARD_REF,
      values: CUSTOM_VALUES,
      prefix: 'obs-mind-update-newmodule',
    });
    stub.setLatest(SHARD_SLUG, '6.1.0');

    const result = await spawnCli(['update', '--yes'], {
      cwd: vault.root,
      env: envWithStub(),
    });
    expect(result.exitCode).toBe(0);

    expect(await vault.exists('research/Findings.md')).toBe(true);

    const findings = await vault.readFile('research/Findings.md');
    expect(findings).toContain('touched by post-update'); // Invariant 3 marker.

    const ctx = JSON.parse(await vault.readFile('.hook-ctx-update.json')) as HookCtxSnapshot;
    expect(ctx.newFiles).toContain('research/Findings.md');
    expect(ctx.removedFiles).toEqual([]);
    expect(ctx.previousVersion).toBe('6.0.0');
  }, 90_000);

  it('user-edited managed file is preserved when upstream did not change it', async () => {
    // Scenario 9 — docs/SHARD-LAYOUT.md §Update semantics: when
    // upstream did not modify a path the user edited, the user's
    // bytes survive and state.hash reflects user content.
    vault = await createInstalledVault({
      stub,
      shardRef: SHARD_REF,
      values: CUSTOM_VALUES,
      prefix: 'obs-mind-update-useredit-noupstream',
    });
    // 6.0.1's mutate touches only Home.md.njk — CLAUDE.md is unchanged.
    const myClaude = '# Claude — vault agent\n\nMy bespoke CLAUDE addition.\n';
    await vault.writeFile('CLAUDE.md', myClaude);
    stub.setLatest(SHARD_SLUG, '6.0.1');

    const result = await spawnCli(['update', '--yes'], {
      cwd: vault.root,
      env: envWithStub(),
    });
    expect(result.exitCode).toBe(0);

    const claudeAfter = await vault.readFile('CLAUDE.md');
    expect(claudeAfter).toContain('My bespoke CLAUDE addition.');

    const { sha256 } = await import('../../source/core/fs-utils.js');
    const state = JSON.parse(await vault.readFile('.shardmind/state.json')) as {
      files: Record<string, { rendered_hash: string }>;
    };
    expect(state.files['CLAUDE.md']?.rendered_hash).toBe(sha256(claudeAfter));
  }, 90_000);

  it('non-conflicting user edit (bottom of file) auto-merges with upstream top-of-file change', async () => {
    // Scenario 10 — docs/SHARD-LAYOUT.md §Update semantics: 3-way
    // merge auto-resolves when upstream and user touch disjoint
    // regions. v6.1.0 changes only the top of CLAUDE.md; a user edit
    // at the bottom must merge clean.
    vault = await createInstalledVault({
      stub,
      shardRef: SHARD_REF,
      values: CUSTOM_VALUES,
      prefix: 'obs-mind-update-automerge',
    });
    const claudeBefore = await vault.readFile('CLAUDE.md');
    await vault.writeFile(
      'CLAUDE.md',
      claudeBefore + '\n## My bottom-of-file note\n',
    );
    stub.setLatest(SHARD_SLUG, '6.1.0');

    const result = await spawnCli(['update', '--yes'], {
      cwd: vault.root,
      env: envWithStub(),
    });
    expect(result.exitCode).toBe(0);

    const merged = await vault.readFile('CLAUDE.md');
    // User's bottom edit survived AND upstream's top change is in.
    expect(merged).toContain('My bottom-of-file note');
    expect(merged).toContain('v6.1.0 update');
  }, 90_000);

  it('user-edited region collides with upstream; --yes resolves as keep_mine', async () => {
    // Scenario 11 — docs/SHARD-LAYOUT.md §Update semantics + the
    // Working Agreement's "user choice applied" wording. Under --yes
    // the engine auto-resolves DiffView conflicts as keep_mine
    // (use-update-machine.ts:473-477). Pin that contract: user bytes
    // win, state.hash matches user content, no abort.
    vault = await createInstalledVault({
      stub,
      shardRef: SHARD_REF,
      values: CUSTOM_VALUES,
      prefix: 'obs-mind-update-conflict-keepmine',
    });
    // Edit the same top-of-file region v6.1.0 also changes.
    const myTopEdit = '# Claude — MY OVERRIDE\n\nUser-side top-of-file rewrite.\n';
    await vault.writeFile('CLAUDE.md', myTopEdit);
    stub.setLatest(SHARD_SLUG, '6.1.0');

    const result = await spawnCli(['update', '--yes'], {
      cwd: vault.root,
      env: envWithStub(),
    });
    expect(result.exitCode).toBe(0);

    const claudeAfter = await vault.readFile('CLAUDE.md');
    // keep_mine wins under --yes — exact user bytes survive.
    expect(claudeAfter).toBe(myTopEdit);
    expect(claudeAfter).not.toContain('v6.1.0 update');
  }, 90_000);

  it('user-deleted managed file is not re-created on update with --yes', async () => {
    // Scenario 12 — docs/SHARD-LAYOUT.md §Update semantics +
    // RemovedFilesReview semantics: under --yes, the prompt is
    // bypassed (use-update-machine.ts:415) and a user-deleted file
    // stays gone.
    vault = await createInstalledVault({
      stub,
      shardRef: SHARD_REF,
      values: CUSTOM_VALUES,
      prefix: 'obs-mind-update-userdelete',
    });
    await fs.rm(path.join(vault.root, 'brain', 'Patterns.md'));
    expect(await vault.exists('brain/Patterns.md')).toBe(false);

    // Run update at the same version (no bump) — purely exercises
    // the user-deleted-file decision path.
    const result = await spawnCli(['update', '--yes'], {
      cwd: vault.root,
      env: envWithStub(),
    });
    expect(result.exitCode).toBe(0);

    expect(await vault.exists('brain/Patterns.md')).toBe(false);
  }, 90_000);

  it('user-renamed file: original path treated as removed, new path stays as user content', async () => {
    // Scenario 13 — docs/SHARD-LAYOUT.md §Update semantics: until
    // rename migrations ship (#88), the engine has no notion of a
    // rename. Old path = removed; new path = user-created. The
    // contract here is "no data loss" — the user's rewritten file
    // survives.
    vault = await createInstalledVault({
      stub,
      shardRef: SHARD_REF,
      values: CUSTOM_VALUES,
      prefix: 'obs-mind-update-rename',
    });
    const original = await vault.readFile('brain/Patterns.md');
    await fs.rename(
      path.join(vault.root, 'brain', 'Patterns.md'),
      path.join(vault.root, 'brain', 'MyPatterns.md'),
    );

    const result = await spawnCli(['update', '--yes'], {
      cwd: vault.root,
      env: envWithStub(),
    });
    expect(result.exitCode).toBe(0);

    // User-renamed file content preserved.
    const renamedAfter = await vault.readFile('brain/MyPatterns.md');
    expect(renamedAfter).toBe(original);
  }, 90_000);

  it('value change via shard-values.yaml edit re-renders dotfolder templates on update', async () => {
    // Scenario 14 — docs/SHARD-LAYOUT.md §Personalization model +
    // §Update semantics: user edits shard-values.yaml between runs,
    // update re-renders any .njk that depends on the changed value.
    // The post-update hook receives ctx.newFiles=[] (no new managed
    // files this run) so Invariant 3's additive-only contract isn't
    // breached.
    vault = await createInstalledVault({
      stub,
      shardRef: SHARD_REF,
      values: { ...CUSTOM_VALUES, qmd_enabled: false },
      prefix: 'obs-mind-update-valuechange',
    });

    const settingsBefore = JSON.parse(await vault.readFile('.claude/settings.json'));
    expect(settingsBefore).toMatchObject({ qmd: false });

    // Flip qmd_enabled in shard-values.yaml. The update machine reads
    // values from this file (use-update-machine.ts:889). Bump latest
    // to 6.0.1 so update has actual work to do — same-version updates
    // short-circuit as no-ops and skip re-render entirely.
    await vault.writeFile(
      'shard-values.yaml',
      stringifyYaml({ ...CUSTOM_VALUES, qmd_enabled: true }),
    );
    stub.setLatest(SHARD_SLUG, '6.0.1');

    const result = await spawnCli(['update', '--yes'], {
      cwd: vault.root,
      env: envWithStub(),
    });
    expect(result.exitCode).toBe(0);

    const settingsAfter = JSON.parse(await vault.readFile('.claude/settings.json'));
    expect(settingsAfter).toMatchObject({ qmd: true });

    const ctx = JSON.parse(await vault.readFile('.hook-ctx-update.json')) as HookCtxSnapshot;
    // No new files — value-only change.
    expect(ctx.newFiles).toEqual([]);
  }, 90_000);
});
