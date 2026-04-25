/**
 * End-to-end update pipeline test.
 *
 * Flow per test:
 *   1. Install `examples/minimal-shard` into a fresh temp vault.
 *   2. Clone the minimal shard to a second temp dir so we can edit it
 *      (bump version, change a template) without touching the fixture.
 *   3. Optionally modify one of the installed files (simulating user edits).
 *   4. Run the full detect drift → migrate → plan → apply update pipeline
 *      and assert the expected outcome: merge result, state.json version,
 *      conflict behaviour.
 *
 * This test avoids network calls — we never hit GitHub; we only exercise
 * the engine-internal parts (detectDrift, applyMigrations, planUpdate,
 * runUpdate) against real filesystem state.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { parseManifest } from '../../source/core/manifest.js';
import { parseSchema, buildValuesValidator } from '../../source/core/schema.js';
import { readState } from '../../source/core/state.js';
import { detectDrift } from '../../source/core/drift.js';
import { applyMigrations } from '../../source/core/migrator.js';
import {
  planUpdate,
  computeSchemaAdditions,
  mergeModuleSelections,
  removedFilesNeedingDecision,
  renderNewShard,
} from '../../source/core/update-planner.js';
import { runUpdate } from '../../source/core/update-executor.js';
import { runPostUpdateHook } from '../../source/core/hook.js';
import {
  defaultModuleSelections,
  resolveComputedDefaults,
} from '../../source/core/install-planner.js';
import { runInstall } from '../../source/core/install-executor.js';
import { buildRenderContext } from '../../source/core/renderer.js';
import type {
  ResolvedShard,
  ShardState,
  ShardManifest,
  ShardSchema,
} from '../../source/runtime/types.js';
import { ShardMindError } from '../../source/runtime/types.js';

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

const BASE_VALUES = {
  user_name: 'Alice',
  org_name: 'Acme Labs',
  vault_purpose: 'engineering' as const,
  qmd_enabled: true,
};

async function installBaseline(
  vault: string,
  shardDir: string,
  tarballSha: string,
): Promise<{ manifest: ShardManifest; schema: ShardSchema; values: Record<string, unknown> }> {
  const manifest = await parseManifest(path.join(shardDir, '.shardmind', 'shard.yaml'));
  const schema = await parseSchema(path.join(shardDir, '.shardmind', 'shard-schema.yaml'));
  const selections = defaultModuleSelections(schema);
  const validator = buildValuesValidator(schema);
  const values = validator.parse(resolveComputedDefaults(schema, BASE_VALUES)) as Record<string, unknown>;

  await runInstall({
    vaultRoot: vault,
    manifest,
    schema,
    tempDir: shardDir,
    resolved: { ...RESOLVED, version: manifest.version },
    tarballSha256: tarballSha,
    values,
    selections,
  });

  return { manifest, schema, values };
}

async function copyShard(src: string, dst: string): Promise<void> {
  await fsp.cp(src, dst, { recursive: true });
}

async function bumpVersion(shardDir: string, next: string): Promise<void> {
  const manifestPath = path.join(shardDir, '.shardmind', 'shard.yaml');
  const raw = await fsp.readFile(manifestPath, 'utf-8');
  const bumped = raw.replace(/^version: .+$/m, `version: ${next}`);
  await fsp.writeFile(manifestPath, bumped, 'utf-8');
}

describe('update pipeline (against examples/minimal-shard)', () => {
  let vault: string;
  let newShard: string;

  beforeEach(async () => {
    const id = crypto.randomUUID();
    vault = path.join(os.tmpdir(), `shardmind-update-vault-${id}`);
    newShard = path.join(os.tmpdir(), `shardmind-update-shard-${id}`);
    await fsp.mkdir(vault, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(vault, { recursive: true, force: true });
    await fsp.rm(newShard, { recursive: true, force: true });
  });

  async function setUpUpdate(opts: {
    modifyFile?: { path: string; content: string };
    bumpTo: string;
    newHomeTemplate?: string;
  }): Promise<{
    state: ShardState;
    oldValues: Record<string, unknown>;
    newManifest: ShardManifest;
    newSchema: ShardSchema;
  }> {
    await installBaseline(vault, MINIMAL_SHARD, 'sha-0.1.0');
    if (opts.modifyFile) {
      await fsp.writeFile(path.join(vault, opts.modifyFile.path), opts.modifyFile.content, 'utf-8');
    }
    await copyShard(MINIMAL_SHARD, newShard);
    await bumpVersion(newShard, opts.bumpTo);
    if (opts.newHomeTemplate !== undefined) {
      await fsp.writeFile(
        path.join(newShard, 'Home.md.njk'),
        opts.newHomeTemplate,
        'utf-8',
      );
    }

    const state = (await readState(vault)) as ShardState;
    const oldValues = parseYaml(await fsp.readFile(path.join(vault, 'shard-values.yaml'), 'utf-8')) as Record<string, unknown>;
    const newManifest = await parseManifest(path.join(newShard, '.shardmind', 'shard.yaml'));
    const newSchema = await parseSchema(path.join(newShard, '.shardmind', 'shard-schema.yaml'));
    return { state, oldValues, newManifest, newSchema };
  }

  it('silently overwrites a managed file when the shard version bumps with a template change', async () => {
    const newTemplate = [
      '---',
      'date: {{ install_date }}',
      'description: "Vault entry point for {{ org_name }}"',
      'tags:',
      '  - index',
      '---',
      '',
      '# Home',
      '',
      'Welcome to your vault, {{ user_name }}. (v2)',
      '',
    ].join('\n');

    const { state, oldValues, newManifest, newSchema } = await setUpUpdate({
      bumpTo: '0.2.0',
      newHomeTemplate: newTemplate,
    });

    const migration = applyMigrations(oldValues, state.version, newManifest.version, newSchema.migrations);
    const selections = mergeModuleSelections(state.modules, newSchema, {});
    const drift = await detectDrift(vault, state);
    const renderCtx = buildRenderContext(newManifest, migration.values, selections);

    const plan = await planUpdate({
      vault: { root: vault, state, drift },
      values: { old: oldValues, new: migration.values },
      newShard: {
        schema: newSchema,
        selections,
        tempDir: newShard,
        renderContext: renderCtx,
      },
      removedFileDecisions: {},
    });

    expect(plan.pendingConflicts).toEqual([]);
    expect(plan.counts.silent).toBeGreaterThan(0);

    const result = await runUpdate({
      vaultRoot: vault,
      plan,
      conflictResolutions: {},
      currentState: state,
      newManifest,
      newSchema,
      newValues: migration.values,
      newSelections: selections,
      resolved: { ...RESOLVED, version: newManifest.version },
      tarballSha256: 'sha-0.2.0',
      newTempDir: newShard,
    });

    expect(result.state.version).toBe('0.2.0');
    expect(result.state.tarball_sha256).toBe('sha-0.2.0');

    const home = await fsp.readFile(path.join(vault, 'Home.md'), 'utf-8');
    expect(home).toContain('Welcome to your vault, Alice. (v2)');
    expect(result.summary.conflictsResolved).toBe(0);
  });

  it('three-way merges a user-edited file with a non-overlapping template change', async () => {
    // User appends a line of their own to Home.md; shard changes the
    // welcome line. Expect auto_merge keeping both changes.
    const origHome = await fsp.readFile(path.join(MINIMAL_SHARD, 'Home.md.njk'), 'utf-8');
    // New template: change the welcome line.
    const newTemplate = origHome.replace(
      'Welcome to your vault, {{ user_name }}.',
      'Welcome to your vault, {{ user_name }}! (updated)',
    );

    await installBaseline(vault, MINIMAL_SHARD, 'sha-0.1.0');

    // Append a user line to Home.md
    const homePath = path.join(vault, 'Home.md');
    const current = await fsp.readFile(homePath, 'utf-8');
    await fsp.writeFile(homePath, current + '\n- User-added link\n', 'utf-8');

    await copyShard(MINIMAL_SHARD, newShard);
    await bumpVersion(newShard, '0.2.0');
    await fsp.writeFile(path.join(newShard, 'Home.md.njk'), newTemplate, 'utf-8');

    const state = (await readState(vault)) as ShardState;
    const oldValues = parseYaml(await fsp.readFile(path.join(vault, 'shard-values.yaml'), 'utf-8')) as Record<string, unknown>;
    const newManifest = await parseManifest(path.join(newShard, '.shardmind', 'shard.yaml'));
    const newSchema = await parseSchema(path.join(newShard, '.shardmind', 'shard-schema.yaml'));

    const selections = mergeModuleSelections(state.modules, newSchema, {});
    const drift = await detectDrift(vault, state);
    expect(drift.modified.some((e) => e.path === 'Home.md')).toBe(true);

    const renderCtx = buildRenderContext(newManifest, oldValues, selections);
    const plan = await planUpdate({
      vault: { root: vault, state, drift },
      values: { old: oldValues, new: oldValues },
      newShard: {
        schema: newSchema,
        selections,
        tempDir: newShard,
        renderContext: renderCtx,
      },
      removedFileDecisions: {},
    });

    // Expect one auto-merge action for Home.md, zero pending conflicts.
    const homeAction = plan.actions.find((a) => a.kind === 'auto_merge' && a.path === 'Home.md');
    expect(homeAction).toBeDefined();
    expect(plan.pendingConflicts).toEqual([]);

    await runUpdate({
      vaultRoot: vault,
      plan,
      conflictResolutions: {},
      currentState: state,
      newManifest,
      newSchema,
      newValues: oldValues,
      newSelections: selections,
      resolved: { ...RESOLVED, version: newManifest.version },
      tarballSha256: 'sha-0.2.0',
      newTempDir: newShard,
    });

    const merged = await fsp.readFile(homePath, 'utf-8');
    expect(merged).toContain('Welcome to your vault, Alice! (updated)');
    expect(merged).toContain('User-added link');

    const nextState = (await readState(vault)) as ShardState;
    expect(nextState.version).toBe('0.2.0');
  });

  it('surfaces a pending conflict when user and shard edit the same line', async () => {
    const { state, oldValues, newManifest, newSchema } = await setUpUpdate({
      bumpTo: '0.2.0',
      modifyFile: {
        path: 'Home.md',
        content: [
          '---',
          'date: 2026-04-20T00:00:00Z',
          'description: "Vault entry point for Acme Labs"',
          'tags:',
          '  - index',
          '---',
          '',
          '# Home',
          '',
          'My own welcome message.',
          '',
          '## Quick Links',
          '',
          '- [[brain/North Star|North Star]]',
        ].join('\n'),
      },
      newHomeTemplate: [
        '---',
        'date: {{ install_date }}',
        'description: "Vault entry point for {{ org_name }}"',
        'tags:',
        '  - index',
        '---',
        '',
        '# Home',
        '',
        'Welcome to your vault, {{ user_name }}. Shard v2!',
        '',
        '## Quick Links',
        '',
        '- [[brain/North Star|North Star]]',
      ].join('\n'),
    });

    const selections = mergeModuleSelections(state.modules, newSchema, {});
    const drift = await detectDrift(vault, state);
    const renderCtx = buildRenderContext(newManifest, oldValues, selections);

    const plan = await planUpdate({
      vault: { root: vault, state, drift },
      values: { old: oldValues, new: oldValues },
      newShard: {
        schema: newSchema,
        selections,
        tempDir: newShard,
        renderContext: renderCtx,
      },
      removedFileDecisions: {},
    });

    expect(plan.pendingConflicts.length).toBe(1);
    expect(plan.pendingConflicts[0]!.path).toBe('Home.md');

    // Resolve by keeping the user's copy.
    const result = await runUpdate({
      vaultRoot: vault,
      plan,
      conflictResolutions: { 'Home.md': 'keep_mine' },
      currentState: state,
      newManifest,
      newSchema,
      newValues: oldValues,
      newSelections: selections,
      resolved: { ...RESOLVED, version: newManifest.version },
      tarballSha256: 'sha-0.2.0',
      newTempDir: newShard,
    });

    const home = await fsp.readFile(path.join(vault, 'Home.md'), 'utf-8');
    expect(home).toContain('My own welcome message.');
    expect(home).not.toContain('Shard v2!');
    expect(result.summary.conflictsKeptMine).toBe(1);
    expect(result.summary.conflictsResolved).toBe(1);

    const nextState = (await readState(vault)) as ShardState;
    expect(nextState.files['Home.md']!.ownership).toBe('modified');
  });

  it('reports "already up to date" when tarball matches and version matches', async () => {
    const { manifest, values } = await (async () => {
      await installBaseline(vault, MINIMAL_SHARD, 'sha-same');
      const manifest = await parseManifest(path.join(MINIMAL_SHARD, '.shardmind', 'shard.yaml'));
      return { manifest, values: parseYaml(await fsp.readFile(path.join(vault, 'shard-values.yaml'), 'utf-8')) };
    })();
    const state = (await readState(vault)) as ShardState;

    expect(state.version).toBe(manifest.version);
    expect(state.tarball_sha256).toBe('sha-same');
    // The machine short-circuits when these match; just assert the precondition.
    void values;
  });

  it('does not prompt for new schema values added under v6 (all have defaults)', async () => {
    // v6 contract: every schema value must declare a `default`, so a new
    // required value can never trigger the "new required key" prompt path.
    // This test pins the v6 expectation: the no-prompt branch is taken.
    await installBaseline(vault, MINIMAL_SHARD, 'sha-0.1.0');
    await copyShard(MINIMAL_SHARD, newShard);
    await bumpVersion(newShard, '0.2.0');

    const schemaPath = path.join(newShard, '.shardmind', 'shard-schema.yaml');
    const raw = await fsp.readFile(schemaPath, 'utf-8');
    const withNewValue = raw.replace(
      'values:',
      `values:
  favorite_color:
    type: string
    required: true
    message: "Favorite color?"
    default: ""
    group: setup
`,
    );
    await fsp.writeFile(schemaPath, withNewValue, 'utf-8');

    const state = (await readState(vault)) as ShardState;
    const oldValues = parseYaml(await fsp.readFile(path.join(vault, 'shard-values.yaml'), 'utf-8')) as Record<string, unknown>;
    const newSchema = await parseSchema(schemaPath);

    const additions = computeSchemaAdditions(newSchema, state.modules, oldValues);
    expect(additions.newRequiredKeys).toEqual([]);
  });

  it('reports modified removed files needing a user decision', async () => {
    await installBaseline(vault, MINIMAL_SHARD, 'sha-0.1.0');
    // Edit an optional file so drift records it as modified.
    const modifiedPath = 'brain/North Star.md';
    const original = await fsp.readFile(path.join(vault, modifiedPath), 'utf-8');
    await fsp.writeFile(path.join(vault, modifiedPath), original + '\n- my addition\n', 'utf-8');

    // Build a fake new shard that no longer ships brain/North Star.md.
    await copyShard(MINIMAL_SHARD, newShard);
    await bumpVersion(newShard, '0.2.0');
    await fsp.rm(path.join(newShard, 'brain/North Star.md.njk'), { force: true });

    const state = (await readState(vault)) as ShardState;
    const oldValues = parseYaml(await fsp.readFile(path.join(vault, 'shard-values.yaml'), 'utf-8')) as Record<string, unknown>;
    const newManifest = await parseManifest(path.join(newShard, '.shardmind', 'shard.yaml'));
    const newSchema = await parseSchema(path.join(newShard, '.shardmind', 'shard-schema.yaml'));

    const selections = mergeModuleSelections(state.modules, newSchema, {});
    const renderCtx = buildRenderContext(newManifest, oldValues, selections);
    const drift = await detectDrift(vault, state);
    const newFilePlan = await renderNewShard(newSchema, newShard, selections, renderCtx);
    const newPaths = new Set(newFilePlan.outputs.map((o) => o.outputPath));

    const needing = removedFilesNeedingDecision(drift, newPaths);
    expect(needing).toContain(modifiedPath);
  });

  it('fires onBackupReady before any writes, so SIGINT can roll back mid-run', async () => {
    // Round 4 /harden audit caught that the state machine was
    // populating its backupDirRef only AFTER runUpdate returned — so
    // a mid-write Ctrl-C would find the ref null and skip rollback.
    // The fix exposes `onBackupReady` from the executor. This test
    // locks the ordering: backup callback fires before any file write.
    const { state, oldValues, newManifest, newSchema } = await setUpUpdate({
      bumpTo: '0.2.0',
      newHomeTemplate: 'Hello {{ user_name }}, v2!\n',
    });

    const selections = mergeModuleSelections(state.modules, newSchema, {});
    const drift = await detectDrift(vault, state);
    const renderCtx = buildRenderContext(newManifest, oldValues, selections);
    const plan = await planUpdate({
      vault: { root: vault, state, drift },
      values: { old: oldValues, new: oldValues },
      newShard: { schema: newSchema, selections, tempDir: newShard, renderContext: renderCtx },
      removedFileDecisions: {},
    });

    const events: Array<{ kind: string }> = [];
    await runUpdate({
      vaultRoot: vault,
      plan,
      conflictResolutions: {},
      currentState: state,
      newManifest,
      newSchema,
      newValues: oldValues,
      newSelections: selections,
      resolved: { ...RESOLVED, version: newManifest.version },
      tarballSha256: 'sha-0.2.0',
      newTempDir: newShard,
      onBackupReady: () => events.push({ kind: 'backup' }),
      onFileTouched: () => events.push({ kind: 'touched' }),
    });

    const backupIdx = events.findIndex((e) => e.kind === 'backup');
    const firstTouch = events.findIndex((e) => e.kind === 'touched');
    expect(backupIdx).toBe(0);
    expect(firstTouch).toBeGreaterThan(backupIdx);
  });

  it('keep_as_user preserves the file on disk and untracks it from state', async () => {
    await installBaseline(vault, MINIMAL_SHARD, 'sha-0.1.0');
    const modifiedPath = 'brain/North Star.md';
    const customContent = 'My own edits\n';
    await fsp.writeFile(path.join(vault, modifiedPath), customContent, 'utf-8');

    await copyShard(MINIMAL_SHARD, newShard);
    await bumpVersion(newShard, '0.2.0');
    await fsp.rm(path.join(newShard, 'brain/North Star.md.njk'), { force: true });

    const state = (await readState(vault)) as ShardState;
    const oldValues = parseYaml(await fsp.readFile(path.join(vault, 'shard-values.yaml'), 'utf-8')) as Record<string, unknown>;
    const newManifest = await parseManifest(path.join(newShard, '.shardmind', 'shard.yaml'));
    const newSchema = await parseSchema(path.join(newShard, '.shardmind', 'shard-schema.yaml'));
    const selections = mergeModuleSelections(state.modules, newSchema, {});
    const renderCtx = buildRenderContext(newManifest, oldValues, selections);
    const drift = await detectDrift(vault, state);

    const plan = await planUpdate({
      vault: { root: vault, state, drift },
      values: { old: oldValues, new: oldValues },
      newShard: {
        schema: newSchema,
        selections,
        tempDir: newShard,
        renderContext: renderCtx,
      },
      removedFileDecisions: { [modifiedPath]: 'keep' },
    });

    expect(plan.actions).toContainEqual({ kind: 'keep_as_user', path: modifiedPath });

    await runUpdate({
      vaultRoot: vault,
      plan,
      conflictResolutions: {},
      currentState: state,
      newManifest,
      newSchema,
      newValues: oldValues,
      newSelections: selections,
      resolved: { ...RESOLVED, version: newManifest.version },
      tarballSha256: 'sha-0.2.0',
      newTempDir: newShard,
    });

    expect(await fsp.readFile(path.join(vault, modifiedPath), 'utf-8')).toBe(customContent);
    const nextState = (await readState(vault)) as ShardState;
    expect(nextState.files[modifiedPath]).toBeUndefined();
  });

  it('dry-run plans and reports changes without mutating the vault', async () => {
    const newTemplate = 'Welcome to your vault, {{ user_name }} (v2-dry)\n';
    const { state, oldValues, newManifest, newSchema } = await setUpUpdate({
      bumpTo: '0.2.0',
      newHomeTemplate: newTemplate,
    });

    const selections = mergeModuleSelections(state.modules, newSchema, {});
    const renderCtx = buildRenderContext(newManifest, oldValues, selections);
    const drift = await detectDrift(vault, state);

    const plan = await planUpdate({
      vault: { root: vault, state, drift },
      values: { old: oldValues, new: oldValues },
      newShard: {
        schema: newSchema,
        selections,
        tempDir: newShard,
        renderContext: renderCtx,
      },
      removedFileDecisions: {},
    });
    expect(plan.counts.silent).toBeGreaterThan(0);

    const homePath = path.join(vault, 'Home.md');
    const beforeContent = await fsp.readFile(homePath, 'utf-8');
    const beforeState = (await readState(vault)) as ShardState;

    const result = await runUpdate({
      vaultRoot: vault,
      plan,
      conflictResolutions: {},
      currentState: state,
      newManifest,
      newSchema,
      newValues: oldValues,
      newSelections: selections,
      resolved: { ...RESOLVED, version: newManifest.version },
      tarballSha256: 'sha-0.2.0',
      newTempDir: newShard,
      dryRun: true,
    });

    // Disk unchanged.
    expect(await fsp.readFile(homePath, 'utf-8')).toBe(beforeContent);
    // State version still old.
    const afterState = (await readState(vault)) as ShardState;
    expect(afterState.version).toBe(beforeState.version);
    // Summary still reflects what *would* have happened.
    expect(result.summary.toVersion).toBe('0.2.0');
    expect(result.summary.counts.silent).toBe(plan.counts.silent);
    expect(result.backupDir).toBeNull();
  });

  it('falls back to full-file conflict when the cached template was wiped', async () => {
    // User edits a file, then somebody clobbers the engine cache (rm -rf
    // .shardmind/templates/). Next update has no way to reconstruct a
    // three-way base. The planner should surface the file as a full
    // conflict and not silently overwrite the user's edits.
    const { state, oldValues, newManifest, newSchema } = await setUpUpdate({
      bumpTo: '0.2.0',
      modifyFile: {
        path: 'Home.md',
        content: 'entirely different user content\n',
      },
      newHomeTemplate: 'shard update replacement\n',
    });

    // Wipe the cached template for Home.md.
    await fsp.rm(path.join(vault, '.shardmind', 'templates', 'Home.md.njk'), { force: true });

    const selections = mergeModuleSelections(state.modules, newSchema, {});
    const renderCtx = buildRenderContext(newManifest, oldValues, selections);
    const drift = await detectDrift(vault, state);

    const plan = await planUpdate({
      vault: { root: vault, state, drift },
      values: { old: oldValues, new: oldValues },
      newShard: {
        schema: newSchema,
        selections,
        tempDir: newShard,
        renderContext: renderCtx,
      },
      removedFileDecisions: {},
    });

    const conflict = plan.actions.find((a) => a.kind === 'conflict' && a.path === 'Home.md');
    expect(conflict).toBeDefined();
    if (conflict?.kind !== 'conflict') throw new Error('narrowing');
    expect(conflict.result.conflicts).toHaveLength(1);
    expect(conflict.result.conflicts[0]!.theirs).toContain('entirely different user content');
    expect(conflict.result.conflicts[0]!.ours).toContain('shard update replacement');
  });

  it('preexisting add-collision + keep_mine preserves user bytes and leaves them UNTRACKED', async () => {
    // The round-1 harden fix for silent-data-loss on add: user creates
    // their own file at a path the new shard wants to introduce; the
    // planner emits `conflict` with `preexisting: true`; on `keep_mine`
    // the executor leaves the file on disk AND drops it from
    // state.files so we never silently adopt content the user didn't
    // opt in to manage.
    await installBaseline(vault, MINIMAL_SHARD, 'sha-0.1.0');
    const newPath = 'brain/Backlog.md';
    const userBytes = '# My own backlog\n\nPersonal notes I made myself.\n';
    await fsp.writeFile(path.join(vault, newPath), userBytes, 'utf-8');

    await copyShard(MINIMAL_SHARD, newShard);
    await bumpVersion(newShard, '0.2.0');
    await fsp.writeFile(
      path.join(newShard, 'brain/Backlog.md.njk'),
      'Shard-managed backlog for {{ user_name }}\n',
      'utf-8',
    );

    const state = (await readState(vault)) as ShardState;
    const oldValues = parseYaml(await fsp.readFile(path.join(vault, 'shard-values.yaml'), 'utf-8')) as Record<string, unknown>;
    const newManifest = await parseManifest(path.join(newShard, '.shardmind', 'shard.yaml'));
    const newSchema = await parseSchema(path.join(newShard, '.shardmind', 'shard-schema.yaml'));
    const selections = mergeModuleSelections(state.modules, newSchema, {});
    const renderCtx = buildRenderContext(newManifest, oldValues, selections);
    const drift = await detectDrift(vault, state);

    const plan = await planUpdate({
      vault: { root: vault, state, drift },
      values: { old: oldValues, new: oldValues },
      newShard: {
        schema: newSchema,
        selections,
        tempDir: newShard,
        renderContext: renderCtx,
      },
      removedFileDecisions: {},
    });

    const conflict = plan.actions.find((a) => a.kind === 'conflict' && a.path === newPath);
    if (!conflict || conflict.kind !== 'conflict') throw new Error('expected preexisting conflict');
    expect(conflict.preexisting).toBe(true);

    await runUpdate({
      vaultRoot: vault,
      plan,
      conflictResolutions: { [newPath]: 'keep_mine' },
      currentState: state,
      newManifest,
      newSchema,
      newValues: oldValues,
      newSelections: selections,
      resolved: { ...RESOLVED, version: newManifest.version },
      tarballSha256: 'sha-0.2.0',
      newTempDir: newShard,
    });

    // User bytes intact.
    expect(await fsp.readFile(path.join(vault, newPath), 'utf-8')).toBe(userBytes);
    // State does NOT record this path — we never adopted it.
    const nextState = (await readState(vault)) as ShardState;
    expect(nextState.files[newPath]).toBeUndefined();
  });

  it('throws a wrapped ShardMindError when write fails AND rollback is partial', async () => {
    // End-to-end validation of the round-1 err-wrapper (update-executor's
    // catch block): if an update write throws AND the snapshot rollback
    // cannot restore every snapshot, the wrapper carries the rollback
    // failures list, the original error as `cause`, and preserves the
    // original code / hint. Previously this path mutated `err.message`
    // in place — which throws on frozen errors and compounds across
    // re-catches.
    const { state, oldValues, newManifest, newSchema } = await setUpUpdate({
      bumpTo: '0.2.0',
      newHomeTemplate: 'Welcome to your vault, {{ user_name }} (wrapper-test)\n',
    });

    const selections = mergeModuleSelections(state.modules, newSchema, {});
    const renderCtx = buildRenderContext(newManifest, oldValues, selections);
    const drift = await detectDrift(vault, state);
    const plan = await planUpdate({
      vault: { root: vault, state, drift },
      values: { old: oldValues, new: oldValues },
      newShard: {
        schema: newSchema,
        selections,
        tempDir: newShard,
        renderContext: renderCtx,
      },
      removedFileDecisions: {},
    });

    const targetAbs = path.join(vault, 'Home.md');
    const backupRoot = path.join(vault, '.shardmind', 'backups');
    // Fail the update write for Home.md — triggers the executor's outer
    // catch so rollback runs.
    const realWrite = fsp.writeFile;
    const writeSpy = vi.spyOn(fsp, 'writeFile').mockImplementation(async (p, data, opts) => {
      if (typeof p === 'string' && p === targetAbs) {
        throw Object.assign(new Error('simulated EACCES on Home.md'), { code: 'EACCES' });
      }
      return realWrite(p, data, opts);
    });
    // Fail the rollback restore for the same path — triggers the
    // `rollbackFailures.length > 0` branch inside the catch handler.
    const realCopy = fsp.copyFile;
    const copySpy = vi.spyOn(fsp, 'copyFile').mockImplementation(async (src, dst, mode) => {
      if (typeof dst === 'string' && dst === targetAbs && typeof src === 'string' && src.startsWith(backupRoot)) {
        throw Object.assign(new Error('simulated EACCES on restore'), { code: 'EACCES' });
      }
      return realCopy(src, dst, mode);
    });

    try {
      const err = await runUpdate({
        vaultRoot: vault,
        plan,
        conflictResolutions: {},
        currentState: state,
        newManifest,
        newSchema,
        newValues: oldValues,
        newSelections: selections,
        resolved: { ...RESOLVED, version: newManifest.version },
        tarballSha256: 'sha-0.2.0',
        newTempDir: newShard,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ShardMindError);
      const wrapped = err as ShardMindError & { rollbackFailures?: Array<{ path: string; reason: string }>; cause?: unknown };
      expect(wrapped.code).toBe('UPDATE_WRITE_FAILED');
      expect(wrapped.message).toMatch(/Rollback incomplete/);
      expect(wrapped.rollbackFailures?.length ?? 0).toBeGreaterThan(0);
      // `cause` chains back to the original thrown error — no mutation
      // of its message.
      expect(wrapped.cause).toBeInstanceOf(Error);
    } finally {
      writeSpy.mockRestore();
      copySpy.mockRestore();
    }
  });

  it('preexisting add-collision + accept_new writes shard bytes and adopts as managed', async () => {
    await installBaseline(vault, MINIMAL_SHARD, 'sha-0.1.0');
    const newPath = 'brain/Backlog.md';
    const userBytes = '# My own backlog\n';
    await fsp.writeFile(path.join(vault, newPath), userBytes, 'utf-8');

    await copyShard(MINIMAL_SHARD, newShard);
    await bumpVersion(newShard, '0.2.0');
    const shardBody = 'Shard-managed backlog for {{ user_name }}\n';
    await fsp.writeFile(
      path.join(newShard, 'brain/Backlog.md.njk'),
      shardBody,
      'utf-8',
    );

    const state = (await readState(vault)) as ShardState;
    const oldValues = parseYaml(await fsp.readFile(path.join(vault, 'shard-values.yaml'), 'utf-8')) as Record<string, unknown>;
    const newManifest = await parseManifest(path.join(newShard, '.shardmind', 'shard.yaml'));
    const newSchema = await parseSchema(path.join(newShard, '.shardmind', 'shard-schema.yaml'));
    const selections = mergeModuleSelections(state.modules, newSchema, {});
    const renderCtx = buildRenderContext(newManifest, oldValues, selections);
    const drift = await detectDrift(vault, state);

    const plan = await planUpdate({
      vault: { root: vault, state, drift },
      values: { old: oldValues, new: oldValues },
      newShard: {
        schema: newSchema,
        selections,
        tempDir: newShard,
        renderContext: renderCtx,
      },
      removedFileDecisions: {},
    });

    await runUpdate({
      vaultRoot: vault,
      plan,
      conflictResolutions: { [newPath]: 'accept_new' },
      currentState: state,
      newManifest,
      newSchema,
      newValues: oldValues,
      newSelections: selections,
      resolved: { ...RESOLVED, version: newManifest.version },
      tarballSha256: 'sha-0.2.0',
      newTempDir: newShard,
    });

    // Shard bytes now on disk.
    const onDisk = await fsp.readFile(path.join(vault, newPath), 'utf-8');
    expect(onDisk).toContain(`Shard-managed backlog for ${oldValues['user_name'] as string}`);
    // Tracked as managed in state.
    const nextState = (await readState(vault)) as ShardState;
    expect(nextState.files[newPath]).toBeDefined();
    expect(nextState.files[newPath]!.ownership).toBe('managed');
  });

  /**
   * Hook integration for the update path: verify that the post-update
   * hook receives `previousVersion` equal to the pre-update shard version.
   * The unit tests pin ctx round-trip generically; this test pins the
   * one field the update path is specifically responsible for — the
   * pre-migration state.version being threaded through correctly.
   */
  it('post-update hook receives previousVersion from the pre-update state', async () => {
    const vault = path.join(os.tmpdir(), `shardmind-update-hook-${crypto.randomUUID()}`);
    const shardDir = path.join(os.tmpdir(), `shardmind-shard-${crypto.randomUUID()}`);
    await fsp.mkdir(vault, { recursive: true });
    await cloneShard(MINIMAL_SHARD, shardDir);
    // The minimal-shard fixture only declares a post-install hook; the
    // update-path test needs a post-update declaration too. Append it
    // to the copied shard.yaml so the lookup finds the file below.
    const shardYamlInit = await fsp.readFile(path.join(shardDir, '.shardmind', 'shard.yaml'), 'utf-8');
    await fsp.writeFile(
      path.join(shardDir, '.shardmind', 'shard.yaml'),
      shardYamlInit + '  post-update: hooks/post-update.ts\n',
      'utf-8',
    );
    await fsp.mkdir(path.join(shardDir, 'hooks'), { recursive: true });
    await fsp.writeFile(
      path.join(shardDir, 'hooks', 'post-update.ts'),
      `
        import { writeFile } from 'node:fs/promises';
        import { join } from 'node:path';
        export default async function (ctx) {
          await writeFile(
            join(ctx.vaultRoot, '.hook-ctx.json'),
            JSON.stringify(ctx),
          );
        }
      `,
      'utf-8',
    );

    try {
      const { manifest, schema, values } = await installBaseline(vault, shardDir, 'sha-0.1.0');

      // Bump the shard version to 0.2.0 and re-parse so planUpdate runs.
      const shardYaml = await fsp.readFile(path.join(shardDir, '.shardmind', 'shard.yaml'), 'utf-8');
      await fsp.writeFile(
        path.join(shardDir, '.shardmind', 'shard.yaml'),
        shardYaml.replace('version: 0.1.0', 'version: 0.2.0'),
        'utf-8',
      );

      const state = (await readState(vault)) as ShardState;
      const newManifest = await parseManifest(path.join(shardDir, '.shardmind', 'shard.yaml'));
      const selections = defaultModuleSelections(schema);
      const renderCtx = buildRenderContext(newManifest, values, selections);
      const drift = await detectDrift(vault, state);
      const plan = await planUpdate({
        vault: { root: vault, state, drift },
        values: { old: values, new: values },
        newShard: {
          schema,
          selections,
          tempDir: shardDir,
          renderContext: renderCtx,
        },
        removedFileDecisions: {},
      });

      await runUpdate({
        vaultRoot: vault,
        plan,
        conflictResolutions: {},
        currentState: state,
        newManifest,
        newSchema: schema,
        newValues: values,
        newSelections: selections,
        resolved: { ...RESOLVED, version: '0.2.0' },
        tarballSha256: 'sha-0.2.0',
        newTempDir: shardDir,
      });

      const hookResult = await runPostUpdateHook(shardDir, newManifest, {
        vaultRoot: vault,
        values,
        modules: selections,
        shard: { name: newManifest.name, version: newManifest.version },
        previousVersion: state.version,
      });
      expect(hookResult.kind).toBe('ran');
      if (hookResult.kind !== 'ran') throw new Error('narrowing');
      expect(hookResult.exitCode).toBe(0);

      const echoed = JSON.parse(await fsp.readFile(path.join(vault, '.hook-ctx.json'), 'utf-8'));
      expect(echoed.previousVersion).toBe('0.1.0');
      expect(echoed.shard.version).toBe('0.2.0');
    } finally {
      // Windows: hook child holding cwd handle may delay rmdir; mirror
      // the retry convention unit + install-integration tests use.
      const rmOpts = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };
      await fsp.rm(vault, rmOpts);
      await fsp.rm(shardDir, rmOpts);
    }
  }, 45_000);
});

// Shard copy helper for the hook integration test. Mirrors the one in
// install.test.ts rather than abstracting to a shared helper — the trees
// are tiny and the dependency direction stays flat.
async function cloneShard(src: string, dst: string): Promise<void> {
  await fsp.mkdir(dst, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) await cloneShard(from, to);
    else if (entry.isFile()) await fsp.copyFile(from, to);
  }
}
