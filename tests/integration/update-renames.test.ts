/**
 * Rename migrations on update (#178): a shard release that moves a file
 * declares it in `shard.yaml`, and the update carries the file, with the
 * user's edits, to the new path. Spec: docs/SHARD-LAYOUT.md §Rename
 * migrations; IMPLEMENTATION.md §4.11 step 0 and §4.12 step 4a.
 *
 * `update()` wires the pieces the way the update machine does: renames
 * between the installed and target versions, re-keyed state and drift,
 * the removed-files list, the plan, then the executor.
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
import {
  planUpdate,
  mergeModuleSelections,
  renderNewShard,
  removedFilesNeedingDecision,
  type ConflictResolution,
} from '../../source/core/update-planner.js';
import { runUpdate } from '../../source/core/update-executor.js';
import { defaultModuleSelections, resolveComputedDefaults } from '../../source/core/install-planner.js';
import { runInstall } from '../../source/core/install-executor.js';
import { buildRenderContext } from '../../source/core/renderer.js';
import { renamesBetween, applyRenames } from '../../source/core/rename-migrations.js';
import type { ResolvedShard, ShardState } from '../../source/runtime/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MINIMAL_SHARD = path.resolve(__dirname, '../../examples/minimal-shard');

const RESOLVED: ResolvedShard = {
  namespace: 'shardmind',
  name: 'minimal',
  version: '0.1.0',
  source: 'github:shardmind/minimal',
  tarballUrl: 'n/a (local fixture)',
};

const BASE_VALUES = { user_name: 'Alice', org_name: 'Acme Labs', vault_purpose: 'engineering' as const, qmd_enabled: true };

/** Copy-origin: copied verbatim, so its bytes are stable across runs. */
const COPY = 'CLAUDE.md';
const COPY_LINE = 'Static agent-config file for the minimal-shard fixture.';
/** Rendered note with a user-editable body. */
const NOTE = 'brain/North Star.md';
const NOTE_SRC = 'brain/North Star.md.njk';
const VOLATILE_MARKER = '{# shardmind: volatile #}';

type SourceEdits = Record<string, ((source: string) => string) | null>;

