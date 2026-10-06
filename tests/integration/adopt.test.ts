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

import { abortAfterWrite } from '../helpers/abort-after-write.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { asShown } from '../helpers/index.js';
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

async function adopt(vaultRoot: string, resolutions: AdoptResolutions = {}, now?: Date) {
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
      now,
    }),
  };
}


/** The adopt snapshot folders under `.shardmind/backups/`, absolute, in name order. */
async function snapshotsOf(vault: string): Promise<string[]> {
  const backups = path.join(vault, '.shardmind', 'backups');
  return (await fsp.readdir(backups)).sort().map((name) => path.join(backups, name));
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
    // The shard's hash, never the user's: recorded as the baseline, the
    // user's bytes would read as engine-owned on the first update (#150).
    expect(state.files['CLAUDE.md']?.rendered_hash).toBe(
      sha256(await fsp.readFile(path.join(MINIMAL_SHARD, 'CLAUDE.md'))),
    );
    expect(state.files['CLAUDE.md']?.rendered_hash).not.toBe(
      sha256(Buffer.from(myCustomBytes, 'utf-8')),
    );
    expect(state.files['Home.md']?.ownership).toBe('managed');
    expect(state.files['brain/North Star.md']?.ownership).toBe('managed');

    expect(result.summary.adoptedMine).toContain('CLAUDE.md');
    expect(result.summary.adoptedShard).toContain('Home.md');
    expect(result.summary.installedFresh).toContain('brain/North Star.md');
  });

  it('differs + merged resolution: writes the union bytes as `modified`, buckets as adoptedMerged (#120)', async () => {
    // The executor does not re-run the merge — it writes whatever bytes the
    // `merged` resolution carries (the machine computes them via
    // twoWayUnionMerge). Feed explicit merged bytes to isolate the executor's
    // merged branch from the merge algorithm (unit-tested separately).
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

    // Mutate Home.md so it classifies as `differs`.
    await fsp.writeFile(path.join(vault, 'Home.md'), '# Home — my preferred shape\n', 'utf-8');

    const adoptPlan = await plan(vault);
    expect(adoptPlan.differs.map((c) => c.path)).toContain('Home.md');

    const mergedBytes = Buffer.from('# Home — union of mine + shard\n', 'utf-8');
    const mergedHash = sha256(mergedBytes);
    // Resolve every differs path (minimal-shard has a time-varying template
    // that also classifies as `differs`); only Home.md uses `merged`.
    const resolutions: AdoptResolutions = {};
    for (const c of adoptPlan.differs) resolutions[c.path] = 'keep_mine';
    resolutions['Home.md'] = { kind: 'merged', content: mergedBytes, hash: mergedHash };

    const { plan: appliedPlan, result } = await adopt(vault, resolutions);

    // Merged bytes are on disk.
    const homeDisk = await fsp.readFile(path.join(vault, 'Home.md'), 'utf-8');
    expect(homeDisk).toBe('# Home — union of mine + shard\n');

    // Recorded as user-customized (modified) at the shard's hash: the merged
    // bytes hold the user's lines, so recording them would read as
    // engine-owned on the first update (#150).
    const state = (await readState(vault)) as ShardState;
    expect(state.files['Home.md']?.ownership).toBe('modified');
    expect(state.files['Home.md']?.rendered_hash).toBe(
      // The plan runAdopt applied: Home.md renders `install_date`, so a
      // separately classified plan carries a different shard hash.
      appliedPlan.differs.find((c) => c.path === 'Home.md')!.shardHash,
    );
    expect(state.files['Home.md']?.rendered_hash).not.toBe(mergedHash);

    expect(result.summary.adoptedMerged).toContain('Home.md');
    expect(result.summary.adoptedMine).not.toContain('Home.md');
    expect(result.summary.adoptedShard).not.toContain('Home.md');
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

  it('a rollback that cannot restore a file fails with ROLLBACK_INCOMPLETE naming it and its snapshot (#247)', async () => {
    const { manifest, schema } = await loadShard();
    const selections = defaultModuleSelections(schema);
    const values = buildValuesValidator(schema).parse(resolveComputedDefaults(schema, VALUES));
    const myHome = '# Home — pre-adopt user version\n';
    await fsp.writeFile(path.join(vault, 'Home.md'), myHome, 'utf-8');
    const adoptPlan = await classifyAdoption({
      vaultRoot: vault,
      schema,
      manifest,
      tempDir: MINIMAL_SHARD,
      values: values as Record<string, unknown>,
      selections,
    });
    // The values file's write fails, after Home.md was overwritten with the
    // shard's version (a file is snapshotted only when it is about to be
    // written, #301).
    const valuesAbs = path.join(vault, 'shard-values.yaml');
    const realWrite = fsp.writeFile;
    const writeSpy = vi.spyOn(fsp, 'writeFile').mockImplementation(async (file, data, opts) => {
      if (file === valuesAbs) throw Object.assign(new Error('simulated EIO'), { code: 'EIO' });
      return realWrite(file, data, opts);
    });

    // The restore of Home.md from the snapshot fails.
    const homeAbs = path.join(vault, 'Home.md');
    const backups = path.join(vault, '.shardmind', 'backups');
    const realCopy = fsp.copyFile;
    const copySpy = vi.spyOn(fsp, 'copyFile').mockImplementation(async (src, dst, mode) => {
      if (dst === homeAbs && String(src).startsWith(backups)) {
        throw Object.assign(new Error('simulated EACCES on restore'), { code: 'EACCES' });
      }
      return realCopy(src, dst, mode);
    });
    try {
      const err = await runAdopt({
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
      }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'ROLLBACK_INCOMPLETE' });
      const message = (err as Error).message;
      // The original failure first, with its code, then the path and its copy.
      expect(message).toMatch(/\(ADOPT_WRITE_FAILED\)/);
      expect(message).toMatch(/Home\.md: restore failed: simulated EACCES on restore; its backup is at .*adopt-[^\n]*Home\.md/);
      expect((err as Error & { cause?: unknown }).cause).toMatchObject({ code: 'ADOPT_WRITE_FAILED' });
      // The snapshot named in the message still holds the user's bytes.
      const backup = /its backup is at (.*)$/m.exec(message)![1]!;
      expect(await fsp.readFile(backup, 'utf-8')).toBe(myHome);
    } finally {
      copySpy.mockRestore();
      writeSpy.mockRestore();
    }
  });

  it.each([
    // Before the engine writes start: a shard-only file's write fails.
    ['before the engine writes', 'Home.md'],
    // After the cached manifest and schema were overwritten: state.json's write fails.
    ['after the engine cache was rewritten', 'state.json'],
  ] as const)(
    "a failed adopt into a clone of the shard repo keeps the clone's own .shardmind/ files, %s (#301)",
    async (_when, failing) => {
      const { manifest, schema } = await loadShard();
      const selections = defaultModuleSelections(schema);
      const values = buildValuesValidator(schema).parse(resolveComputedDefaults(schema, VALUES));
      // A clone of the shard repo carries the shard's sidecar, with no state.json.
      const sidecar = path.join(vault, '.shardmind');
      await fsp.mkdir(sidecar, { recursive: true });
      await fsp.writeFile(path.join(sidecar, 'shard.yaml'), 'the clone\'s own shard.yaml\n');
      await fsp.writeFile(path.join(sidecar, 'shard-schema.yaml'), 'the clone\'s own schema\n');
      const adoptPlan = await classifyAdoption({
        vaultRoot: vault,
        schema,
        manifest,
        tempDir: MINIMAL_SHARD,
        values: values as Record<string, unknown>,
        selections,
      });
      const target = path.join(vault, failing === 'Home.md' ? 'Home.md' : path.join('.shardmind', 'state.json'));
      const realWrite = fsp.writeFile;
      const writeSpy = vi.spyOn(fsp, 'writeFile').mockImplementation(async (file, data, opts) => {
        if (file === target || (failing === 'state.json' && String(file).startsWith(`${target}.`))) {
          throw Object.assign(new Error('simulated EIO'), { code: 'EIO' });
        }
        return realWrite(file, data, opts);
      });
      try {
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
            resolutions: {},
          }),
        ).rejects.toThrow();
      } finally {
        writeSpy.mockRestore();
      }
      expect(await fsp.readFile(path.join(sidecar, 'shard.yaml'), 'utf-8')).toBe("the clone's own shard.yaml\n");
      expect(await fsp.readFile(path.join(sidecar, 'shard-schema.yaml'), 'utf-8')).toBe("the clone's own schema\n");
      expect((await fsp.readdir(sidecar)).sort()).toEqual(['shard-schema.yaml', 'shard.yaml']);
    },
  );

  it("a successful adopt into a clone of the shard repo leaves no backup of the clone's .shardmind/ files (#301)", async () => {
    const { manifest, schema } = await loadShard();
    const selections = defaultModuleSelections(schema);
    const values = buildValuesValidator(schema).parse(resolveComputedDefaults(schema, VALUES));
    const sidecar = path.join(vault, '.shardmind');
    await fsp.mkdir(sidecar, { recursive: true });
    await fsp.writeFile(path.join(sidecar, 'shard.yaml'), "the clone's own shard.yaml\n");
    await fsp.writeFile(path.join(sidecar, 'boundary-ignore'), 'mine\n');
    const adoptPlan = await classifyAdoption({
      vaultRoot: vault,
      schema,
      manifest,
      tempDir: MINIMAL_SHARD,
      values: values as Record<string, unknown>,
      selections,
    });
    await runAdopt({
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
    });
    const names = await fsp.readdir(sidecar);
    expect(names.filter((n) => n.includes('shardmind-backup'))).toEqual([]);
    expect(names).toEqual(expect.arrayContaining(['state.json', 'shard.yaml', 'boundary-ignore']));
    expect(await fsp.readFile(path.join(sidecar, 'boundary-ignore'), 'utf-8')).toBe('mine\n');
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

  it("a failed adopt keeps the user's own .shardmind/ files (#243)", async () => {
    const { manifest, schema } = await loadShard();
    const selections = defaultModuleSelections(schema);
    const values = buildValuesValidator(schema).parse(resolveComputedDefaults(schema, VALUES));
    // The vault owner's own file in the engine's folder (#190), made before
    // any adopt; assertAdoptable allows a .shardmind/ without state.json.
    const ignore = 'archive/\n';
    await fsp.mkdir(path.join(vault, '.shardmind'), { recursive: true });
    await fsp.writeFile(path.join(vault, '.shardmind', 'boundary-ignore'), ignore, 'utf-8');
    await fsp.writeFile(path.join(vault, 'Home.md'), '# Home, mine\n', 'utf-8');

    const adoptPlan = await classifyAdoption({
      vaultRoot: vault, schema, manifest, tempDir: MINIMAL_SHARD,
      values: values as Record<string, unknown>, selections,
    });
    // Force a write failure after the snapshot (same blocker as above).
    const blocker = adoptPlan.shardOnly[1]!.path;
    await fsp.mkdir(path.join(vault, blocker), { recursive: true });
    await fsp.writeFile(path.join(vault, blocker, '.sentinel'), 'x', 'utf-8');

    await expect(
      runAdopt({
        vaultRoot: vault, manifest, schema, tempDir: MINIMAL_SHARD, resolved: RESOLVED,
        tarballSha256: 'deadbeef', values: values as Record<string, unknown>, selections,
        plan: adoptPlan, resolutions: { 'Home.md': 'use_shard' },
      }),
    ).rejects.toMatchObject({ code: 'ADOPT_WRITE_FAILED' });

    // Only the user's file is left in .shardmind/: no state, no cache, no
    // snapshot, no empty backups/ folder.
    expect(await fsp.readdir(path.join(vault, '.shardmind'))).toEqual(['boundary-ignore']);
    expect(await fsp.readFile(path.join(vault, '.shardmind', 'boundary-ignore'), 'utf-8')).toBe(ignore);
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

  it('two adopts started at the same instant snapshot to two folders (#248)', async () => {
    const now = new Date('2026-10-04T12:00:00.000Z');
    await fsp.writeFile(path.join(vault, 'Home.md'), 'first\n', 'utf-8');
    await adopt(vault, { 'Home.md': 'use_shard' }, now);
    const [first] = await snapshotsOf(vault);
    // Make the vault adoptable again: only the first snapshot under
    // .shardmind/ and a Home.md with different user bytes.
    for (const name of await fsp.readdir(vault)) {
      if (name !== '.shardmind') await fsp.rm(path.join(vault, name), { recursive: true });
    }
    for (const name of await fsp.readdir(path.join(vault, '.shardmind'))) {
      if (name !== 'backups') await fsp.rm(path.join(vault, '.shardmind', name), { recursive: true });
    }
    await fsp.writeFile(path.join(vault, 'Home.md'), 'second\n', 'utf-8');
    await adopt(vault, { 'Home.md': 'use_shard' }, now);
    const second = (await snapshotsOf(vault)).find((dir) => dir !== first)!;

    expect(second).not.toBe(first);
    // The first snapshot still holds the first run's copy.
    expect(await fsp.readFile(path.join(first, 'files', 'Home.md'), 'utf-8')).toBe('first\n');
    expect(await fsp.readFile(path.join(second, 'files', 'Home.md'), 'utf-8')).toBe('second\n');
  });

  it("a failed adopt's clean rollback keeps an earlier snapshot from the same instant (#248)", async () => {
    const now = new Date('2026-10-04T12:00:00.000Z');
    await fsp.writeFile(path.join(vault, 'Home.md'), 'first\n', 'utf-8');
    await adopt(vault, { 'Home.md': 'use_shard' }, now);
    const [first] = await snapshotsOf(vault);
    for (const name of await fsp.readdir(vault)) {
      if (name !== '.shardmind') await fsp.rm(path.join(vault, name), { recursive: true });
    }
    for (const name of await fsp.readdir(path.join(vault, '.shardmind'))) {
      if (name !== 'backups') await fsp.rm(path.join(vault, '.shardmind', name), { recursive: true });
    }
    await fsp.writeFile(path.join(vault, 'Home.md'), 'second\n', 'utf-8');
    // The second adopt fails on a shard file and rolls back cleanly, which
    // removes its own snapshot folder.
    const claude = path.join(vault, 'CLAUDE.md');
    const realWrite = fsp.writeFile;
    const spy = vi.spyOn(fsp, 'writeFile').mockImplementation(async (file, data, opts) => {
      if (file === claude) throw Object.assign(new Error('simulated EACCES'), { code: 'EACCES' });
      return realWrite(file, data, opts);
    });
    try {
      await expect(adopt(vault, { 'Home.md': 'use_shard' }, now)).rejects.toMatchObject({ code: 'ADOPT_WRITE_FAILED' });
    } finally {
      spy.mockRestore();
    }
    expect(await fsp.readFile(path.join(vault, 'Home.md'), 'utf-8')).toBe('second\n');
    expect(await fsp.readFile(path.join(first, 'files', 'Home.md'), 'utf-8')).toBe('first\n');
  });

  it('a full disk shows the disk-full hint, with the path and the errno kept (#313)', async () => {
    await fsp.writeFile(path.join(vault, 'Home.md'), 'my own home\n', 'utf-8');
    const home = path.join(vault, 'Home.md');
    const realWrite = fsp.writeFile;
    const spy = vi.spyOn(fsp, 'writeFile').mockImplementation(async (file, data, opts) => {
      if (file === home) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC', path: home });
      return realWrite(file, data, opts);
    });
    const err = await adopt(vault, { 'Home.md': 'use_shard' }).catch((e: unknown) => e);
    spy.mockRestore();
    const { shown, errnos } = asShown(err);
    expect(shown).toMatchObject({ kind: 'known', code: 'ADOPT_WRITE_FAILED' });
    expect(shown.message).toMatch(/Home\.md/);
    expect(shown.kind === 'known' ? shown.hint : '').toMatch(/The disk is full/);
    expect(errnos).toContain('ENOSPC');
    expect(await fsp.readFile(home, 'utf-8')).toBe('my own home\n');
  });

  it('an adopt aborted mid-run stops writing, rolls back and throws CANCELLED (#249)', async () => {
    const { manifest, schema } = await loadShard();
    const selections = defaultModuleSelections(schema);
    const values = buildValuesValidator(schema).parse(resolveComputedDefaults(schema, VALUES));
    await fsp.writeFile(path.join(vault, 'Home.md'), 'mine\n', 'utf-8');
    const adoptPlan = await classifyAdoption({
      vaultRoot: vault,
      schema,
      manifest,
      tempDir: MINIMAL_SHARD,
      values: values as Record<string, unknown>,
      selections,
    });
    const abort = new AbortController();
    const realWrite = fsp.writeFile;
    let writesAfterAbort = 0;
    const writeSpy = vi.spyOn(fsp, 'writeFile').mockImplementation(async (file, data, opts) => {
      if (abort.signal.aborted) writesAfterAbort++;
      return realWrite(file, data, opts);
    });
    const err = await runAdopt({
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
      signal: abort.signal,
      onProgress: (ev) => {
        if (ev.kind === 'file') abort.abort();
      },
    }).catch((e: unknown) => e);
    writeSpy.mockRestore();
    // Stopped before its next write: the rollback copies, never writes.
    expect(writesAfterAbort).toBe(0);
    expect(err).toMatchObject({ code: 'CANCELLED' });
    expect(await fsp.readFile(path.join(vault, 'Home.md'), 'utf-8')).toBe('mine\n');
    expect(await readState(vault)).toBeNull();
    // Only the user's file is left: every shard file it wrote was removed.
    expect(await fsp.readdir(vault)).toEqual(['Home.md']);
  });

  it('a Ctrl+C after the shard-only writes stops before a differing file is overwritten (#249)', async () => {
    const { manifest, schema } = await loadShard();
    const selections = defaultModuleSelections(schema);
    const values = buildValuesValidator(schema).parse(resolveComputedDefaults(schema, VALUES));
    await fsp.writeFile(path.join(vault, 'Home.md'), 'mine\n', 'utf-8');
    const adoptPlan = await classifyAdoption({
      vaultRoot: vault,
      schema,
      manifest,
      tempDir: MINIMAL_SHARD,
      values: values as Record<string, unknown>,
      selections,
    });
    const lastShardOnly = adoptPlan.shardOnly[adoptPlan.shardOnly.length - 1]!.path;
    const abort = new AbortController();
    let writesAfterAbort = 0;
    // Ctrl+C lands right after the last shard-only file is written.
    const seam = abortAfterWrite(path.join(vault, lastShardOnly), abort, () => {
      if (abort.signal.aborted) writesAfterAbort++;
    });
    const err = await runAdopt({
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
      signal: abort.signal,
    }).catch((e: unknown) => e);
    seam.restore();
    expect(seam.fired(), 'the last shard-only file was written').toBe(true);
    expect(err).toMatchObject({ code: 'CANCELLED' });
    expect(writesAfterAbort).toBe(0);
    expect(await fsp.readFile(path.join(vault, 'Home.md'), 'utf-8')).toBe('mine\n');
  });

  it('a Ctrl+C just before state.json still stops the adopt (#249)', async () => {
    const { manifest, schema } = await loadShard();
    const selections = defaultModuleSelections(schema);
    const values = buildValuesValidator(schema).parse(resolveComputedDefaults(schema, VALUES));
    const adoptPlan = await classifyAdoption({
      vaultRoot: vault,
      schema,
      manifest,
      tempDir: MINIMAL_SHARD,
      values: values as Record<string, unknown>,
      selections,
    });
    const abort = new AbortController();
    // shard-values.yaml is the last write before state.json: Ctrl+C lands
    // right after it.
    const seam = abortAfterWrite(path.join(vault, 'shard-values.yaml'), abort);
    const err = await runAdopt({
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
      signal: abort.signal,
    }).catch((e: unknown) => e);
    seam.restore();
    expect(seam.fired(), 'the values file was written').toBe(true);
    expect(err).toMatchObject({ code: 'CANCELLED' });
    expect(await readState(vault)).toBeNull();
    // Every file it wrote is gone, and so is every folder it made (#258).
    expect(await fsp.readdir(vault)).toEqual([]);
  });

  it("a failed adopt removes the folders it created, never one that was there or holds the user's file (#258)", async () => {
    const { manifest, schema } = await loadShard();
    const selections = defaultModuleSelections(schema);
    const values = buildValuesValidator(schema).parse(resolveComputedDefaults(schema, VALUES));
    // brain/ existed before, empty; .claude/ gets a user file during the run.
    await fsp.mkdir(path.join(vault, 'brain'));
    const adoptPlan = await classifyAdoption({
      vaultRoot: vault,
      schema,
      manifest,
      tempDir: MINIMAL_SHARD,
      values: values as Record<string, unknown>,
      selections,
    });
    const realWrite = fsp.writeFile;
    const spy = vi.spyOn(fsp, 'writeFile').mockImplementation(async (file, data, opts) => {
      // The last shard file fails, after the user dropped a note into .claude/.
      if (file === path.join(vault, 'Home.md')) {
        await realWrite(path.join(vault, '.claude', 'mine.md'), 'my note\n');
        throw Object.assign(new Error('simulated EACCES'), { code: 'EACCES' });
      }
      return realWrite(file, data, opts);
    });
    try {
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
          resolutions: {},
        }),
      ).rejects.toMatchObject({ code: 'ADOPT_WRITE_FAILED' });
    } finally {
      spy.mockRestore();
    }
    expect((await fsp.readdir(vault)).sort()).toEqual(['.claude', 'brain']);
    expect(await fsp.readdir(path.join(vault, '.claude'))).toEqual(['mine.md']);
    expect(await fsp.readdir(path.join(vault, 'brain'))).toEqual([]);
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
    const { schema } = await loadShard();
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
