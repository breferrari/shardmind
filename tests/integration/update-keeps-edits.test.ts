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
import { updatePlanResult } from '../../source/core/json-output.js';
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
  async function update(
    shardDir: string,
    resolution: ConflictResolution | Record<string, ConflictResolution> = 'keep_mine',
    dryRun = false,
    adoptPreexisting = false,
  ) {
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
    const conflictResolutions = Object.fromEntries(
      plan.pendingConflicts.map((c) => [c.path, typeof resolution === 'string' ? resolution : (resolution[c.path] ?? 'keep_mine')]),
    );
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
      adoptPreexisting,
    });
    if (dryRun) return { plan, result, hooks: null };
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

  // #50: the user resolved the conflict in their editor.
  describe('edited in the editor', () => {
    const V2 = welcome('Welcome to your vault, {{ user_name }}! (v2)');

    it('writes the edit and records the file modified at the shard render, not the edit (#150)', async () => {
      await install();
      await editFile(HOME, 'Welcome to your vault, Alice.', 'My own welcome line.');
      const shard2 = await shardAt('0.2.0', V2);
      const { result } = await update(shard2, { [HOME]: { kind: 'edited', content: 'Hand-merged by me.\n' } });
      expect(await read(HOME)).toBe('Hand-merged by me.\n');
      const entry = await recorded(HOME);
      expect(entry.ownership).toBe('modified');
      expect(entry.rendered_hash).not.toBe(sha256('Hand-merged by me.\n'));
      expect(result.summary.conflictsEdited).toBe(1);
      expect(result.summary.wroteFiles).toContain(HOME);
    });

    it('keeps the edit through the next update that changes the template, merging instead of replacing', async () => {
      await install();
      await editFile(HOME, 'Welcome to your vault, Alice.', 'My own welcome line.');
      await update(await shardAt('0.2.0', V2), { [HOME]: { kind: 'edited', content: (await read(HOME)) + '\nmy hand-merged line\n' } });
      await update(await shardAt('0.3.0', welcome('Welcome to your vault, {{ user_name }}! (v3)')));
      expect(await read(HOME)).toContain('my hand-merged line');
    });

    it('a dry run writes neither the edit nor state', async () => {
      await install();
      await editFile(HOME, 'Welcome to your vault, Alice.', 'My own welcome line.');
      const before = await read(HOME);
      const stateBefore = await fsp.readFile(path.join(vault, '.shardmind', 'state.json'), 'utf-8');
      await update(await shardAt('0.2.0', V2), { [HOME]: { kind: 'edited', content: 'not written\n' } }, true);
      expect(await read(HOME)).toBe(before);
      expect(await fsp.readFile(path.join(vault, '.shardmind', 'state.json'), 'utf-8')).toBe(stateBefore);
    });
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

  // The sticky label would still route a wrongly recorded auto-merge to the
  // merge, so the two-update case alone cannot see this writer: pin the hash.
  it('an auto-merged file records the new render, not the merged bytes, as its baseline', async () => {
    await install();
    await write(COPY, (await read(COPY)) + '\n- User-added link\n');

    const v2 = await shardAt('0.2.0', { [COPY]: (s) => s.replace('# Minimal Shard', '# Minimal Shard v2') });
    const { plan } = await update(v2);
    expect(actionFor(plan, COPY)).toBe('auto_merge');

    const entry = await recorded(COPY);
    expect(entry.rendered_hash).toBe(sha256(await fsp.readFile(path.join(v2, COPY))));
    expect(entry.ownership).toBe('modified');
  });

  it('a hook\'s write to an engine-owned copy file is recorded, and survives the next update', async () => {
    await install();
    // 0.2.0's post-update hook appends a line to the pristine CLAUDE.md.
    const appendOnce: SourceEdits = {
      ...IDLE_POST_UPDATE,
      '.shardmind/hooks/post-update.ts': () => [
        "import { readFile, appendFile } from 'node:fs/promises';",
        "import { join } from 'node:path';",
        'export default async function (ctx) {',
        `  const p = join(ctx.vaultRoot, '${COPY}');`,
        "  if (!(await readFile(p, 'utf-8')).includes('hook line')) await appendFile(p, 'hook line\\n');",
        '}',
        '',
      ].join('\n'),
    };
    await update(await shardAt('0.2.0', appendOnce));
    const hooked = await fsp.readFile(path.join(vault, COPY));
    expect(hooked.toString('utf-8')).toContain('hook line');
    expect((await recorded(COPY)).rendered_hash).toBe(sha256(hooked));

    // 0.3.0 leaves CLAUDE.md's source alone and runs no hook.
    await update(await shardAt('0.3.0'));
    expect(await read(COPY)).toContain('hook line');
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

  it('a file adopted as merged whose union equals the shard is recorded managed', async () => {
    const pristine = await fsp.readFile(path.join(MINIMAL_SHARD, COPY));
    await adoptEdited({ [COPY]: pristine.toString('utf-8').replace(COPY_LINE, 'My own line.') }, (rel) =>
      rel === COPY ? { kind: 'merged', content: pristine, hash: sha256(pristine) } : 'keep_mine',
    );
    expect((await recorded(COPY)).ownership).toBe('managed');
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
      // `--dry-run --json` prints this plan, so the preview no longer shows an overwrite either.
      expect(updatePlanResult(plan, { dryRun: true }).files.find((f) => f.path === COPY)?.action).toBe('noop');
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

    it('a corrupted copy-origin entry whose path the new shard drops is kept, not deleted', async () => {
      await install();
      await editFile(COPY, COPY_LINE, 'My own line.');
      await corrupt(COPY, 'managed');

      const v2 = await shardAt('0.2.0');
      await fsp.rm(path.join(v2, COPY));
      const { plan } = await update(v2);
      expect(actionFor(plan, COPY)).toBe('keep_as_user');
      expect(await read(COPY)).toContain('My own line.');
    });

    it('a pristine file whose source switches from rendered to copied is overwritten, not merged', async () => {
      await install();
      const v2 = await shardAt('0.2.0');
      await fsp.rm(path.join(v2, HOME_SRC));
      await fsp.writeFile(path.join(v2, HOME), '# Home, now a plain copy\n', 'utf-8');

      const { plan } = await update(v2);
      expect(actionFor(plan, HOME)).toBe('overwrite');
      expect(await read(HOME)).toBe('# Home, now a plain copy\n');
    });

    it('an unreadable cached source never fails the update', async () => {
      await install();
      const cached = path.join(vault, '.shardmind', 'templates', COPY);
      await fsp.rm(cached);
      await fsp.mkdir(cached); // reads fail with EISDIR on every platform

      const v2 = await shardAt('0.2.0');
      await fsp.rm(path.join(v2, COPY));
      const { plan } = await update(v2);
      expect(actionFor(plan, COPY)).toBe('delete');
    });

    // The documented residual (SHARD-LAYOUT §Update semantics): a rendered
    // file's baseline cannot be proven, so a corrupted .njk entry labelled
    // managed is overwritten once more. Pinned so a change here is a
    // decision, not an accident.
    it('a corrupted rendered entry labelled managed is still overwritten (documented residual)', async () => {
      await install();
      await editFile(HOME, 'Welcome to your vault, Alice.', 'My own welcome line.');
      await corrupt(HOME, 'managed');

      const { plan } = await update(await shardAt('0.2.0'));
      expect(actionFor(plan, HOME)).toBe('overwrite');
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

  it('a CRLF-saved edit survives two updates byte for byte', async () => {
    await install();
    const crlf = (await read(COPY)).replace(COPY_LINE, 'My own line.').replace(/\n/g, '\r\n');
    await write(COPY, crlf);

    await update(await shardAt('0.2.0'));
    await update(await shardAt('0.3.0'));
    expect(await read(COPY)).toBe(crlf);
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

  // #153: the summary names the files an update replaced wholesale.
  describe('summary.replacedFiles', () => {
    it('lists a silent overwrite and an accepted conflict, nothing merged, added or restored', async () => {
      await install();
      await editFile(HOME, 'Welcome to your vault, Alice.', 'My own welcome line.'); // → conflict, accept_new
      await write(COPY, (await read(COPY)) + '\n- User-added link\n'); // → auto_merge
      await fsp.rm(path.join(vault, '.claude', 'commands', 'example-command.md')); // → restore_missing

      const v2 = await shardAt('0.2.0', {
        ...welcome('Welcome to your vault, {{ user_name }}! (v2)'),
        [COPY]: (s) => s.replace('# Minimal Shard', '# Minimal Shard v2'),
        '.claude/settings.json.njk': (s) => s.replace('{', '{\n  "v2": true,'), // pristine → overwrite
        'brain/New Note.md': () => '# New\n', // → add
      });
      const { plan, result } = await update(v2, 'accept_new');
      expect(actionFor(plan, '.claude/settings.json')).toBe('overwrite');
      expect(actionFor(plan, COPY)).toBe('auto_merge');

      const replaced = result.summary.replacedFiles;
      expect(replaced).toContain('.claude/settings.json'); // silent overwrite
      expect(replaced).toContain(HOME); // accept_new
      expect(replaced).not.toContain(COPY); // auto_merge
      expect(replaced).not.toContain('.claude/commands/example-command.md'); // restore_missing
      expect(replaced).not.toContain('brain/New Note.md'); // add
      // Every entry is a path the plan overwrote or a conflict it resolved.
      const replacing = new Set(plan.actions.filter((a) => a.kind === 'overwrite' || a.kind === 'conflict').map((a) => a.path));
      for (const p of replaced) expect(replacing.has(p)).toBe(true);
      // counts.overwritten (also in --json) is exactly the silent overwrites;
      // the accepted conflict is a conflict, not part of `silent`.
      const overwrites = plan.actions.filter((a) => a.kind === 'overwrite').length;
      expect(plan.counts.overwritten).toBe(overwrites);
      expect(updatePlanResult(plan, { dryRun: true }).counts.overwritten).toBe(overwrites);
    });

    it('lists an untracked file the user let a newly added shard path replace', async () => {
      await install();
      await write('brain/New Note.md', 'my own untracked note\n');
      const v2 = await shardAt('0.2.0', { 'brain/New Note.md': () => '# New\n' });
      const { plan, result } = await update(v2, 'accept_new');
      expect(plan.pendingConflicts.map((c) => c.path)).toContain('brain/New Note.md');
      expect(result.summary.replacedFiles).toContain('brain/New Note.md');
      expect(await read('brain/New Note.md')).toBe('# New\n');
    });

    it('is populated in a dry run', async () => {
      await install();
      const v2 = await shardAt('0.2.0', { '.claude/settings.json.njk': (s) => s.replace('{', '{\n  "v2": true,') });
      const { result } = await update(v2, 'keep_mine', true);
      expect(result.summary.replacedFiles).toContain('.claude/settings.json');
    });

    it('does not count a kept conflict or a merge left alone', async () => {
      await install();
      await editFile(HOME, 'Welcome to your vault, Alice.', 'My own welcome line.');
      await editFile(COPY, COPY_LINE, 'My own line.');
      const { plan, result } = await update(await shardAt('0.2.0', welcome('Welcome to your vault, {{ user_name }}! (v2)')));
      expect(result.summary.replacedFiles).not.toContain(HOME);
      expect(result.summary.replacedFiles).not.toContain(COPY);
      // COPY's merge is a skip: a #150 rebaseline noop, counted unchanged.
      expect(actionFor(plan, COPY)).toBe('noop');
      const overwritten = plan.actions.filter((a) => a.kind === 'overwrite').map((a) => a.path);
      expect(overwritten).not.toContain(COPY);
      expect(plan.counts.overwritten).toBe(overwritten.length);
    });
  });

  // #63: a binary file never goes through the line-based three-way merge,
  // which decodes bytes as UTF-8 and writes back mangled output.
  describe('binary files', () => {
    const BIN = 'assets/logo.bin';
    const V1 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0xff, 0xfe, 0x01]);
    const V2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0xff, 0xfe, 0x02, 0x03]);
    const MINE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0xc3, 0x28, 0x01]);

    async function shardWithBin(version: string, bytes: Buffer): Promise<string> {
      const dir = await shardAt(version);
      await fsp.mkdir(path.join(dir, 'assets'), { recursive: true });
      await fsp.writeFile(path.join(dir, BIN), bytes);
      return dir;
    }
    const disk = () => fsp.readFile(path.join(vault, BIN));
    const disk2 = (rel: string) => fsp.readFile(path.join(vault, rel));

    it('an edited binary whose source changed is a whole-file conflict, not a merge', async () => {
      await install(await shardWithBin('0.1.0', V1));
      await fsp.writeFile(path.join(vault, BIN), MINE);

      const { plan } = await update(await shardWithBin('0.2.0', V2));
      expect(actionFor(plan, BIN)).toBe('conflict');
      expect(plan.pendingConflicts.find((c) => c.path === BIN)?.result.binary).toEqual({ yours: MINE.length, shard: V2.length });
      // keep_mine (the helper's default): the user's bytes are untouched.
      expect(await disk()).toEqual(MINE);
    });

    it('accept new writes the shard\'s bytes exactly', async () => {
      await install(await shardWithBin('0.1.0', V1));
      await fsp.writeFile(path.join(vault, BIN), MINE);

      await update(await shardWithBin('0.2.0', V2), 'accept_new');
      expect(await disk()).toEqual(V2);
      expect((await recorded(BIN)).ownership).toBe('managed');
    });

    it('an edited binary whose source did not change is left alone', async () => {
      await install(await shardWithBin('0.1.0', V1));
      await fsp.writeFile(path.join(vault, BIN), MINE);

      const { plan } = await update(await shardWithBin('0.2.0', V1));
      expect(actionFor(plan, BIN)).toBe('noop');
      expect(await disk()).toEqual(MINE);
    });

    it('a user who already has the new bytes is relabelled managed, without a prompt', async () => {
      await install(await shardWithBin('0.1.0', V1));
      await fsp.writeFile(path.join(vault, BIN), V2);

      const { plan } = await update(await shardWithBin('0.2.0', V2));
      expect(plan.pendingConflicts.map((c) => c.path)).not.toContain(BIN);
      expect(await disk()).toEqual(V2);
      expect((await recorded(BIN)).ownership).toBe('managed');
    });

    it('a text source that becomes binary is a binary conflict for an edited file', async () => {
      const TEXT = Buffer.from('plain text v1\n');
      await install(await shardWithBin('0.1.0', TEXT));
      await fsp.writeFile(path.join(vault, BIN), Buffer.from('plain text v1\nmy line\n'));

      const { plan } = await update(await shardWithBin('0.2.0', V2));
      expect(plan.pendingConflicts.find((c) => c.path === BIN)?.result.binary).toBeDefined();
    });

    it('a binary user edit over a text source is a binary conflict', async () => {
      const TEXT1 = Buffer.from('plain text v1\n');
      const TEXT2 = Buffer.from('plain text v2\n');
      await install(await shardWithBin('0.1.0', TEXT1));
      await fsp.writeFile(path.join(vault, BIN), MINE);

      const { plan } = await update(await shardWithBin('0.2.0', TEXT2));
      expect(plan.pendingConflicts.find((c) => c.path === BIN)?.result.binary).toEqual({ yours: MINE.length, shard: TEXT2.length });
      expect(await disk()).toEqual(MINE); // keep_mine, the --yes default
    });

    it('with the cached source missing, an edited binary is still a whole-file binary conflict', async () => {
      await install(await shardWithBin('0.1.0', V1));
      await fsp.writeFile(path.join(vault, BIN), MINE);
      await fsp.rm(path.join(vault, '.shardmind', 'templates', BIN));

      const { plan } = await update(await shardWithBin('0.2.0', V2));
      expect(plan.pendingConflicts.find((c) => c.path === BIN)?.result.binary).toEqual({ yours: MINE.length, shard: V2.length });
    });

    it('--dry-run --json lists the binary conflict', async () => {
      await install(await shardWithBin('0.1.0', V1));
      await fsp.writeFile(path.join(vault, BIN), MINE);

      const { plan } = await update(await shardWithBin('0.2.0', V2), 'keep_mine', true);
      const file = updatePlanResult(plan, { dryRun: true }).files.find((f) => f.path === BIN);
      expect(file?.action).toBe('conflict');
      expect(await disk()).toEqual(MINE);
    });

    it('a NUL after the first 8 KB reads as text and takes the line merge', async () => {
      const big = (tail: string) => Buffer.concat([Buffer.alloc(8192, 0x61), Buffer.from('\n'), Buffer.from(tail), Buffer.from([0x00]), Buffer.from('\n')]);
      await install(await shardWithBin('0.1.0', big('v1')));
      await fsp.writeFile(path.join(vault, BIN), Buffer.concat([big('v1'), Buffer.from('my line\n')]));

      const { plan } = await update(await shardWithBin('0.2.0', big('v2')));
      expect(plan.pendingConflicts.find((c) => c.path === BIN)?.result.binary).toBeUndefined();
      expect(actionFor(plan, BIN)).not.toBe('noop');
    });

    it('a non-UTF-8 file with no NUL (a Latin-1 CSV) is not line-merged either', async () => {
      // 0xE9 = 'é' in Latin-1, invalid as UTF-8; no NUL anywhere.
      const latin = (row: string) => Buffer.from(`name;city\n${row};Montr\xe9al\n`, 'latin1');
      await install(await shardWithBin('0.1.0', latin('v1')));
      const mine = Buffer.concat([latin('v1'), Buffer.from('extra;caf\xe9\n', 'latin1')]);
      await fsp.writeFile(path.join(vault, BIN), mine);

      const { plan } = await update(await shardWithBin('0.2.0', latin('v2')));
      expect(actionFor(plan, BIN)).toBe('conflict');
      expect(plan.pendingConflicts.find((c) => c.path === BIN)?.result.binary).toBeDefined();
      expect(await disk()).toEqual(mine);
    });

    it('binary bytes the user put over a rendered file are not line-merged', async () => {
      await install();
      await fsp.writeFile(path.join(vault, HOME), MINE);

      const { plan } = await update(await shardAt('0.2.0', welcome('Welcome, {{ user_name }}! (v2)')), 'accept_new');
      expect(plan.pendingConflicts.find((c) => c.path === HOME)?.result.binary?.yours).toBe(MINE.length);
      // Accept new on a rendered target writes the render, as text.
      expect(await read(HOME)).toContain('Welcome, Alice! (v2)');
    });

    it('binary bytes over a rendered file whose template did not change are left alone', async () => {
      await install();
      await fsp.writeFile(path.join(vault, HOME), MINE);

      // Same Home.md.njk; its render differs per run (install_date), so only a
      // source-to-source comparison sees "unchanged".
      const { plan } = await update(await shardAt('0.2.0'));
      expect(plan.pendingConflicts.map((c) => c.path)).not.toContain(HOME);
      expect(await disk2(HOME)).toEqual(MINE);
      const again = await update(await shardAt('0.3.0'));
      expect(again.plan.pendingConflicts.map((c) => c.path)).not.toContain(HOME);
    });

    it('a non-UTF-8 cached old source alone is enough to skip the line merge', async () => {
      const latinV1 = Buffer.from('v1;caf\xe9\n', 'latin1');
      await install(await shardWithBin('0.1.0', latinV1));
      await fsp.writeFile(path.join(vault, BIN), Buffer.from('v1;cafe\nmine\n')); // valid UTF-8
      const { plan } = await update(await shardWithBin('0.2.0', Buffer.from('v2;cafe\n')));
      expect(plan.pendingConflicts.find((c) => c.path === BIN)?.result.binary).toBeDefined();
    });

    it('--dry-run --json flags a binary conflict as binary', async () => {
      await install(await shardWithBin('0.1.0', V1));
      await fsp.writeFile(path.join(vault, BIN), MINE);
      const { plan } = await update(await shardWithBin('0.2.0', V2), 'keep_mine', true);
      expect(updatePlanResult(plan, { dryRun: true }).files.find((f) => f.path === BIN)?.binary).toBe(true);
    });

    it('an untracked binary identical to a newly added path is adopted without a prompt (#62)', async () => {
      await install();
      await fsp.mkdir(path.join(vault, 'assets'), { recursive: true });
      await fsp.writeFile(path.join(vault, BIN), V2);

      const { plan } = await update(await shardWithBin('0.2.0', V2));
      expect(plan.pendingConflicts.map((c) => c.path)).not.toContain(BIN);
      expect(actionFor(plan, BIN)).toBe('noop');
      expect((await recorded(BIN)).ownership).toBe('managed');
      expect(await disk()).toEqual(V2);
    });

    it('an untracked binary at a path the new version adds gets the binary prompt', async () => {
      await install();
      await fsp.mkdir(path.join(vault, 'assets'), { recursive: true });
      await fsp.writeFile(path.join(vault, BIN), MINE);

      const { plan } = await update(await shardWithBin('0.2.0', V2), 'accept_new');
      const conflict = plan.pendingConflicts.find((c) => c.path === BIN);
      expect(conflict?.result.binary).toEqual({ yours: MINE.length, shard: V2.length });
      expect(conflict?.result.conflicts).toEqual([]);
      expect(await disk()).toEqual(V2);
    });

    it('a pristine binary is still overwritten byte for byte', async () => {
      await install(await shardWithBin('0.1.0', V1));
      const { plan } = await update(await shardWithBin('0.2.0', V2));
      expect(actionFor(plan, BIN)).toBe('overwrite');
      expect(await disk()).toEqual(V2);
    });
  });

  // #62: a prompt whose two answers both leave the same bytes is noise.
  describe('an untracked file at a path the new version adds', () => {
    const NOTE = 'brain/New Note.md';
    const BODY = '# New\n\nShipped in 0.2.0.\n';
    const withNote = (version: string, body = BODY) => shardAt(version, { [NOTE]: () => body });

    it('is adopted as managed without a prompt when it is identical', async () => {
      await install();
      await write(NOTE, BODY);

      const { plan, result } = await update(await withNote('0.2.0'));
      expect(plan.pendingConflicts.map((c) => c.path)).not.toContain(NOTE);
      expect(actionFor(plan, NOTE)).toBe('noop');
      expect(await recorded(NOTE)).toMatchObject({ ownership: 'managed', rendered_hash: sha256(BODY) });
      expect(await read(NOTE)).toBe(BODY);
      // Not newly written by the engine, so not a post-update hook's newFiles.
      expect(result.summary.addedFiles).not.toContain(NOTE);
    });

    it('still prompts when it differs', async () => {
      await install();
      await write(NOTE, '# My own note\n');

      const { plan } = await update(await withNote('0.2.0'));
      expect(plan.pendingConflicts.map((c) => c.path)).toContain(NOTE);
    });

    it('still prompts when only the line endings differ (equality is byte-exact)', async () => {
      await install();
      await write(NOTE, BODY.replace(/\n/g, '\r\n'));

      const { plan } = await update(await withNote('0.2.0'));
      expect(plan.pendingConflicts.map((c) => c.path)).toContain(NOTE);
    });

    it('behaves as a normal managed file on the next update', async () => {
      await install();
      await write(NOTE, BODY);
      await update(await withNote('0.2.0'));

      const { plan } = await update(await withNote('0.3.0', '# New\n\nChanged in 0.3.0.\n'));
      expect(actionFor(plan, NOTE)).toBe('overwrite');
      expect(await read(NOTE)).toContain('Changed in 0.3.0.');
    });

    it('shows as a noop in the --dry-run --json plan', async () => {
      await install();
      await write(NOTE, BODY);
      const { plan } = await update(await withNote('0.2.0'), 'keep_mine', true);
      const json = updatePlanResult(plan, { dryRun: true });
      expect(json.files.find((f) => f.path === NOTE)?.action).toBe('noop');
      // Counted as adopted, not as an unchanged managed file.
      expect(json.counts.adopted).toBe(1);
    });

    // #62 kept these paths out of its silent adoption; #163 refuses the
    // whole update, since any answer would write through or record them.
    it('refuses the update when the path is a symlink, which it would write through (#163)', async (ctx) => {
      await install();
      const outside = path.join(root, 'outside-note.md');
      await fsp.writeFile(outside, BODY, 'utf-8');
      await fsp.mkdir(path.dirname(path.join(vault, NOTE)), { recursive: true });
      try {
        await fsp.symlink(outside, path.join(vault, NOTE), 'file');
      } catch {
        ctx.skip(); // symlinks need privileges on some Windows setups
      }
      await expect(update(await withNote('0.2.0'))).rejects.toMatchObject({ code: 'VAULT_PATH_UNSAFE' });
      expect((await fsp.lstat(path.join(vault, NOTE))).isSymbolicLink()).toBe(true);
      expect(await fsp.readFile(outside, 'utf-8')).toBe(BODY);
    });

    it('refuses the update with --adopt-preexisting too, rather than tracking the link (#163)', async (ctx) => {
      await install();
      const outside = path.join(root, 'outside-note.md');
      await fsp.writeFile(outside, '# Mine\n', 'utf-8');
      await fsp.mkdir(path.dirname(path.join(vault, NOTE)), { recursive: true });
      try {
        await fsp.symlink(outside, path.join(vault, NOTE), 'file');
      } catch {
        ctx.skip();
      }
      await expect(update(await withNote('0.2.0'), 'keep_mine', false, true)).rejects.toMatchObject({
        code: 'VAULT_PATH_UNSAFE',
      });
      expect(await fsp.readFile(outside, 'utf-8')).toBe('# Mine\n');
    });

    it('refuses the update when the name on disk differs only in case (#163)', async (ctx) => {
      await install();
      const lower = NOTE.toLowerCase();
      await fsp.mkdir(path.dirname(path.join(vault, lower)), { recursive: true });
      await fsp.writeFile(path.join(vault, lower), BODY, 'utf-8');
      // Only meaningful where the filesystem folds case (macOS, Windows).
      const folds = await fsp.access(path.join(vault, NOTE)).then(() => true, () => false);
      if (!folds) ctx.skip();
      await expect(update(await withNote('0.2.0'))).rejects.toMatchObject({ code: 'VAULT_PATH_UNSAFE' });
      expect(await recorded(NOTE)).toBeUndefined();
    });

    // #61: keeping your own file there left it untracked, so every later
    // update asked the same question again.
    describe('kept as yours', () => {
      const MINE = '# My own note\n\nWritten before the shard shipped one.\n';
      // An update run with --adopt-preexisting.
      const adopting = (shardDir: string, resolution: ConflictResolution = 'keep_mine', dryRun = false) =>
        update(shardDir, resolution, dryRun, true);

      it('stays untracked by default, comes back next update, and is listed as kept untracked', async () => {
        await install();
        await write(NOTE, MINE);
        const first = await update(await withNote('0.2.0'));
        expect(first.result.summary.keptUntracked).toEqual([NOTE]);
        expect(((await readState(vault)) as ShardState).files[NOTE]).toBeUndefined();

        const again = await update(await withNote('0.3.0'));
        expect(again.plan.pendingConflicts.map((c) => c.path)).toContain(NOTE);
      });

      it('with --adopt-preexisting, is tracked as your modified copy and does not come back', async () => {
        await install();
        await write(NOTE, MINE);
        const first = await adopting(await withNote('0.2.0'));
        expect(first.result.summary.keptUntracked).toEqual([]);
        expect(await recorded(NOTE)).toMatchObject({ ownership: 'modified', rendered_hash: sha256(BODY) });
        expect(await read(NOTE)).toBe(MINE);

        const again = await adopting(await withNote('0.3.0'));
        expect(again.plan.pendingConflicts.map((c) => c.path)).not.toContain(NOTE);
        expect(await read(NOTE)).toBe(MINE);
      });

      it('with --adopt-preexisting, a later shard change merges into your copy', async () => {
        await install();
        const mine = BODY + '\n- my own line\n';
        await write(NOTE, mine);
        await adopting(await withNote('0.2.0'));

        const { plan } = await adopting(await withNote('0.3.0', BODY.replace('# New', '# New v3')));
        expect(actionFor(plan, NOTE)).toBe('auto_merge');
        const after = await read(NOTE);
        expect(after).toContain('# New v3');
        expect(after).toContain('my own line');
      });

      it('with --adopt-preexisting, skip is tracked like keep mine', async () => {
        await install();
        await write(NOTE, MINE);
        await adopting(await withNote('0.2.0'), 'skip');
        expect((await recorded(NOTE)).ownership).toBe('modified');
        expect(await read(NOTE)).toBe(MINE);
      });

      it('with --adopt-preexisting, accept new still writes the shard and records managed', async () => {
        await install();
        await write(NOTE, MINE);
        await adopting(await withNote('0.2.0'), 'accept_new');
        expect(await read(NOTE)).toBe(BODY);
        expect((await recorded(NOTE)).ownership).toBe('managed');
      });

      it('with --adopt-preexisting and nothing in the way, the new file is added as managed', async () => {
        await install();
        const { result } = await adopting(await withNote('0.2.0'));
        expect(result.summary.keptUntracked).toEqual([]);
        expect(await read(NOTE)).toBe(BODY);
        expect((await recorded(NOTE)).ownership).toBe('managed');
      });

      it('with --adopt-preexisting, a kept binary is tracked and later changes skip the line merge (#63)', async () => {
        const BIN = 'assets/new.bin';
        const MINE_BIN = Buffer.from([0x89, 0x50, 0x00, 0xc3, 0x28, 0x01]);
        const shardWith = async (version: string, bytes: Buffer) => {
          const dir = await shardAt(version);
          await fsp.mkdir(path.join(dir, 'assets'), { recursive: true });
          await fsp.writeFile(path.join(dir, BIN), bytes);
          return dir;
        };
        await install();
        await fsp.mkdir(path.join(vault, 'assets'), { recursive: true });
        await fsp.writeFile(path.join(vault, BIN), MINE_BIN);

        await adopting(await shardWith('0.2.0', Buffer.from([0x89, 0x50, 0x00, 0x02])));
        expect((await recorded(BIN)).ownership).toBe('modified');

        const { plan } = await adopting(await shardWith('0.3.0', Buffer.from([0x89, 0x50, 0x00, 0x03])));
        expect(plan.pendingConflicts.find((c) => c.path === BIN)?.result.binary).toBeDefined();
        expect(await fsp.readFile(path.join(vault, BIN))).toEqual(MINE_BIN);
      });

      // #165: one collision tracked, another left untracked, in the same run.
      describe('Keep mine and track it, for one file', () => {
        const OTHER = 'brain/Other Note.md';
        const OTHER_BODY = '# Other\n\nAlso shipped in 0.2.0.\n';
        const withBoth = (version: string, body = BODY) =>
          shardAt(version, { [NOTE]: () => body, [OTHER]: () => OTHER_BODY });

        it('tracks that file as your modified copy at the shard hash, and leaves the other untracked', async () => {
          await install();
          await write(NOTE, MINE);
          await write(OTHER, MINE);
          const { result } = await update(await withBoth('0.2.0'), { [NOTE]: 'keep_and_track', [OTHER]: 'keep_mine' });
          // The shard's hash, never yours (#150): yours would read as pristine.
          expect(await recorded(NOTE)).toMatchObject({ ownership: 'modified', rendered_hash: sha256(BODY) });
          expect(await recorded(OTHER)).toBeUndefined();
          expect(result.summary.keptUntracked).toEqual([OTHER]);
          expect(result.summary.conflictsKeptMine).toBe(2);
          expect(await read(NOTE)).toBe(MINE);
          expect(await read(OTHER)).toBe(MINE);
        });

        it('merges your bytes on the next update instead of asking again or replacing them', async () => {
          await install();
          const mine = BODY + '\n- my own line\n';
          await write(NOTE, mine);
          await write(OTHER, MINE);
          await update(await withBoth('0.2.0'), { [NOTE]: 'keep_and_track', [OTHER]: 'keep_mine' });

          const { plan } = await update(await withBoth('0.3.0', BODY.replace('# New', '# New v3')));
          expect(plan.pendingConflicts.map((c) => c.path)).toEqual([OTHER]);
          expect(actionFor(plan, NOTE)).toBe('auto_merge');
          const after = await read(NOTE);
          expect(after).toContain('# New v3');
          expect(after).toContain('my own line');
        });

        it('keeps a file already tracked, like keep mine, when the resolution reaches one', async () => {
          await install();
          await write(NOTE, MINE);
          await update(await withNote('0.2.0'), 'keep_and_track');
          await write(NOTE, MINE + '\nmore of mine\n');
          await update(await withNote('0.3.0', '# Rewritten by the shard\n'), 'keep_and_track');
          expect(await read(NOTE)).toBe(MINE + '\nmore of mine\n');
          expect(await recorded(NOTE)).toMatchObject({ ownership: 'modified', rendered_hash: sha256('# Rewritten by the shard\n') });
        });

        it('a dry run writes no state', async () => {
          await install();
          await write(NOTE, MINE);
          const before = await fsp.readFile(path.join(vault, '.shardmind', 'state.json'), 'utf-8');
          await update(await withNote('0.2.0'), 'keep_and_track', true);
          expect(await fsp.readFile(path.join(vault, '.shardmind', 'state.json'), 'utf-8')).toBe(before);
        });
      });

      it('a dry run with --adopt-preexisting writes no state', async () => {
        await install();
        await write(NOTE, MINE);
        const before = await fsp.readFile(path.join(vault, '.shardmind', 'state.json'), 'utf-8');
        await adopting(await withNote('0.2.0'), 'keep_mine', true);
        expect(await fsp.readFile(path.join(vault, '.shardmind', 'state.json'), 'utf-8')).toBe(before);
      });
    });
  });

  it('a rolled-back update leaves the template cache exactly as it was, with no template from the new version', async () => {
    await install();
    const cacheDir = path.join(vault, '.shardmind', 'templates');
    const tree = async (dir: string): Promise<Record<string, string>> => {
      const out: Record<string, string> = {};
      for (const rel of (await fsp.readdir(dir, { recursive: true })) as string[]) {
        const abs = path.join(dir, rel);
        if ((await fsp.stat(abs)).isFile()) out[rel.split(path.sep).join('/')] = sha256(await fsp.readFile(abs));
      }
      return out;
    };
    const before = await tree(cacheDir);
    // 0.2.0 adds a template the cache never had.
    const shard2 = await shardAt('0.2.0', { 'brain/Added In 0.2.md.njk': () => '# Added\n' });
    // Fail the update after the template cache is rewritten: the values
    // file is written next, and a read-only one refuses the write.
    const valuesPath = path.join(vault, 'shard-values.yaml');
    await fsp.chmod(valuesPath, 0o444);
    try {
      await expect(update(shard2)).rejects.toThrow();
    } finally {
      await fsp.chmod(valuesPath, 0o644);
    }
    expect(await tree(cacheDir)).toEqual(before);
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