describe('update applies rename migrations (#178)', () => {
  let root: string;
  let vault: string;

  beforeEach(async () => {
    root = path.join(os.tmpdir(), `shardmind-178-${crypto.randomUUID()}`);
    vault = path.join(root, 'vault');
    await fsp.mkdir(vault, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fsp.rm(root, { recursive: true, force: true });
  });

  /**
   * A copy of the minimal shard at `version`: each `moves` source moved
   * (old source path → new source path), each `edits` source rewritten
   * (null deletes it), and `migrations` appended to shard.yaml.
   */
  async function shardAt(
    version: string,
    opts: { moves?: Record<string, string>; edits?: SourceEdits; migrations?: string; from?: string } = {},
  ): Promise<string> {
    const dir = path.join(root, `shard-${version}-${crypto.randomUUID().slice(0, 6)}`);
    await fsp.cp(opts.from ?? MINIMAL_SHARD, dir, { recursive: true });
    const manifestPath = path.join(dir, '.shardmind', 'shard.yaml');
    let manifest = (await fsp.readFile(manifestPath, 'utf-8')).replace(/^version: .+$/m, `version: ${version}`);
    manifest = manifest.replace(/\nmigrations:[\s\S]*$/, '\n');
    if (opts.migrations) manifest += `\nmigrations:\n${opts.migrations}`;
    await fsp.writeFile(manifestPath, manifest, 'utf-8');
    for (const [from, to] of Object.entries(opts.moves ?? {})) {
      await fsp.mkdir(path.dirname(path.join(dir, to)), { recursive: true });
      await fsp.rename(path.join(dir, from), path.join(dir, to));
    }
    for (const [rel, edit] of Object.entries(opts.edits ?? {})) {
      const p = path.join(dir, rel);
      if (edit === null) {
        await fsp.rm(p, { force: true });
        continue;
      }
      const current = await fsp.readFile(p, 'utf-8').catch(() => '');
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await fsp.writeFile(p, edit(current), 'utf-8');
    }
    return dir;
  }

  async function install(shardDir = MINIMAL_SHARD): Promise<void> {
    const manifest = await parseManifest(path.join(shardDir, '.shardmind', 'shard.yaml'));
    const schema = await parseSchema(path.join(shardDir, '.shardmind', 'shard-schema.yaml'));
    const values = buildValuesValidator(schema).parse(resolveComputedDefaults(schema, BASE_VALUES)) as Record<string, unknown>;
    await runInstall({
      vaultRoot: vault,
      manifest,
      schema,
      tempDir: shardDir,
      resolved: { ...RESOLVED, version: manifest.version },
      tarballSha256: 'sha-0.1.0',
      values,
      selections: defaultModuleSelections(schema),
    });
  }

  /** One update as the machine runs it, resolving every conflict as `resolution`. */
  async function update(
    shardDir: string,
    resolution: ConflictResolution = 'keep_mine',
    dryRun = false,
    beforeRun?: () => Promise<void>,
  ) {
    const state = (await readState(vault)) as ShardState;
    const values = parseYaml(await fsp.readFile(path.join(vault, 'shard-values.yaml'), 'utf-8')) as Record<string, unknown>;
    const manifest = await parseManifest(path.join(shardDir, '.shardmind', 'shard.yaml'));
    const schema = await parseSchema(path.join(shardDir, '.shardmind', 'shard-schema.yaml'));
    const selections = mergeModuleSelections(state.modules, schema, {});
    const renderContext = buildRenderContext(manifest, values, selections);
    const filePlan = await renderNewShard(schema, shardDir, selections, renderContext);
    const newPaths = new Set(filePlan.outputs.map((o) => o.outputPath));
    const renamed = await applyRenames({
      vaultRoot: vault,
      state,
      drift: await detectDrift(vault, state),
      renames: renamesBetween(manifest.migrations, state.version, manifest.version),
      newPaths,
    });
    const removed = removedFilesNeedingDecision(renamed.drift, newPaths);
    const plan = await planUpdate({
      vault: { root: vault, state: renamed.state, drift: renamed.drift, movedFrom: renamed.movedFrom },
      values: { old: values, new: values },
      newShard: { schema, selections, tempDir: shardDir, renderContext, filePlan },
      removedFileDecisions: {},
    });
    const conflictResolutions = Object.fromEntries(plan.pendingConflicts.map((c) => [c.path, resolution]));
    await beforeRun?.();
    const result = await runUpdate({
      vaultRoot: vault,
      plan,
      conflictResolutions,
      currentState: state,
      newManifest: manifest,
      newSchema: schema,
      newValues: values,
      newSelections: selections,
      resolved: { ...RESOLVED, version: manifest.version },
      tarballSha256: `sha-${manifest.version}`,
      newTempDir: shardDir,
      dryRun,
    });
    return { plan, result, removed };
  }

  const read = (rel: string) => fsp.readFile(path.join(vault, rel), 'utf-8');
  const write = (rel: string, content: string) => fsp.writeFile(path.join(vault, rel), content, 'utf-8');
  const exists = (rel: string) => fsp.access(path.join(vault, rel)).then(() => true, () => false);
  const files = async () => ((await readState(vault)) as ShardState).files;
  const moveCopy = (version: string, edits: SourceEdits = {}) =>
    shardAt(version, {
      moves: { [COPY]: 'AGENTS.md' },
      edits,
      migrations: `  - from: "0.1.0"\n    to: "${version}"\n    renames:\n      "${COPY}": "AGENTS.md"\n`,
    });
  const moveNote = (version: string, edits: SourceEdits = {}) =>
    shardAt(version, {
      moves: { [NOTE_SRC]: 'brain/Guiding Star.md.njk' },
      edits,
      migrations: `  - from: "0.1.0"\n    to: "${version}"\n    renames:\n      "${NOTE}": "brain/Guiding Star.md"\n`,
    });

  it('moves an unchanged managed file and its state entry to the new path', async () => {
    await install();
    const before = await read(COPY);
    const { result } = await update(await moveCopy('0.2.0'));
    expect(await exists(COPY)).toBe(false);
    expect(await read('AGENTS.md')).toBe(before);
    const state = await files();
    expect(state[COPY]).toBeUndefined();
    expect(state['AGENTS.md']?.ownership).toBe('managed');
    // Recorded under the new template, so a later merge finds its base.
    expect(state['AGENTS.md']?.template).toBe('AGENTS.md');
    expect(result.summary.renamedFiles).toEqual([{ from: COPY, to: 'AGENTS.md' }]);
  });

  it('merges a later edit into a moved file on the next update', async () => {
    await install();
    const v2 = await moveCopy('0.2.0');
    await update(v2);
    const moved = await read('AGENTS.md');
    await write('AGENTS.md', moved.replace('# Minimal Shard', '# My Shard'));
    const v3 = await shardAt('0.3.0', {
      from: v2,
      edits: { 'AGENTS.md': (src) => src.replace(COPY_LINE, 'Changed in 0.3.0.') },
    });
    const { plan } = await update(v3);
    expect(plan.pendingConflicts).toEqual([]);
    const merged = await read('AGENTS.md');
    expect(merged).toContain('# My Shard');
    expect(merged).toContain('Changed in 0.3.0.');
  });

  it('overwrites a managed file the shard changed, at the new path', async () => {
    await install();
    await update(await moveCopy('0.2.0', { 'AGENTS.md': (s) => s.replace(COPY_LINE, 'Changed in 0.2.0.') }));
    expect(await exists(COPY)).toBe(false);
    expect(await read('AGENTS.md')).toContain('Changed in 0.2.0.');
  });

  it("moves a file the user edited and the shard did not change, keeping the user's bytes", async () => {
    await install();
    await write(COPY, 'My own agent notes.\n');
    await update(await moveCopy('0.2.0'));
    expect(await exists(COPY)).toBe(false);
    expect(await read('AGENTS.md')).toBe('My own agent notes.\n');
    expect((await files())['AGENTS.md']?.ownership).toBe('modified');
  });

  it("merges the user's edits with the shard's change at the new path", async () => {
    await install();
    const note = await read(NOTE);
    await write(NOTE, note.replace('## Goals\n\n-', '## Goals\n\n- Ship v6'));
    await update(
      await moveNote('0.2.0', {
        'brain/Guiding Star.md.njk': (s) => s.replace('# North Star', '# Guiding Star'),
      }),
    );
    expect(await exists(NOTE)).toBe(false);
    const merged = await read('brain/Guiding Star.md');
    expect(merged).toContain('- Ship v6');
    expect(merged).toContain('# Guiding Star');
    expect((await files())[NOTE]).toBeUndefined();
  });

  it.each(['keep_mine', 'accept_new'] as const)(
    'resolves a conflict at the new path with %s',
    async (resolution) => {
      await install();
      const note = await read(NOTE);
      await write(NOTE, note.replace('# North Star', '# My Star'));
      const { plan } = await update(
        await moveNote('0.2.0', { 'brain/Guiding Star.md.njk': (s) => s.replace('# North Star', '# Guiding Star') }),
        resolution,
      );
      expect(plan.pendingConflicts.map((c) => c.path)).toEqual(['brain/Guiding Star.md']);
      expect(await exists(NOTE)).toBe(false);
      const after = await read('brain/Guiding Star.md');
      expect(after).toContain(resolution === 'keep_mine' ? '# My Star' : '# Guiding Star');
    },
  );

  it('follows a chain of renames across two releases in one update', async () => {
    await install();
    await write(COPY, 'Mine.\n');
    const v3 = await shardAt('0.3.0', {
      moves: { [COPY]: 'agents/GUIDE.md' },
      migrations:
        `  - from: "0.1.0"\n    to: "0.2.0"\n    renames:\n      "${COPY}": "AGENTS.md"\n` +
        `  - from: "0.2.0"\n    to: "0.3.0"\n    renames:\n      "AGENTS.md": "agents/GUIDE.md"\n`,
    });
    await update(v3);
    expect(await exists(COPY)).toBe(false);
    expect(await exists('AGENTS.md')).toBe(false);
    expect(await read('agents/GUIDE.md')).toBe('Mine.\n');
  });

  it('falls back to remove-and-add when something already sits at the new path', async () => {
    await install();
    await write(COPY, 'My edit.\n');
    await write('AGENTS.md', 'Somebody else.\n');
    const { plan, removed } = await update(await moveCopy('0.2.0'));
    // The old file is offered as removed; the new path is an add-collision.
    expect(removed).toContain(COPY);
    expect(plan.actions.find((a) => a.path === 'AGENTS.md')?.kind).toBe('conflict');
    expect(await read(COPY)).toBe('My edit.\n');
  });

  it('falls back when the new shard does not produce the new path', async () => {
    await install();
    await write(COPY, 'My edit.\n');
    // Declares the rename but ships no AGENTS.md (and drops CLAUDE.md).
    const v2 = await shardAt('0.2.0', {
      edits: { [COPY]: null },
      migrations: `  - from: "0.1.0"\n    to: "0.2.0"\n    renames:\n      "${COPY}": "AGENTS.md"\n`,
    });
    const { removed } = await update(v2);
    expect(removed).toContain(COPY);
    expect(await exists('AGENTS.md')).toBe(false);
  });

  it('moves a volatile file as it is', async () => {
    const v1 = await shardAt('0.1.0', { edits: { 'log.md.njk': () => `${VOLATILE_MARKER}\nStarts empty.\n` } });
    await install(v1);
    await write('log.md', 'My running log.\n');
    const v2 = await shardAt('0.2.0', {
      from: v1,
      moves: { 'log.md.njk': 'logs/log.md.njk' },
      migrations: `  - from: "0.1.0"\n    to: "0.2.0"\n    renames:\n      "log.md": "logs/log.md"\n`,
    });
    await update(v2);
    expect(await exists('log.md')).toBe(false);
    expect(await read('logs/log.md')).toBe('My running log.\n');
    expect((await files())['logs/log.md']?.template).toBe('logs/log.md.njk');
  });

  it('restores a file the user deleted at the new path', async () => {
    await install();
    await fsp.rm(path.join(vault, COPY));
    await update(await moveCopy('0.2.0'));
    expect(await read('AGENTS.md')).toContain(COPY_LINE);
    expect((await files())[COPY]).toBeUndefined();
  });

  it('refuses a rename whose new path lies under a symlinked folder (#163)', async (ctx) => {
    await install();
    const outside = path.join(root, 'outside');
    await fsp.mkdir(outside);
    try {
      await fsp.symlink(outside, path.join(vault, 'linked'), 'dir');
    } catch {
      ctx.skip();
    }
    const v2 = await shardAt('0.2.0', {
      moves: { [COPY]: 'linked/AGENTS.md' },
      migrations: `  - from: "0.1.0"\n    to: "0.2.0"\n    renames:\n      "${COPY}": "linked/AGENTS.md"\n`,
    });
    await expect(update(v2)).rejects.toMatchObject({ code: 'VAULT_PATH_UNSAFE' });
    expect(await fsp.readdir(outside)).toEqual([]);
  });

  it('drops both renames when two tracked files would move to one path', async () => {
    const v1 = await shardAt('0.1.0', { edits: { 'NOTES.md': () => 'Notes.\n' } });
    await install(v1);
    const v3 = await shardAt('0.3.0', {
      from: v1,
      moves: { [COPY]: 'AGENTS.md' },
      edits: { 'NOTES.md': null },
      migrations:
        `  - from: "0.1.0"\n    to: "0.2.0"\n    renames:\n      "${COPY}": "AGENTS.md"\n` +
        `  - from: "0.2.0"\n    to: "0.3.0"\n    renames:\n      "NOTES.md": "AGENTS.md"\n`,
    });
    const { result } = await update(v3);
    expect(result.summary.renamedFiles).toEqual([]);
    expect(await read('AGENTS.md')).toContain(COPY_LINE);
  });

  it('falls back when the new path is already tracked', async () => {
    const v1 = await shardAt('0.1.0', { edits: { 'AGENTS.md': () => 'Already here.\n' } });
    await install(v1);
    const v2 = await shardAt('0.2.0', {
      from: v1,
      edits: { [COPY]: null },
      migrations: `  - from: "0.1.0"\n    to: "0.2.0"\n    renames:\n      "${COPY}": "AGENTS.md"\n`,
    });
    const { result } = await update(v2);
    expect(result.summary.renamedFiles).toEqual([]);
    expect(await read('AGENTS.md')).toBe('Already here.\n');
  });

  it('restores a volatile file the user deleted at the new path, without failing', async () => {
    const v1 = await shardAt('0.1.0', { edits: { 'log.md.njk': () => `${VOLATILE_MARKER}\nStarts empty.\n` } });
    await install(v1);
    await fsp.rm(path.join(vault, 'log.md'));
    const v2 = await shardAt('0.2.0', {
      from: v1,
      moves: { 'log.md.njk': 'logs/log.md.njk' },
      migrations: `  - from: "0.1.0"\n    to: "0.2.0"\n    renames:\n      "log.md": "logs/log.md"\n`,
    });
    await update(v2);
    // Missing, so restored there from the template, as without a rename.
    expect(await read('logs/log.md')).toContain('Starts empty.');
    expect((await files())['log.md']).toBeUndefined();
  });

  it('drops a rename whose old path the new shard still ships', async () => {
    await install();
    await write(COPY, 'My edit.\n');
    const v2 = await shardAt('0.2.0', {
      edits: { 'AGENTS.md': () => 'Agents.\n' },
      migrations: `  - from: "0.1.0"\n    to: "0.2.0"\n    renames:\n      "${COPY}": "AGENTS.md"\n`,
    });
    const { result } = await update(v2);
    expect(result.summary.renamedFiles).toEqual([]);
    expect(await read(COPY)).toBe('My edit.\n');
    expect(await read('AGENTS.md')).toBe('Agents.\n');
  });

  it('drops a rename whose new path needs a folder where a file sits', async () => {
    await install();
    await write('notes', 'a file, not a folder\n');
    const state = (await readState(vault)) as ShardState;
    const { movedFrom } = await applyRenames({
      vaultRoot: vault,
      state,
      drift: await detectDrift(vault, state),
      renames: new Map([[COPY, 'notes/AGENTS.md']]),
      newPaths: new Set(['notes/AGENTS.md']),
    });
    // Windows reports ENOENT, not ENOTDIR, under a file: the folder check catches it.
    expect(movedFrom).toEqual(new Map());
  });

  it('refuses before any write when a file arrives at a new path the shard writes', async () => {
    await install();
    const v2 = await moveCopy('0.2.0', { 'AGENTS.md': (src) => src.replace(COPY_LINE, 'Changed in 0.2.0.') });
    const arrive = () => fsp.writeFile(path.join(vault, 'AGENTS.md'), 'Arrived meanwhile.\n', 'utf-8');
    const stateBefore = await read('.shardmind/state.json');
    await expect(update(v2, 'keep_mine', false, arrive)).rejects.toMatchObject({ code: 'UPDATE_WRITE_FAILED' });
    expect(await read('AGENTS.md')).toBe('Arrived meanwhile.\n');
    expect(await read(COPY)).toContain(COPY_LINE);
    expect(await read('.shardmind/state.json')).toBe(stateBefore);
  });

  it('moves the state of a renamed volatile file whose file the user deleted', async () => {
    await install();
    const manifest = await parseManifest(path.join(MINIMAL_SHARD, '.shardmind', 'shard.yaml'));
    const schema = await parseSchema(path.join(MINIMAL_SHARD, '.shardmind', 'shard-schema.yaml'));
    const state = (await readState(vault)) as ShardState;
    const values = parseYaml(await read('shard-values.yaml')) as Record<string, unknown>;
    // A volatile entry for a file that is gone: the move has nothing to carry.
    const withVolatile: ShardState = {
      ...state,
      files: { ...state.files, 'log.md': { template: 'log.md.njk', rendered_hash: 'x', ownership: 'user' } as never },
    };
    const zero = { silent: 0, overwritten: 0, adopted: 0, autoMerged: 0, conflicts: 0, volatile: 1, added: 0, deleted: 0, keptAsUser: 0, restored: 0 };
    const result = await runUpdate({
      vaultRoot: vault,
      plan: {
        actions: [{ kind: 'skip_volatile', path: 'logs/log.md', renamedFrom: 'log.md', renamedKeys: { templateKey: 'logs/log.md.njk' } }],
        pendingConflicts: [],
        counts: zero,
      },
      conflictResolutions: {},
      currentState: withVolatile,
      newManifest: { ...manifest, version: '0.2.0' },
      newSchema: schema,
      newValues: values,
      newSelections: state.modules,
      resolved: { ...RESOLVED, version: '0.2.0' },
      tarballSha256: 'sha-0.2.0',
      newTempDir: MINIMAL_SHARD,
    });
    expect(await exists('logs/log.md')).toBe(false);
    expect(result.state.files['log.md']).toBeUndefined();
    expect(result.state.files['logs/log.md']?.template).toBe('logs/log.md.njk');
  });

  it('refuses to move over a file that appeared at the new path after planning, and keeps it', async () => {
    await install();
    await write(COPY, 'My edit.\n');
    const v2 = await moveCopy('0.2.0');
    // Something creates the new path between the plan and the run.
    const arrive = () => fsp.writeFile(path.join(vault, 'AGENTS.md'), 'Arrived meanwhile.\n', 'utf-8');
    await expect(update(v2, 'keep_mine', false, arrive)).rejects.toMatchObject({ code: 'UPDATE_WRITE_FAILED' });
    expect(await read('AGENTS.md')).toBe('Arrived meanwhile.\n');
    expect(await read(COPY)).toBe('My edit.\n');
  });

  it('a failure later in the write pass removes a new path already written', async () => {
    await install();
    const note = await read(NOTE);
    await write(NOTE, note.replace('## Goals\n\n-', '## Goals\n\n- Ship v6'));
    const v2 = await moveNote('0.2.0', {
      'brain/Guiding Star.md.njk': (src) => src.replace('# North Star', '# Guiding Star'),
      'zz-new.md.njk': () => 'Added in 0.2.0.\n',
    });
    const realWrite = fsp.writeFile;
    vi.spyOn(fsp, 'writeFile').mockImplementation(async (file, data, opts) => {
      if (String(file).endsWith('zz-new.md')) throw new Error('disk full');
      return realWrite(file, data, opts as Parameters<typeof realWrite>[2]);
    });
    await expect(update(v2)).rejects.toThrow(/zz-new\.md/);
    vi.restoreAllMocks();
    expect(await exists('brain/Guiding Star.md')).toBe(false);
    expect(await read(NOTE)).toContain('- Ship v6');
  });

  it('without migrations, a moved file is removed and added as before', async () => {
    await install();
    await write(COPY, 'My edit.\n');
    const { removed } = await update(await shardAt('0.2.0', { moves: { [COPY]: 'AGENTS.md' } }));
    expect(removed).toContain(COPY);
    expect(await read('AGENTS.md')).toContain(COPY_LINE);
  });

  it('a renamed file is not offered as removed', async () => {
    await install();
    await write(COPY, 'My edit.\n');
    const { removed } = await update(await moveCopy('0.2.0'));
    expect(removed).not.toContain(COPY);
  });

  it('a dry run moves nothing and plans the rename', async () => {
    await install();
    await write(COPY, 'My edit.\n');
    const stateBefore = await read('.shardmind/state.json');
    const { plan } = await update(await moveCopy('0.2.0'), 'keep_mine', true);
    expect(plan.actions.find((a) => a.path === 'AGENTS.md')?.renamedFrom).toBe(COPY);
    expect(await read(COPY)).toBe('My edit.\n');
    expect(await exists('AGENTS.md')).toBe(false);
    expect(await read('.shardmind/state.json')).toBe(stateBefore);
  });

  it('a failed update puts the old file back and removes the new one', async () => {
    await install();
    await write(COPY, 'My edit.\n');
    const v2 = await moveCopy('0.2.0');
    const realWrite = fsp.writeFile;
    vi.spyOn(fsp, 'writeFile').mockImplementation(async (file, data, opts) => {
      if (String(file).endsWith('state.json')) throw new Error('disk full');
      return realWrite(file, data, opts as Parameters<typeof realWrite>[2]);
    });
    await expect(update(v2)).rejects.toThrow(/disk full/);
    vi.restoreAllMocks();
    expect(await read(COPY)).toBe('My edit.\n');
    expect(await exists('AGENTS.md')).toBe(false);
  });

  describe('a case-only rename needs no migration (#169)', () => {
    const LOWER = 'claude.md';
    /** The release that renames CLAUDE.md to claude.md, with no `migrations` entry. */
    const caseCopy = (version: string, edits: SourceEdits = {}) =>
      shardAt(version, { moves: { [COPY]: LOWER }, edits });
    /** The vault root's entries as the filesystem spells them: `exists` cannot tell case apart. */
    const rootNames = async () => (await fsp.readdir(vault)).filter((n) => n.toLowerCase() === LOWER);
    /** Whether the test filesystem folds case, probed beside the vault. */
    const foldsCase = async () => {
      await fsp.writeFile(path.join(root, 'Case-Probe'), '');
      return fsp.access(path.join(root, 'case-probe')).then(() => true, () => false);
    };

    it('runs on a case-folding filesystem on macOS and Windows', async () => {
      // The scenarios below matter where names fold; prove CI's macOS and
      // Windows jobs exercise that path rather than the Linux one.
      if (process.platform === 'darwin' || process.platform === 'win32') expect(await foldsCase()).toBe(true);
    });

    it('moves an unchanged file to its new case, keeping its bytes and its state entry', async () => {
      await install();
      const before = await read(COPY);
      const { result } = await update(await caseCopy('0.2.0'));
      expect(await rootNames()).toEqual([LOWER]);
      expect(await read(LOWER)).toBe(before);
      const state = await files();
      expect(state[COPY]).toBeUndefined();
      expect(state[LOWER]?.ownership).toBe('managed');
      expect(result.summary.renamedFiles).toEqual([{ from: COPY, to: LOWER }]);
    });

    it('writes a changed file under its new case and does not delete it', async () => {
      // On a case-folding filesystem, writing claude.md writes into CLAUDE.md:
      // deleting the old path afterwards would delete the new content.
      await install();
      await update(await caseCopy('0.2.0', { [LOWER]: (s) => s.replace(COPY_LINE, 'Changed in 0.2.0.') }));
      expect(await rootNames()).toEqual([LOWER]);
      expect(await read(LOWER)).toContain('Changed in 0.2.0.');
      expect((await files())[LOWER]?.ownership).toBe('managed');
    });

    it("merges the user's edits with the shard's change under the new case", async () => {
      await install();
      const note = await read(NOTE);
      await write(NOTE, note.replace('## Goals\n\n-', '## Goals\n\n- Ship v6'));
      const v2 = await shardAt('0.2.0', {
        moves: { [NOTE_SRC]: 'brain/north star.md.njk' },
        edits: { 'brain/north star.md.njk': (src) => src.replace('# North Star', '# North Star (v2)') },
      });
      const { plan } = await update(v2);
      expect(plan.pendingConflicts).toEqual([]);
      expect((await fsp.readdir(path.join(vault, 'brain'))).filter((n) => n.toLowerCase() === 'north star.md')).toEqual(['north star.md']);
      const merged = await read('brain/north star.md');
      expect(merged).toContain('- Ship v6');
      expect(merged).toContain('# North Star (v2)');
      expect((await files())['brain/north star.md']?.ownership).toBe('modified');
    });

    it('applies when the user already renamed the file to the new case', async (ctx) => {
      if (!(await foldsCase())) ctx.skip(); // On Linux the two names are two files: see the next test.
      await install();
      const before = await read(COPY);
      await fsp.rename(path.join(vault, COPY), path.join(vault, LOWER));
      await update(await caseCopy('0.2.0'));
      expect(await rootNames()).toEqual([LOWER]);
      expect(await read(LOWER)).toBe(before);
      expect(Object.keys(await files())).toContain(LOWER);
    });

    it('falls back to remove-and-add when both names exist as two files', async (ctx) => {
      if (await foldsCase()) ctx.skip(); // Only a case-sensitive filesystem holds both.
      await install();
      await write(LOWER, 'My own lower-case notes.\n');
      const { plan } = await update(await caseCopy('0.2.0'));
      expect(plan.actions.some((a) => a.renamedFrom !== undefined)).toBe(false);
      // The user's file at the new path is a preexisting add-collision, kept as theirs.
      expect(plan.pendingConflicts.map((c) => c.path)).toEqual([LOWER]);
      expect(await read(LOWER)).toBe('My own lower-case notes.\n');
    });

    it('a failure between the two renames restores the old name and leaves no temporary file', async () => {
      await install();
      const before = await read(COPY);
      const v2 = await caseCopy('0.2.0');
      // The last hop into the new name fails: on a case-folding filesystem the
      // file is then at its temporary name, on a case-sensitive one still at
      // the old path.
      const realRename = fsp.rename;
      vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
        if (path.basename(String(to)) === LOWER) throw new Error('rename interrupted');
        return realRename(from, to);
      });
      await expect(update(v2)).rejects.toThrow(/rename interrupted/);
      vi.restoreAllMocks();
      expect(await rootNames()).toEqual([COPY]);
      expect(await read(COPY)).toBe(before);
      expect((await fsp.readdir(vault)).filter((n) => n.includes('shardmind-case'))).toEqual([]);
      expect(Object.keys(await files())).toContain(COPY);
    });
  });
});
