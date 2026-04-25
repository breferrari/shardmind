/**
 * Integration tests for the adopt pipeline.
 *
 * Drives `classifyAdoption` + `runAdopt` end-to-end against
 * `examples/minimal-shard` in a temp vault, exercising the same code
 * path the command would. Tests are deliberately non-Ink (no React
 * tree) to keep the integration scope on engine state shape and
 * rollback behavior.
 *
 * Spec: `docs/SHARD-LAYOUT.md §Adopt semantics`. Adversarial cases that
 * need real disk + real shard fixtures live here; pure-function cases
 * stay in `tests/unit/adopt-planner.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { parseManifest } from '../../source/core/manifest.js';
import {
  parseSchema,
  buildValuesValidator,
} from '../../source/core/schema.js';
import { readState } from '../../source/core/state.js';
import {
  defaultModuleSelections,
  resolveComputedDefaults,
} from '../../source/core/install-planner.js';
import {
  classifyAdoption,
  type AdoptPlan,
} from '../../source/core/adopt-planner.js';
import {
  runAdopt,
  rollbackAdopt,
  type AdoptResolutions,
} from '../../source/core/adopt-executor.js';
import { runInstall } from '../../source/core/install-executor.js';
import { sha256 } from '../../source/core/fs-utils.js';
import type {
  ResolvedShard,
  ShardState,
} from '../../source/runtime/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MINIMAL_SHARD = path.resolve(__dirname, '../../examples/minimal-shard');

const RESOLVED: ResolvedShard = {
  namespace: 'shardmind',
  name: 'minimal',
  version: '0.1.0',
  source: 'github:shardmind/minimal',
  tarballUrl: 'n/a (local fixture)',
};

const VALUES = {
  user_name: 'Alice',
  org_name: 'Acme Labs',
  vault_purpose: 'engineering' as const,
  qmd_enabled: true,
};

async function loadShard() {
  const manifest = await parseManifest(path.join(MINIMAL_SHARD, '.shardmind', 'shard.yaml'));
  const schema = await parseSchema(path.join(MINIMAL_SHARD, '.shardmind', 'shard-schema.yaml'));
  return { manifest, schema };
}

async function plan(vaultRoot: string): Promise<AdoptPlan> {
  const { manifest, schema } = await loadShard();
  const selections = defaultModuleSelections(schema);
  const validator = buildValuesValidator(schema);
  const values = validator.parse(resolveComputedDefaults(schema, VALUES));
  return classifyAdoption({
    vaultRoot,
    schema,
    manifest,
    tempDir: MINIMAL_SHARD,
    values: values as Record<string, unknown>,
    selections,
  });
}

async function adopt(vaultRoot: string, resolutions: AdoptResolutions = {}) {
  const { manifest, schema } = await loadShard();
  const selections = defaultModuleSelections(schema);
  const validator = buildValuesValidator(schema);
  const values = validator.parse(resolveComputedDefaults(schema, VALUES));
  const adoptPlan = await classifyAdoption({
    vaultRoot,
    schema,
    manifest,
    tempDir: MINIMAL_SHARD,
    values: values as Record<string, unknown>,
    selections,
  });
  return {
    plan: adoptPlan,
    result: await runAdopt({
      vaultRoot,
      manifest,
      schema,
      tempDir: MINIMAL_SHARD,
      resolved: RESOLVED,
      tarballSha256: 'deadbeef',
      values: values as Record<string, unknown>,
      selections,
      plan: adoptPlan,
      resolutions,
    }),
  };
}

describe('adopt pipeline (against examples/minimal-shard)', () => {
  let vault: string;

  beforeEach(async () => {
    vault = path.join(os.tmpdir(), `shardmind-adopt-${crypto.randomUUID()}`);
    await fsp.mkdir(vault, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(vault, { recursive: true, force: true });
  });

  it('empty vault adopt → every shard file installed fresh, no differs', async () => {
    const { plan: adoptPlan, result } = await adopt(vault);

    expect(adoptPlan.matches).toEqual([]);
    expect(adoptPlan.differs).toEqual([]);
    expect(adoptPlan.shardOnly.length).toBeGreaterThan(0);

    const state = (await readState(vault)) as ShardState;
    expect(state).not.toBeNull();
    expect(state.shard).toBe('shardmind/minimal');
    expect(Object.keys(state.files).length).toBe(adoptPlan.shardOnly.length);
    expect(result.summary.installedFresh.length).toBe(adoptPlan.shardOnly.length);
    expect(result.summary.matchedAuto).toEqual([]);

    // Engine metadata exists.
    await expect(fsp.access(path.join(vault, '.shardmind/state.json'))).resolves.toBeUndefined();
    await expect(fsp.access(path.join(vault, 'shard-values.yaml'))).resolves.toBeUndefined();
    await expect(fsp.access(path.join(vault, '.shardmind/templates'))).resolves.toBeUndefined();
  });

  it('vault byte-equivalent to clone → matches dominate; install-date templates differ', async () => {
    // Pre-seed the vault by running `runInstall` first, then strip
    // `.shardmind/` + `shard-values.yaml` so the vault looks like a
    // git clone of the post-install bytes.
    //
    // Templates that interpolate `{{ install_date }}` (e.g. minimal-
    // shard's Home.md.njk) will legitimately classify as `differs`
    // because adopt's re-render uses adopt-time, not install-time.
    // This is the spec's "post-render-byte-equality" rule playing out
    // for time-varying values; the user's right move is `keep_mine`
    // so the original install_date is preserved.
    //
    // Static-content files (CLAUDE.md, .claude/commands/example-
    // command.md, brain/North Star.md, etc.) match exactly and land
    // in `matches`.
    const { manifest, schema } = await loadShard();
    const selections = defaultModuleSelections(schema);
    const validator = buildValuesValidator(schema);
    const values = validator.parse(resolveComputedDefaults(schema, VALUES));

    await runInstall({
      vaultRoot: vault,
      manifest,
      schema,
      tempDir: MINIMAL_SHARD,
      resolved: RESOLVED,
      tarballSha256: 'deadbeef',
      values: values as Record<string, unknown>,
      selections,
    });

    // Capture pre-adopt user bytes — `keep_mine` paths must come back
    // byte-identical to what the user had.
    const homeBefore = await fsp.readFile(path.join(vault, 'Home.md'), 'utf-8');

    await fsp.rm(path.join(vault, '.shardmind'), { recursive: true, force: true });
    await fsp.rm(path.join(vault, 'shard-values.yaml'), { force: true });

    const adoptPlan = await plan(vault);

    expect(adoptPlan.shardOnly).toEqual([]);
    expect(adoptPlan.matches.length).toBeGreaterThan(0);
    // Home.md + brain/North Star.md both interpolate install_date —
    // guaranteed to differ between install and adopt re-render.
    expect(adoptPlan.differs.map((c) => c.path).sort()).toEqual([
      'Home.md',
      'brain/North Star.md',
    ]);
    // Files without install_date match exactly: copy-files (CLAUDE.md,
    // example-command.md) and the settings.json template (values-only).
    expect(adoptPlan.matches.map((c) => c.path)).toContain('CLAUDE.md');
    expect(adoptPlan.matches.map((c) => c.path)).toContain(
      '.claude/commands/example-command.md',
    );
    expect(adoptPlan.matches.map((c) => c.path)).toContain('.claude/settings.json');

    const resolutions: AdoptResolutions = {};
    for (const c of adoptPlan.differs) resolutions[c.path] = 'keep_mine';

    const { result } = await adopt(vault, resolutions);

    // Home.md preserved (keep_mine = no write).
    const homeAfter = await fsp.readFile(path.join(vault, 'Home.md'), 'utf-8');
    expect(homeAfter).toBe(homeBefore);

    // state.files entries are recorded — `differs+keep_mine` lands as
    // 'modified'; everything else lands as 'managed'.
    const state = (await readState(vault)) as ShardState;
    expect(state.files['Home.md']?.ownership).toBe('modified');
    expect(state.files['brain/North Star.md']?.ownership).toBe('modified');
    expect(state.files['CLAUDE.md']?.ownership).toBe('managed');

    // Counts add up.
    expect(result.summary.totalManaged).toBe(Object.keys(state.files).length);
    expect(
      result.summary.matchedAuto.length +
        result.summary.adoptedMine.length +
        result.summary.adoptedShard.length +
        result.summary.installedFresh.length,
    ).toBe(state.files ? Object.keys(state.files).length : 0);
  });

  it('mixed vault: matches + differs+keep_mine + differs+use_shard + shardOnly', async () => {
    // Set up: install → strip engine state → mutate two files, leave one
    // matching, leave one missing. Adopt with one keep_mine + one
    // use_shard resolution.
    const { manifest, schema } = await loadShard();
    const selections = defaultModuleSelections(schema);
    const validator = buildValuesValidator(schema);
    const values = validator.parse(resolveComputedDefaults(schema, VALUES));

    await runInstall({
      vaultRoot: vault,
      manifest,
      schema,
      tempDir: MINIMAL_SHARD,
      resolved: RESOLVED,
      tarballSha256: 'deadbeef',
      values: values as Record<string, unknown>,
      selections,
    });

    await fsp.rm(path.join(vault, '.shardmind'), { recursive: true, force: true });
    await fsp.rm(path.join(vault, 'shard-values.yaml'), { force: true });

    // Mutate two files (will become `differs`).
    const myCustomBytes = '# CLAUDE — my custom version\n';
    await fsp.writeFile(path.join(vault, 'CLAUDE.md'), myCustomBytes, 'utf-8');
    await fsp.writeFile(path.join(vault, 'Home.md'), '# Home — my preferred shape\n', 'utf-8');
    // Delete a file (will become `shardOnly`).
    await fsp.rm(path.join(vault, 'brain', 'North Star.md'), { force: true });

    const adoptPlan = await plan(vault);
    const differsPaths = adoptPlan.differs.map((c) => c.path).sort();
    expect(differsPaths).toContain('CLAUDE.md');
    expect(differsPaths).toContain('Home.md');
    expect(adoptPlan.shardOnly.map((c) => c.path)).toContain('brain/North Star.md');

    // Resolutions: keep mine on CLAUDE.md, accept shard on Home.md.
    const resolutions: AdoptResolutions = {
      'CLAUDE.md': 'keep_mine',
      'Home.md': 'use_shard',
    };

    const { result } = await adopt(vault, resolutions);

    // CLAUDE.md user bytes preserved on disk.
    const claudeDisk = await fsp.readFile(path.join(vault, 'CLAUDE.md'), 'utf-8');
    expect(claudeDisk).toBe(myCustomBytes);

    // Home.md was overwritten with shard rendering.
    const homeDisk = await fsp.readFile(path.join(vault, 'Home.md'), 'utf-8');
    expect(homeDisk).toContain('Welcome to your vault, Alice.');

    // brain/North Star.md re-installed.
    await expect(
      fsp.access(path.join(vault, 'brain', 'North Star.md')),
    ).resolves.toBeUndefined();

    const state = (await readState(vault)) as ShardState;
    expect(state.files['CLAUDE.md']?.ownership).toBe('modified');
    expect(state.files['CLAUDE.md']?.rendered_hash).toBe(
      sha256(Buffer.from(myCustomBytes, 'utf-8')),
    );
    expect(state.files['Home.md']?.ownership).toBe('managed');
    expect(state.files['brain/North Star.md']?.ownership).toBe('managed');

    expect(result.summary.adoptedMine).toContain('CLAUDE.md');
    expect(result.summary.adoptedShard).toContain('Home.md');
    expect(result.summary.installedFresh).toContain('brain/North Star.md');
  });

  it('rejects adopt when .shardmind/state.json already exists', async () => {
    // Simulate a previously-installed vault.
    const { manifest, schema } = await loadShard();
    const selections = defaultModuleSelections(schema);
    const validator = buildValuesValidator(schema);
    const values = validator.parse(resolveComputedDefaults(schema, VALUES));
    await runInstall({
      vaultRoot: vault,
      manifest,
      schema,
      tempDir: MINIMAL_SHARD,
      resolved: RESOLVED,
      tarballSha256: 'deadbeef',
      values: values as Record<string, unknown>,
      selections,
    });

    await expect(adopt(vault)).rejects.toMatchObject({
      code: 'ADOPT_EXISTING_INSTALL',
    });

    // No backup directory should have been created — the guard fires
    // before any disk mutation.
    const backups = path.join(vault, '.shardmind', 'backups');
    if (await fsp
      .access(backups)
      .then(() => true)
      .catch(() => false)) {
      const entries = await fsp.readdir(backups).catch(() => []);
      expect(entries.filter((e) => e.startsWith('adopt-'))).toEqual([]);
    }
  });

  it('rejects adopt when shard-values.yaml is present without state.json (partial state)', async () => {
    await fsp.writeFile(path.join(vault, 'shard-values.yaml'), 'user_name: stale\n', 'utf-8');
    await expect(adopt(vault)).rejects.toMatchObject({
      code: 'VALUES_FILE_COLLISION',
    });
  });

  it('rolls back when a write fails mid-execute (snapshot restore + addedPaths cleanup)', async () => {
    // Drive runAdopt through one differs-use-shard (so snapshot fires)
    // plus a synthetic post-snapshot failure. Asserts:
    //  - the snapshotted user file comes back byte-identical;
    //  - any path runAdopt managed to write before failing is erased;
    //  - no `state.json` / `shard-values.yaml` are left behind.
    const { manifest, schema } = await loadShard();
    const selections = defaultModuleSelections(schema);
    const validator = buildValuesValidator(schema);
    const values = validator.parse(resolveComputedDefaults(schema, VALUES));

    // Seed Home.md as user bytes — this becomes `differs-use-shard`
    // after the planner runs.
    const myHome = '# Home — pre-adopt user version\n';
    await fsp.writeFile(path.join(vault, 'Home.md'), myHome, 'utf-8');

    // Run the planner first so we know the differs/shardOnly shape.
    const adoptPlan = await classifyAdoption({
      vaultRoot: vault,
      schema,
      manifest,
      tempDir: MINIMAL_SHARD,
      values: values as Record<string, unknown>,
      selections,
    });
    expect(adoptPlan.differs.map((c) => c.path)).toContain('Home.md');
    expect(adoptPlan.shardOnly.length).toBeGreaterThan(1);

    // Choose a `shardOnly` path that the planner will reach AFTER it's
    // already written at least one other file. We block the second-
    // -written shardOnly by replacing its expected target with a
    // pre-existing non-empty directory: writeFile EISDIRs and bubbles
    // up as `ADOPT_WRITE_FAILED`. Order: planner's shardOnly bucket is
    // returned in walk-order; pick the second entry to guarantee at
    // least one earlier write succeeded (so addedPaths is non-empty
    // and the rollback has something to erase).
    const blocker = adoptPlan.shardOnly[1]!.path;
    await fsp.mkdir(path.join(vault, blocker), { recursive: true });
    // Drop a sentinel inside so it isn't an empty dir mkdir() would tolerate.
    await fsp.writeFile(path.join(vault, blocker, '.sentinel'), 'x', 'utf-8');

    const firstShardOnly = adoptPlan.shardOnly[0]!.path;

    await expect(
      runAdopt({
        vaultRoot: vault,
        manifest,
        schema,
        tempDir: MINIMAL_SHARD,
        resolved: RESOLVED,
        tarballSha256: 'deadbeef',
        values: values as Record<string, unknown>,
        selections,
        plan: adoptPlan,
        resolutions: { 'Home.md': 'use_shard' },
      }),
    ).rejects.toMatchObject({ code: 'ADOPT_WRITE_FAILED' });

    // Snapshot-restore: Home.md is back to the user's bytes.
    const homeAfter = await fsp.readFile(path.join(vault, 'Home.md'), 'utf-8');
    expect(homeAfter).toBe(myHome);

    // addedPaths erase: the first shardOnly file we wrote before the
    // failure is gone (rollback's unlink loop fires on it).
    await expect(fsp.access(path.join(vault, firstShardOnly))).rejects.toThrow();

    // Engine metadata never landed — runAdopt failed before the
    // `writeState` call, and rollback drops `.shardmind/` regardless.
    expect(await readState(vault)).toBeNull();
    await expect(fsp.access(path.join(vault, 'shard-values.yaml'))).rejects.toThrow();
  });

  it('rejects symlinks in the shard source via the walk', async () => {
    // Build a tiny shard tree with a symlink under it. Reuses the same
    // walk symlink rejection path the install pipeline does.
    const tempShard = path.join(os.tmpdir(), `shardmind-adopt-symlink-${crypto.randomUUID()}`);
    await fsp.mkdir(path.join(tempShard, '.shardmind'), { recursive: true });
    await fsp.writeFile(
      path.join(tempShard, '.shardmind', 'shard.yaml'),
      'apiVersion: v1\nname: t\nnamespace: t\nversion: 1.0.0\ndependencies: []\nhooks: {}\n',
      'utf-8',
    );
    await fsp.writeFile(
      path.join(tempShard, '.shardmind', 'shard-schema.yaml'),
      'schema_version: 1\nvalues: {}\ngroups: []\nmodules: {}\nsignals: []\nfrontmatter: {}\nmigrations: []\n',
      'utf-8',
    );
    await fsp.writeFile(path.join(tempShard, 'real.md'), 'real\n', 'utf-8');
    await fsp.symlink('real.md', path.join(tempShard, 'link.md'));

    try {
      const manifest = await parseManifest(path.join(tempShard, '.shardmind', 'shard.yaml'));
      const schema = await parseSchema(path.join(tempShard, '.shardmind', 'shard-schema.yaml'));
      await expect(
        classifyAdoption({
          vaultRoot: vault,
          schema,
          manifest,
          tempDir: tempShard,
          values: {},
          selections: {},
        }),
      ).rejects.toMatchObject({ code: 'WALK_SYMLINK_REJECTED' });
    } finally {
      await fsp.rm(tempShard, { recursive: true, force: true });
    }
  });

  it('--dry-run: no engine metadata or user-file writes', async () => {
    const { manifest, schema } = await loadShard();
    const selections = defaultModuleSelections(schema);
    const validator = buildValuesValidator(schema);
    const values = validator.parse(resolveComputedDefaults(schema, VALUES));

    const adoptPlan = await classifyAdoption({
      vaultRoot: vault,
      schema,
      manifest,
      tempDir: MINIMAL_SHARD,
      values: values as Record<string, unknown>,
      selections,
    });

    const result = await runAdopt({
      vaultRoot: vault,
      manifest,
      schema,
      tempDir: MINIMAL_SHARD,
      resolved: RESOLVED,
      tarballSha256: 'deadbeef',
      values: values as Record<string, unknown>,
      selections,
      plan: adoptPlan,
      resolutions: {},
      dryRun: true,
    });

    // Returned state shape is real, but no disk writes happened.
    expect(result.state.shard).toBe('shardmind/minimal');
    expect(Object.keys(result.state.files).length).toBeGreaterThan(0);
    await expect(fsp.access(path.join(vault, '.shardmind'))).rejects.toThrow();
    await expect(fsp.access(path.join(vault, 'shard-values.yaml'))).rejects.toThrow();
    // No shard-only file was actually written.
    await expect(fsp.access(path.join(vault, 'CLAUDE.md'))).rejects.toThrow();
  });

  it('rollbackAdopt restores snapshotted files even after partial cleanup', async () => {
    // Direct test of the rollback function — separate from runAdopt's
    // catch-and-rollback path so per-file failure semantics can be
    // pinned without faking executor errors.
    const backupDir = path.join(vault, '.shardmind', 'backups', 'adopt-isolated');
    const filesDir = path.join(backupDir, 'files');
    await fsp.mkdir(filesDir, { recursive: true });
    await fsp.writeFile(path.join(vault, 'CLAUDE.md'), 'overwritten\n', 'utf-8');
    await fsp.writeFile(path.join(filesDir, 'CLAUDE.md'), 'pristine\n', 'utf-8');
    await fsp.writeFile(path.join(vault, 'shard-only.md'), 'fresh write\n', 'utf-8');

    const failures = await rollbackAdopt(vault, backupDir, ['shard-only.md']);
    expect(failures).toEqual([]);

    // Snapshot was restored over the overwrite.
    const claudeAfter = await fsp.readFile(path.join(vault, 'CLAUDE.md'), 'utf-8');
    expect(claudeAfter).toBe('pristine\n');

    // Newly-introduced shard-only file was erased.
    await expect(fsp.access(path.join(vault, 'shard-only.md'))).rejects.toThrow();

    // `.shardmind/` cleanup ran regardless of whether any engine writes
    // had landed.
    await expect(fsp.access(path.join(vault, '.shardmind'))).rejects.toThrow();
  });

  it('runAdopt with a zero-classification plan still writes engine metadata', async () => {
    // Pin the empty-plan path: a shard whose every file is excluded
    // ends up with `matches=[], differs=[], shardOnly=[]`. Adopt
    // should still succeed and write `.shardmind/state.json` +
    // `shard-values.yaml` with an empty `state.files` map. The
    // AdoptSummary view branches on `totalManaged === 0` to render an
    // "empty plan" footnote — this test makes sure runAdopt actually
    // exercises that branch end-to-end rather than crashing on a zero
    // total or skipping the metadata writes.
    const { manifest, schema } = await loadShard();
    const validator = buildValuesValidator(schema);
    const values = validator.parse(resolveComputedDefaults(schema, VALUES));
    // Exclude every removable module. `brain` is non-removable, so
    // `defaultModuleSelections` keeps it included — instead, pass an
    // empty selections map so resolveModules treats every file's owning
    // module as "not selected" and skips it. (The minimal-shard's
    // `brain` module is `removable: false`, but the planner's gating
    // is by the selections map; an empty map means no module is
    // 'included', so every modular file lands in `skip`.)
    //
    // The non-modular files (CLAUDE.md, .shardmindignore, etc.) DO get
    // walked, so totalShardFiles is small but non-zero. To produce a
    // strictly empty plan, we manually classify against an empty shard
    // tree — easier and clearer than coaxing minimal-shard.
    const tempShard = path.join(os.tmpdir(), `shardmind-adopt-empty-${crypto.randomUUID()}`);
    await fsp.mkdir(path.join(tempShard, '.shardmind'), { recursive: true });
    await fsp.writeFile(
      path.join(tempShard, '.shardmind', 'shard.yaml'),
      'apiVersion: v1\nname: empty\nnamespace: t\nversion: 1.0.0\ndependencies: []\nhooks: {}\n',
      'utf-8',
    );
    await fsp.writeFile(
      path.join(tempShard, '.shardmind', 'shard-schema.yaml'),
      'schema_version: 1\nvalues: {}\ngroups: []\nmodules: {}\nsignals: []\nfrontmatter: {}\nmigrations: []\n',
      'utf-8',
    );

    try {
      const emptyManifest = await parseManifest(path.join(tempShard, '.shardmind', 'shard.yaml'));
      const emptySchema = await parseSchema(path.join(tempShard, '.shardmind', 'shard-schema.yaml'));
      const emptyPlan = await classifyAdoption({
        vaultRoot: vault,
        schema: emptySchema,
        manifest: emptyManifest,
        tempDir: tempShard,
        values: {},
        selections: {},
      });
      expect(emptyPlan.matches).toEqual([]);
      expect(emptyPlan.differs).toEqual([]);
      expect(emptyPlan.shardOnly).toEqual([]);
      expect(emptyPlan.totalShardFiles).toBe(0);

      const result = await runAdopt({
        vaultRoot: vault,
        manifest: emptyManifest,
        schema: emptySchema,
        tempDir: tempShard,
        resolved: { ...RESOLVED, namespace: 't', name: 'empty' },
        tarballSha256: 'deadbeef',
        values: {},
        selections: {},
        plan: emptyPlan,
        resolutions: {},
      });

      // Even with a zero-action plan, engine metadata lands.
      expect(result.summary.totalManaged).toBe(0);
      expect(Object.keys(result.state.files)).toEqual([]);
      await expect(fsp.access(path.join(vault, '.shardmind/state.json'))).resolves.toBeUndefined();
      await expect(fsp.access(path.join(vault, 'shard-values.yaml'))).resolves.toBeUndefined();

      // Suppress unused-import warnings — `values` is used in other
      // tests in this file, but referenced here for symmetry only.
      void values;
    } finally {
      await fsp.rm(tempShard, { recursive: true, force: true });
    }
  });
});
