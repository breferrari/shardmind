/**
 * #150: an update must never replace a file the user changed.
 *
 * Most cases run TWO updates, because the defect only shows on the second:
 * the first records the user's content as the file's baseline, and the
 * second reads "on-disk hash equals recorded hash" as "engine-owned,
 * unmodified" and overwrites it. Each writer of `state.files` that could
 * record the user's bytes gets a case.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { parseManifest } from '../../source/core/manifest.js';
import { parseSchema, buildValuesValidator } from '../../source/core/schema.js';
import { readState } from '../../source/core/state.js';
import { runHooks } from '../../source/core/hook-orchestrator.js';
import { detectDrift } from '../../source/core/drift.js';
import { planUpdate, mergeModuleSelections } from '../../source/core/update-planner.js';
import type { ConflictResolution } from '../../source/core/update-planner.js';
import { runUpdate } from '../../source/core/update-executor.js';
import { defaultModuleSelections, resolveComputedDefaults } from '../../source/core/install-planner.js';
import { runInstall } from '../../source/core/install-executor.js';
import { classifyAdoption } from '../../source/core/adopt-planner.js';
import { runAdopt, type AdoptResolutions } from '../../source/core/adopt-executor.js';
import { buildRenderContext } from '../../source/core/renderer.js';
import { sha256 } from '../../source/core/fs-utils.js';
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

const BASE_VALUES = {
  user_name: 'Alice',
  org_name: 'Acme Labs',
  vault_purpose: 'engineering' as const,
  qmd_enabled: true,
};

/** Rendered: `Home.md.njk` renders `{{ install_date }}`, so its bytes change every run. */
const HOME = 'Home.md';
const HOME_SRC = 'Home.md.njk';
const WELCOME = 'Welcome to your vault, {{ user_name }}.';
/** Copy-origin: `CLAUDE.md` is copied verbatim. */
const COPY = 'CLAUDE.md';
const COPY_LINE = 'Static agent-config file for the minimal-shard fixture.';

type SourceEdits = Record<string, (source: string) => string>;

/** A post-update hook that writes nothing: only the engine's post-hook re-hash acts. */
const IDLE_POST_UPDATE: SourceEdits = {
  '.shardmind/shard.yaml': (s) => s.replace(/^hooks:\n(?: {2}.+\n)+/m, 'hooks:\n  post-update: .shardmind/hooks/post-update.ts\n'),
  '.shardmind/hooks/post-update.ts': () => 'export default async function () {}\n',
};

