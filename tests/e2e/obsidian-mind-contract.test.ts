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

// Two SHAs shared by ref-install scenarios — the stub is content-opaque,
// so any 40-char hex pair works. `BASE` maps to v6.0.0; `BUMP` maps to
// v6.1.0 so a ref bump observably mirrors a tag bump.
const REF_SHA_BASE = 'a'.repeat(40);
const REF_SHA_BUMP = 'b'.repeat(40);

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
        // Pre-seed `main` for ref scenarios. Tests that bump the ref
        // call `stub.setRef(...)`; tests that don't ignore it.
        refs: { main: REF_SHA_BASE },
        shaTarballs: { [REF_SHA_BASE]: fixtures.byVersion['6.0.0'] },
      },
    },
  });
}, 90_000);

function defaultRef(): void {
  stub.setRef(SHARD_SLUG, 'main', REF_SHA_BASE, fixtures.byVersion['6.0.0']);
}

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

// ---------------------------------------------------------------------------
// Adopt scenarios — see issue #92 §Adopt + docs/SHARD-LAYOUT.md
// §Adopt semantics.
// ---------------------------------------------------------------------------

/**
 * Strip the engine's installed-side metadata to simulate a v5.1-style
 * clone: no .shardmind/, no shard-values.yaml. Vault content survives.
 * Used by adopt scenarios that need a "user has cloned the shard
 * before shardmind support" starting state.
 */
async function stripEngineMetadata(vault: Vault): Promise<void> {
  await fs.rm(path.join(vault.root, '.shardmind'), { recursive: true, force: true });
  await fs.rm(path.join(vault.root, 'shard-values.yaml'), { force: true });
}