describe('update keeps the user\'s edits across updates (#150)', () => {
  let root: string;
  let vault: string;

  beforeEach(async () => {
    root = path.join(os.tmpdir(), `shardmind-150-${crypto.randomUUID()}`);
    vault = path.join(root, 'vault');
    await fsp.mkdir(vault, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  async function install(shardDir = MINIMAL_SHARD): Promise<void> {
    const manifest = await parseManifest(path.join(shardDir, '.shardmind', 'shard.yaml'));
    const schema = await parseSchema(path.join(shardDir, '.shardmind', 'shard-schema.yaml'));
    const values = buildValuesValidator(schema).parse(
      resolveComputedDefaults(schema, BASE_VALUES),
    ) as Record<string, unknown>;
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

  /** A copy of the minimal shard at `version`, with each source file in `edits` rewritten. */
  async function shardAt(version: string, edits: SourceEdits = {}): Promise<string> {
    const dir = path.join(root, `shard-${version}`);
    await fsp.cp(MINIMAL_SHARD, dir, { recursive: true });
    const manifestPath = path.join(dir, '.shardmind', 'shard.yaml');
    const manifest = await fsp.readFile(manifestPath, 'utf-8');
    await fsp.writeFile(manifestPath, manifest.replace(/^version: .+$/m, `version: ${version}`), 'utf-8');
    for (const [rel, edit] of Object.entries(edits)) {
      const p = path.join(dir, rel);
      const current = await fsp.readFile(p, 'utf-8').catch(() => '');
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await fsp.writeFile(p, edit(current), 'utf-8');
    }
    return dir;
  }

  const welcome = (line: string): SourceEdits => ({ [HOME_SRC]: (s) => s.replace(WELCOME, line) });

  /**
   * A clone the user edited before adopting: install, drop the engine
   * metadata, apply `edits`, then adopt with `resolve` choosing per path.
   */
  async function adoptEdited(
    edits: Record<string, string>,
    resolve: (rel: string, userBytes: Buffer) => AdoptResolutions[string],
  ): Promise<void> {
    await install();
    await fsp.rm(path.join(vault, '.shardmind'), { recursive: true, force: true });
    await fsp.rm(path.join(vault, 'shard-values.yaml'), { force: true });
    for (const [rel, content] of Object.entries(edits)) await write(rel, content);

    const manifest = await parseManifest(path.join(MINIMAL_SHARD, '.shardmind', 'shard.yaml'));
    const schema = await parseSchema(path.join(MINIMAL_SHARD, '.shardmind', 'shard-schema.yaml'));
    const selections = defaultModuleSelections(schema);
    const values = buildValuesValidator(schema).parse(
      resolveComputedDefaults(schema, BASE_VALUES),
    ) as Record<string, unknown>;
    const plan = await classifyAdoption({ vaultRoot: vault, schema, manifest, tempDir: MINIMAL_SHARD, values, selections });
    const resolutions: AdoptResolutions = {};
    for (const c of plan.differs) {
      resolutions[c.path] = resolve(c.path, await fsp.readFile(path.join(vault, c.path)));
    }
    await runAdopt({
      vaultRoot: vault,
      manifest,
      schema,
      tempDir: MINIMAL_SHARD,
      resolved: { ...RESOLVED, version: manifest.version },
      tarballSha256: 'sha-0.1.0',
      values,
      selections,
      plan,
      resolutions,
    });
  }

  /** One full update, drift to state write, resolving every conflict as `resolution`. */
  async function update(shardDir: string, resolution: ConflictResolution = 'keep_mine') {
    const state = (await readState(vault)) as ShardState;
    const values = parseYaml(await fsp.readFile(path.join(vault, 'shard-values.yaml'), 'utf-8')) as Record<string, unknown>;
    const manifest = await parseManifest(path.join(shardDir, '.shardmind', 'shard.yaml'));
    const schema = await parseSchema(path.join(shardDir, '.shardmind', 'shard-schema.yaml'));
    const selections = mergeModuleSelections(state.modules, schema, {});
    const drift = await detectDrift(vault, state);
    const plan = await planUpdate({
      vault: { root: vault, state, drift },
      values: { old: values, new: values },
      newShard: {
        schema,
        selections,
        tempDir: shardDir,
        renderContext: buildRenderContext(manifest, values, selections),
      },
      removedFileDecisions: {},
    });
    const conflictResolutions = Object.fromEntries(plan.pendingConflicts.map((c) => [c.path, resolution]));
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
    });
    // The hook phase, as the update machine runs it after the state write.
    const hooks = await runHooks(
      {
        command: 'update',
        tempDir: shardDir,
        manifest,
        schema,
        vaultRoot: vault,
        state: (await readState(vault)) as ShardState,
        values,
        modules: selections,
        previousVersion: state.version,
        newFiles: result.summary.addedFiles,
        removedFiles: result.summary.deletedFiles,
        dryRun: false,
      },
      { setPhase: () => {}, onStdout: () => {}, onStderr: () => {} },
    );
    return { plan, result, hooks };
  }

  const read = (rel: string) => fsp.readFile(path.join(vault, rel), 'utf-8');
  const write = (rel: string, content: string) => fsp.writeFile(path.join(vault, rel), content, 'utf-8');
  const recorded = async (rel: string) => ((await readState(vault)) as ShardState).files[rel]!;
  const actionFor = (plan: { actions: Array<{ path: string; kind: string }> }, rel: string) =>
    plan.actions.find((a) => a.path === rel)?.kind;

  async function editFile(rel: string, from: string, to: string): Promise<void> {
    const current = await read(rel);
    expect(current).toContain(from);
    await write(rel, current.replace(from, to));
  }

  it('a file kept with keep_mine survives the next update that does not change its template', async () => {
    await install();
    await editFile(HOME, 'Welcome to your vault, Alice.', 'My own welcome line.');

    // 0.2.0 changes the same line: a conflict, resolved keep_mine.
    const first = await update(await shardAt('0.2.0', welcome('Welcome to your vault, {{ user_name }}! (v2)')));
    expect(first.plan.pendingConflicts.map((c) => c.path)).toContain(HOME);
    expect(await read(HOME)).toContain('My own welcome line.');

    // 0.3.0 leaves Home.md.njk exactly as 0.2.0 had it.
    await update(await shardAt('0.3.0', welcome('Welcome to your vault, {{ user_name }}! (v2)')));
    expect(await read(HOME)).toContain('My own welcome line.');
  });

  it('a file kept with skip survives the next update that does not change its template', async () => {
    await install();
    await editFile(HOME, 'Welcome to your vault, Alice.', 'My own welcome line.');

    const first = await update(await shardAt('0.2.0', welcome('Welcome to your vault, {{ user_name }}! (v2)')), 'skip');
    expect(first.plan.pendingConflicts.map((c) => c.path)).toContain(HOME);

    await update(await shardAt('0.3.0', welcome('Welcome to your vault, {{ user_name }}! (v2)')), 'skip');
    expect(await read(HOME)).toContain('My own welcome line.');
  });

  it('a kept file records the shard\'s render, not the user\'s bytes, as its baseline', async () => {
    await install();
    await editFile(HOME, 'Welcome to your vault, Alice.', 'My own welcome line.');
    await update(await shardAt('0.2.0', welcome('Welcome to your vault, {{ user_name }}! (v2)')));

    const entry = await recorded(HOME);
    expect(entry.rendered_hash).not.toBe(sha256(await fsp.readFile(path.join(vault, HOME))));
    expect(entry.ownership).toBe('modified');
  });

  it('an edit survives the post-hook re-hash of an update that does not touch the file', async () => {
    await install();
    await editFile(HOME, 'Welcome to your vault, Alice.', 'My own welcome line.');
    await editFile(COPY, COPY_LINE, 'My own line.');

    // 0.2.0 changes neither file, and runs a post-update hook.
    const first = await update(await shardAt('0.2.0', IDLE_POST_UPDATE));
    expect(first.hooks.outcomes.map((o) => o.slot)).toContain('post-update');

    await update(await shardAt('0.3.0', IDLE_POST_UPDATE));
    expect(await read(HOME)).toContain('My own welcome line.');
    expect(await read(COPY)).toContain('My own line.');
  }, 30_000);

  it('a line the user added survives a second update after an auto-merge', async () => {
    await install();
    await write(HOME, (await read(HOME)) + '\n- User-added link\n');

    // 0.2.0 changes the welcome line: no overlap, so an auto-merge.
    const first = await update(await shardAt('0.2.0', welcome('Welcome to your vault, {{ user_name }}! (v2)')));
    expect(actionFor(first.plan, HOME)).toBe('auto_merge');
    expect(await read(HOME)).toContain('User-added link');

    // 0.3.0 changes the welcome line again.
    await update(await shardAt('0.3.0', welcome('Welcome to your vault, {{ user_name }}! (v3)')));
    const after = await read(HOME);
    expect(after).toContain('Welcome to your vault, Alice! (v3)');
    expect(after).toContain('User-added link');
  });

  it('a modified file the merge leaves alone keeps a modified label and the source\'s hash', async () => {
    await install();
    const pristineHash = (await recorded(COPY)).rendered_hash;
    await editFile(COPY, COPY_LINE, 'My own line.');

    // 0.2.0 changes a different file only: COPY's merge is a skip.
    const { plan } = await update(await shardAt('0.2.0', welcome('Welcome, {{ user_name }}! (v2)')));
    expect(actionFor(plan, COPY)).toBe('noop');

    const after = await recorded(COPY);
    expect(after.ownership).toBe('modified');
    expect(after.rendered_hash).toBe(pristineHash);
    expect(await read(COPY)).toContain('My own line.');
  });

  it('a file adopted with keep_mine survives the first update', async () => {
    const pristine = await fsp.readFile(path.join(MINIMAL_SHARD, COPY), 'utf-8');
    await adoptEdited({ [COPY]: pristine.replace(COPY_LINE, 'My own line.') }, () => 'keep_mine');
    expect((await recorded(COPY)).rendered_hash).toBe(sha256(pristine));

    await update(await shardAt('0.2.0'));
    expect(await read(COPY)).toContain('My own line.');
  });

  it('a file adopted as merged keeps its merged lines through the first template change', async () => {
    const pristine = await fsp.readFile(path.join(MINIMAL_SHARD, COPY), 'utf-8');
    const mine = pristine.replace(COPY_LINE, 'My own line.');
    await adoptEdited({ [COPY]: mine }, (rel, userBytes) => {
      if (rel !== COPY) return 'keep_mine';
      const content = Buffer.concat([userBytes, Buffer.from('\n- merged-in line\n')]);
      return { kind: 'merged', content, hash: sha256(content) };
    });

    // 0.2.0 changes the title line, which neither the user nor the merge touched.
    await update(await shardAt('0.2.0', { [COPY]: (s) => s.replace('# Minimal Shard', '# Minimal Shard v2') }));
    const after = await read(COPY);
    expect(after).toContain('# Minimal Shard v2');
    expect(after).toContain('My own line.');
    expect(after).toContain('merged-in line');
  });

  // Vaults hit before the fix hold state written under the old rule: the
  // user's hash recorded as the baseline. Fixing the writers does not
  // repair those entries, so the update must recognise them.
  describe('state recorded before the fix', () => {
    /** Rewrite COPY's state entry as a pre-fix writer left it: the user's hash under `ownership`. */
    async function corrupt(rel: string, ownership: 'managed' | 'modified'): Promise<void> {
      const statePath = path.join(vault, '.shardmind', 'state.json');
      const state = JSON.parse(await fsp.readFile(statePath, 'utf-8')) as ShardState;
      state.files[rel] = {
        ...state.files[rel]!,
        rendered_hash: sha256(await fsp.readFile(path.join(vault, rel))),
        ownership,
      };
      await fsp.writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');
    }

    it('an entry labelled modified with the user\'s hash is merged, not overwritten', async () => {
      await install();
      await editFile(COPY, COPY_LINE, 'My own line.');
      await corrupt(COPY, 'modified'); // what keep_mine / auto_merge / adopt wrote

      const { plan } = await update(await shardAt('0.2.0'));
      expect(actionFor(plan, COPY)).toBe('noop');
      expect(await read(COPY)).toContain('My own line.');
    });

    it('a copy-origin entry labelled managed with the user\'s hash is merged, not overwritten', async () => {
      await install();
      await editFile(COPY, COPY_LINE, 'My own line.');
      await corrupt(COPY, 'managed'); // what the post-hook re-hash wrote

      const { plan } = await update(await shardAt('0.2.0'));
      expect(actionFor(plan, COPY)).toBe('noop');
      expect(await read(COPY)).toContain('My own line.');
    });

    it('a corrupted entry whose source changed three-way merges instead of overwriting', async () => {
      await install();
      await editFile(COPY, COPY_LINE, 'My own line.');
      await corrupt(COPY, 'managed');

      const { plan } = await update(await shardAt('0.2.0', { [COPY]: (s) => s.replace('# Minimal Shard', '# Minimal Shard v2') }));
      expect(actionFor(plan, COPY)).toBe('auto_merge');
      const after = await read(COPY);
      expect(after).toContain('# Minimal Shard v2');
      expect(after).toContain('My own line.');
    });

    it('one update repairs the entry, so status then reports the file as modified', async () => {
      await install();
      await editFile(COPY, COPY_LINE, 'My own line.');
      await corrupt(COPY, 'managed');
      // Before any update, status cannot tell: disk equals the recorded hash.
      expect((await detectDrift(vault, (await readState(vault)) as ShardState)).managed.map((e) => e.path)).toContain(COPY);

      await update(await shardAt('0.2.0'));
      const drift = await detectDrift(vault, (await readState(vault)) as ShardState);
      expect(drift.modified.map((e) => e.path)).toContain(COPY);
      expect((await recorded(COPY)).rendered_hash).toBe(sha256(await fsp.readFile(path.join(MINIMAL_SHARD, COPY))));
    });

    it('a corrupted binary copy-origin entry is caught by its bytes', async () => {
      const BIN = 'assets/logo.bin';
      const pristineBytes = Buffer.from([0x89, 0x50, 0xff, 0xfe, 0x00, 0x0a, 0xc3]);
      const v1 = await shardAt('0.1.0');
      await fsp.mkdir(path.join(v1, 'assets'), { recursive: true });
      await fsp.writeFile(path.join(v1, BIN), pristineBytes);
      await install(v1);
      await fsp.writeFile(path.join(vault, BIN), Buffer.from([0x89, 0x50, 0xff, 0x00]));
      await corrupt(BIN, 'managed');

      const v2 = await shardAt('0.2.0');
      await fsp.mkdir(path.join(v2, 'assets'), { recursive: true });
      await fsp.writeFile(path.join(v2, BIN), pristineBytes);
      const { plan } = await update(v2);
      expect(actionFor(plan, BIN)).not.toBe('overwrite');
      expect(await fsp.readFile(path.join(vault, BIN))).toEqual(Buffer.from([0x89, 0x50, 0xff, 0x00]));
    });

    it('a pristine file is not rerouted: its recorded hash equals the cached source', async () => {
      await install();
      const { plan } = await update(await shardAt('0.2.0', { [COPY]: (s) => s.replace(COPY_LINE, 'New upstream line.') }));
      expect(actionFor(plan, COPY)).toBe('overwrite');
    });

    it('without a cached source, a modified-labelled entry still goes to a conflict, never an overwrite', async () => {
      await install();
      await editFile(COPY, COPY_LINE, 'My own line.');
      await corrupt(COPY, 'modified');
      await fsp.rm(path.join(vault, '.shardmind', 'templates', COPY));

      const { plan } = await update(await shardAt('0.2.0'));
      expect(actionFor(plan, COPY)).toBe('conflict');
      expect(await read(COPY)).toContain('My own line.');
    });
  });

  it('a user who reverts their edit is relabelled managed by the next update', async () => {
    await install();
    const pristine = await read(COPY);
    await editFile(COPY, COPY_LINE, 'My own line.');
    await update(await shardAt('0.2.0'));
    expect((await recorded(COPY)).ownership).toBe('modified');

    await write(COPY, pristine);
    await update(await shardAt('0.3.0'));
    expect((await recorded(COPY)).ownership).toBe('managed');
  });

  it('a pristine copy-origin file is still overwritten silently when its source changes', async () => {
    await install();
    const { plan } = await update(await shardAt('0.2.0', { [COPY]: (s) => s.replace(COPY_LINE, 'New upstream line.') }));
    expect(actionFor(plan, COPY)).toBe('overwrite');
    expect(plan.pendingConflicts).toEqual([]);
    expect(await read(COPY)).toContain('New upstream line.');
  });

  it('a pristine rendered file is still overwritten silently when its template changes', async () => {
    await install();
    const { plan } = await update(await shardAt('0.2.0', welcome('Welcome, {{ user_name }}! (v2)')));
    expect(actionFor(plan, HOME)).toBe('overwrite');
    expect(await read(HOME)).toContain('Welcome, Alice! (v2)');
  });
});