describe('adopt (obsidian-mind-like)', () => {
  let vault: Vault;
  afterEach(async () => {
    defaultLatest();
    await vault?.cleanup();
  });

  it('adopts a clean clone — most files classified `matched`, state.json seeded', async () => {
    // Scenario 15 — docs/SHARD-LAYOUT.md §Adopt semantics: a pristine
    // clone with default values lands every static-content file as
    // matched on first pass. Renderable templates with install_date
    // legitimately classify as `differs` (the floating timestamp
    // doesn't byte-equal any prior render); --yes resolves those as
    // keep_mine. The contract clause being pinned is "first-pass
    // adoption seeds state.json with managed entries for every
    // shard-output path".
    vault = await createInstalledVault({
      stub,
      shardRef: SHARD_REF,
      values: CUSTOM_VALUES,
      prefix: 'obs-mind-adopt-clean',
    });
    await stripEngineMetadata(vault);

    const valuesPath = await writeValuesFile(vault, CUSTOM_VALUES);
    const result = await spawnCli(
      ['adopt', SHARD_REF, '--yes', '--values', valuesPath],
      { cwd: vault.root, env: envWithStub() },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/\d+ matched the shard exactly/);

    expect(await vault.exists('.shardmind/state.json')).toBe(true);
    expect(await vault.exists('shard-values.yaml')).toBe(true);

    const state = JSON.parse(await vault.readFile('.shardmind/state.json')) as {
      files: Record<string, { ownership: string }>;
    };
    // Every state.files entry is either managed (matches / use_shard)
    // or modified (keep_mine — the install_date templates).
    for (const fs of Object.values(state.files)) {
      expect(['managed', 'modified']).toContain(fs.ownership);
    }
    // CLAUDE.md is static content — must classify managed (byte-match).
    expect(state.files['CLAUDE.md']?.ownership).toBe('managed');
  }, 90_000);

  it('adopts with a user-edited managed file and records `modified` ownership under --yes', async () => {
    // Scenario 16 — docs/SHARD-LAYOUT.md §Adopt semantics: under --yes,
    // every `differs` decision auto-resolves keep_mine
    // (use-adopt-machine.ts:283-290). User bytes survive byte-for-byte
    // and the file is recorded with ownership=modified at the user's
    // hash so subsequent updates merge from this base.
    vault = await createInstalledVault({
      stub,
      shardRef: SHARD_REF,
      values: CUSTOM_VALUES,
      prefix: 'obs-mind-adopt-edited',
    });
    await stripEngineMetadata(vault);

    const myEdit = '# Claude — edited before adopt\n';
    await vault.writeFile('CLAUDE.md', myEdit);

    const valuesPath = await writeValuesFile(vault, CUSTOM_VALUES);
    const result = await spawnCli(
      ['adopt', SHARD_REF, '--yes', '--values', valuesPath],
      { cwd: vault.root, env: envWithStub() },
    );
    expect(result.exitCode).toBe(0);

    const claudeAfter = await vault.readFile('CLAUDE.md');
    expect(claudeAfter).toBe(myEdit);

    const state = JSON.parse(await vault.readFile('.shardmind/state.json')) as {
      files: Record<string, { ownership: string }>;
    };
    expect(state.files['CLAUDE.md']?.ownership).toBe('modified');
  }, 90_000);

  it('adopt leaves user-created files (not declared by the shard) unmanaged', async () => {
    // Scenario 17 — docs/SHARD-LAYOUT.md §Adopt semantics: "User has
    // the path but it's not a shard output → user-only, left
    // unmanaged (not in state.files)." Pinned by an explicit
    // user-only file the shard doesn't ship.
    vault = await createInstalledVault({
      stub,
      shardRef: SHARD_REF,
      values: CUSTOM_VALUES,
      prefix: 'obs-mind-adopt-userfile',
    });
    await stripEngineMetadata(vault);
    await vault.writeFile('my-private-note.md', 'private user content\n');

    const valuesPath = await writeValuesFile(vault, CUSTOM_VALUES);
    const result = await spawnCli(
      ['adopt', SHARD_REF, '--yes', '--values', valuesPath],
      { cwd: vault.root, env: envWithStub() },
    );
    expect(result.exitCode).toBe(0);

    // User file survived.
    expect(await vault.readFile('my-private-note.md')).toBe('private user content\n');

    const state = JSON.parse(await vault.readFile('.shardmind/state.json')) as {
      files: Record<string, unknown>;
    };
    expect(state.files['my-private-note.md']).toBeUndefined();
  }, 90_000);

  it('rejects adopt against an already-managed vault with ADOPT_EXISTING_INSTALL', async () => {
    // Scenario 18 — docs/SHARD-LAYOUT.md §Adopt semantics
    // (pre-conditions): "An existing install routes through
    // `shardmind update`." Engine refuses to overwrite the existing
    // .shardmind/ at adopt and surfaces a typed error pointing the
    // user at update.
    vault = await createInstalledVault({
      stub,
      shardRef: SHARD_REF,
      values: CUSTOM_VALUES,
      prefix: 'obs-mind-adopt-existing',
    });
    const valuesPath = await writeValuesFile(vault, CUSTOM_VALUES);
    const result = await spawnCli(
      ['adopt', SHARD_REF, '--yes', '--values', valuesPath],
      { cwd: vault.root, env: envWithStub() },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain('ADOPT_EXISTING_INSTALL');
    expect(result.stdout + result.stderr).toMatch(/shardmind update/);
  }, 60_000);

  it('adopt → update bumps cleanly using the adopt-time cache as merge base', async () => {
    // Scenario 19 — docs/SHARD-LAYOUT.md §Adopt semantics step 5
    // (cache the shard source under .shardmind/templates/) +
    // §Update semantics: a subsequent `shardmind update` against a
    // bumped tag uses the adopt-time cache as the merge base. Pin
    // both halves: adopt seeds the cache, update uses it without
    // a second adopt.
    vault = await createInstalledVault({
      stub,
      shardRef: SHARD_REF,
      values: CUSTOM_VALUES,
      prefix: 'obs-mind-adopt-then-update',
    });
    await stripEngineMetadata(vault);

    const valuesPath = await writeValuesFile(vault, CUSTOM_VALUES);
    const adopt = await spawnCli(
      ['adopt', SHARD_REF, '--yes', '--values', valuesPath],
      { cwd: vault.root, env: envWithStub() },
    );
    expect(adopt.exitCode).toBe(0);
    expect(await vault.exists('.shardmind/templates')).toBe(true);

    stub.setLatest(SHARD_SLUG, '6.1.0');
    const update = await spawnCli(['update', '--yes'], {
      cwd: vault.root,
      env: envWithStub(),
    });
    expect(update.exitCode).toBe(0);

    // 6.1.0's research/ module landed via auto-include.
    expect(await vault.exists('research/Findings.md')).toBe(true);

    const state = JSON.parse(await vault.readFile('.shardmind/state.json')) as {
      version: string;
    };
    expect(state.version).toBe('6.1.0');
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Refs + versions — see issue #92 §Refs + versions + docs/SHARD-LAYOUT.md
// §Update semantics §Ref-install re-resolution.
// ---------------------------------------------------------------------------

describe('refs + versions (obsidian-mind-like)', () => {
  let vault: Vault;
  afterEach(async () => {
    defaultRef();
    defaultLatest();
    await vault?.cleanup();
  });

  it('install from #main records ref + resolvedSha in state.json', async () => {
    // Scenario 20 — docs/SHARD-LAYOUT.md §Update semantics §Ref-install
    // re-resolution: ref installs persist both the user-typed ref and
    // the resolved 40-char SHA so update can show movement and the
    // up-to-date short-circuit can fire on SHA equality.
    vault = await createEmptyVault('obs-mind-ref-main');
    const valuesPath = await writeValuesFile(vault, CUSTOM_VALUES);
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
    // state.version tracks the cached manifest's version field, not the
    // SHA — so semver-aware migrations keep working for ref installs.
    expect(state.version).toBe('6.0.0');
  }, 60_000);

  it('update on a ref install re-resolves HEAD when the ref bumps to a new SHA', async () => {
    // Scenario 21 — docs/SHARD-LAYOUT.md §Update semantics: ref-installed
    // vaults re-fetch HEAD on every update. Bumping `main` to a SHA
    // backed by the v6.1.0 tarball must observably ship v6.1.0's
    // research/ module without going through the latest-stable
    // listing.
    vault = await createEmptyVault('obs-mind-ref-bump');
    const valuesPath = await writeValuesFile(vault, CUSTOM_VALUES);
    const installResult = await spawnCli(
      ['install', `${SHARD_REF}#main`, '--yes', '--values', valuesPath],
      { cwd: vault.root, env: envWithStub() },
    );
    expect(installResult.exitCode).toBe(0);

    // Bump `main` upstream to a SHA backed by the v6.1.0 tarball
    // (which adds the research/ module).
    stub.setRef(SHARD_SLUG, 'main', REF_SHA_BUMP, fixtures.byVersion['6.1.0']);

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
    expect(state.version).toBe('6.1.0');
    expect(await vault.exists('research/Findings.md')).toBe(true);
  }, 90_000);

  it('--release pins to a non-latest tag and ignores the latest-stable listing', async () => {
    // Scenario 23 — docs/SHARD-LAYOUT.md §Update semantics §--release:
    // even if 6.1.0 is the advertised latest, --release 6.0.1 wins.
    vault = await createInstalledVault({
      stub,
      shardRef: SHARD_REF,
      values: CUSTOM_VALUES,
      prefix: 'obs-mind-release-pin',
    });
    stub.setLatest(SHARD_SLUG, '6.1.0');
    const result = await spawnCli(['update', '--yes', '--release', '6.0.1'], {
      cwd: vault.root,
      env: envWithStub(),
    });
    expect(result.exitCode).toBe(0);
    const state = JSON.parse(await vault.readFile('.shardmind/state.json')) as {
      version: string;
    };
    expect(state.version).toBe('6.0.1');
    // 6.1.0-only file did NOT come along.
    expect(await vault.exists('research/Findings.md')).toBe(false);
  }, 90_000);
});

// `@6.0.1-beta.1` prerelease scenarios live under their own stub —
// the main stub's release listing is the conventional single-stable
// derivation, and the prerelease scenario needs a richer listing
// (one stable + one prerelease) plus a tarball whose internal
// manifest version matches the prerelease tag (state.version tracks
// the cached manifest's version field, not the tag the user typed).
describe('prerelease policy (obsidian-mind-like)', () => {
  let prerelStub: GitHubStub;
  let prerelScratch: string;
  let prerelTarball: string;
  let vault: Vault;

  beforeAll(async () => {
    const tarMod = await import('tar');
    const osMod = await import('node:os');
    const yamlMod = await import('yaml');
    prerelScratch = await fs.mkdtemp(
      path.join(osMod.tmpdir(), 'shardmind-e2e-obsmind-prerel-'),
    );
    const prefix = 'obs-mind-like-6.0.1-beta.1';
    const workRoot = path.join(prerelScratch, 'work');
    const workDir = path.join(workRoot, prefix);
    // Reuse the v6.0.1 tarball's content but stamp the manifest with
    // the prerelease version so state.version round-trips correctly.
    await unpackInto(fixtures.byVersion['6.0.1'], workDir);
    const manifestPath = path.join(workDir, '.shardmind', 'shard.yaml');
    const manifestSrc = await fs.readFile(manifestPath, 'utf-8');
    const manifest = yamlMod.parse(manifestSrc) as Record<string, unknown>;
    manifest['version'] = '6.0.1-beta.1';
    await fs.writeFile(manifestPath, yamlMod.stringify(manifest), 'utf-8');

    prerelTarball = path.join(prerelScratch, `${prefix}.tar.gz`);
    await tarMod.c({ file: prerelTarball, gzip: true, cwd: workRoot }, [prefix]);

    prerelStub = await createGitHubStub({
      shards: {
        ['acme/obs-mind-prerel']: {
          versions: {
            '6.0.0': fixtures.byVersion['6.0.0'],
            '6.0.1-beta.1': prerelTarball,
          },
          latest: '6.0.0',
          releases: [
            { tag_name: 'v6.0.1-beta.1', prerelease: true },
            { tag_name: 'v6.0.0', prerelease: false },
          ],
        },
      },
    });
  }, 60_000);

  afterAll(async () => {
    await prerelStub?.close();
    if (prerelScratch) {
      await fs.rm(prerelScratch, {
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

  it('explicit @<prerelease-tag> install works (no --include-prerelease needed)', async () => {
    // Scenario 22 (positive branch) — docs/SHARD-LAYOUT.md §Update
    // semantics: an explicit version pin bypasses the prerelease
    // filter; `--include-prerelease` is only required for the
    // implicit "latest" resolution.
    vault = await createEmptyVault('obs-mind-prerel-pin');
    const valuesPath = await writeValuesFile(vault, CUSTOM_VALUES);
    const result = await spawnCli(
      [
        'install',
        'github:acme/obs-mind-prerel@6.0.1-beta.1',
        '--yes',
        '--values',
        valuesPath,
      ],
      {
        cwd: vault.root,
        env: { SHARDMIND_GITHUB_API_BASE: prerelStub.url },
      },
    );
    expect(result.exitCode).toBe(0);
    const state = JSON.parse(await vault.readFile('.shardmind/state.json')) as {
      version: string;
    };
    expect(state.version).toBe('6.0.1-beta.1');
  }, 60_000);
});

/** Extract a tar.gz into `into` (creating it). Helper for inline tarball
 * scaffolding inside describe-blocks that need a custom-shaped tarball. */
async function unpackInto(tarPath: string, into: string): Promise<void> {
  const tarMod = await import('tar');
  await fs.mkdir(into, { recursive: true });
  await tarMod.x({ file: tarPath, cwd: into, strip: 1 });
}

// ---------------------------------------------------------------------------
// Additive principle — see issue #92 §Additive principle +
// docs/SHARD-LAYOUT.md §Guiding principle.
// ---------------------------------------------------------------------------

describe('additive principle (obsidian-mind-like)', () => {
  let vault: Vault;
  afterEach(async () => {
    defaultLatest();
    await vault?.cleanup();
  });

  it('deleting .shardmind/ + shard-values.yaml leaves a working vault; status reports "not in a shard-managed vault"', async () => {
    // Scenario 24 — docs/SHARD-LAYOUT.md §Guiding principle:
    // "Delete .shardmind/ and shard-values.yaml — the vault continues
    // to work in Obsidian and Claude Code." The engine surface for
    // that is `shardmind` (status) recognizing the un-managed state
    // and falling back to the install-hint path.
    vault = await createInstalledVault({
      stub,
      shardRef: SHARD_REF,
      values: CUSTOM_VALUES,
      prefix: 'obs-mind-additive-delete',
    });
    await fs.rm(path.join(vault.root, '.shardmind'), { recursive: true, force: true });
    await fs.rm(path.join(vault.root, 'shard-values.yaml'), { force: true });

    // Vault content untouched.
    expect(await vault.exists('CLAUDE.md')).toBe(true);
    expect(await vault.exists('brain/North Star.md')).toBe(true);
    expect(await vault.exists('Home.md')).toBe(true);

    const status = await spawnCli([], { cwd: vault.root, env: envWithStub() });
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain('Not in a shard-managed vault.');
  }, 90_000);
});

// Source-repo-without-.shardmind/ scenario builds a custom tarball
// inline (the obsidian-mind-like fixtures all ship `.shardmind/`).
describe('source repo without .shardmind/ (additive principle, install rejection)', () => {
  let noShardmindStub: GitHubStub;
  let scratch: string;
  let vault: Vault;

  beforeAll(async () => {
    const tarMod = await import('tar');
    const osMod = await import('node:os');
    scratch = await fs.mkdtemp(
      path.join(osMod.tmpdir(), 'shardmind-e2e-noshardmind-'),
    );
    const prefix = 'no-shardmind-1.0.0';
    const workRoot = path.join(scratch, 'work');
    const workDir = path.join(workRoot, prefix);
    await fs.mkdir(workDir, { recursive: true });
    // A minimum-viable Obsidian vault: just a CLAUDE.md + Home.md.
    // No .shardmind/ — the engine must reject install with a clear
    // error pointing at the missing manifest.
    await fs.writeFile(
      path.join(workDir, 'CLAUDE.md'),
      '# Claude\n',
      'utf-8',
    );
    await fs.writeFile(
      path.join(workDir, 'Home.md'),
      '# Home\n',
      'utf-8',
    );

    const tarPath = path.join(scratch, `${prefix}.tar.gz`);
    await tarMod.c({ file: tarPath, gzip: true, cwd: workRoot }, [prefix]);

    noShardmindStub = await createGitHubStub({
      shards: {
        ['acme/no-shardmind']: {
          versions: { '1.0.0': tarPath },
          latest: '1.0.0',
        },
      },
    });
  }, 60_000);

  afterAll(async () => {
    await noShardmindStub?.close();
    if (scratch) {
      await fs.rm(scratch, {
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

  it('installing a shard tarball without .shardmind/ rejects with a typed error', async () => {
    // Scenario 25 — docs/SHARD-LAYOUT.md §What a shard is:
    // "A shard is an Obsidian vault with a `.shardmind/` directory."
    // A repo missing that directory cannot be installed; engine
    // surfaces a typed error rather than silently producing a
    // half-managed vault.
    vault = await createEmptyVault('obs-mind-noshardmind');
    const result = await spawnCli(
      ['install', 'github:acme/no-shardmind', '--defaults'],
      {
        cwd: vault.root,
        env: { SHARDMIND_GITHUB_API_BASE: noShardmindStub.url },
      },
    );
    expect(result.exitCode).toBe(1);
    // Engine rejects somewhere in the manifest-load path. Assert on
    // exit code + that the error mentions the missing manifest /
    // shard.yaml so the user gets actionable feedback.
    const out = result.stdout + result.stderr;
    expect(out).toMatch(/shard\.yaml|manifest|\.shardmind/i);
  }, 60_000);
});
