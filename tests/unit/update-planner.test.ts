/**
 * Unit tests for the update planner.
 *
 * We build throw-away vaults + shard temp dirs on the fly so the planner
 * runs against realistic inputs (drift + rendered templates) without
 * pulling in the full install pipeline. The planner is pure data in / out;
 * every assertion is on the `UpdatePlan` shape.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  computeSchemaAdditions,
  mergeModuleSelections,
  removedFilesNeedingDecision,
  planUpdate,
} from '../../source/core/update-planner.js';
import type {
  ShardSchema,
  ShardState,
  ModuleSelections,
  RenderContext,
  DriftReport,
} from '../../source/runtime/types.js';
import { sha256 } from '../../source/core/fs-utils.js';
import {
  SHARDMIND_DIR,
  CACHED_TEMPLATES,
  SHARD_TEMPLATES_DIR,
} from '../../source/runtime/vault-paths.js';
import { makeShardState, makeFileState } from '../helpers/index.js';

const NOW = new Date('2026-04-20T00:00:00Z');

function baseSchema(overrides: Partial<ShardSchema> = {}): ShardSchema {
  return {
    schema_version: 1,
    values: {
      user_name: {
        type: 'string',
        required: true,
        message: 'Your name',
        group: 'setup',
      },
    },
    groups: [{ id: 'setup', label: 'Setup' }],
    modules: {
      brain: { label: 'Brain', paths: ['brain/'], removable: false },
    },
    signals: [],
    frontmatter: {},
    migrations: [],
    ...overrides,
  };
}

function renderCtx(
  values: Record<string, unknown>,
  included: string[] = ['brain'],
): RenderContext {
  return {
    values,
    included_modules: included,
    shard: { name: 'test', version: '1.0.0' },
    install_date: NOW.toISOString(),
    year: '2026',
  };
}

describe('computeSchemaAdditions', () => {
  it('reports new required keys with no default', () => {
    const schema = baseSchema({
      values: {
        user_name: { type: 'string', required: true, message: '', group: 'setup' },
        org_name: { type: 'string', required: true, message: '', group: 'setup' },
      },
    });
    const additions = computeSchemaAdditions(schema, { brain: 'included' }, { user_name: 'b' });
    expect(additions.newRequiredKeys).toEqual(['org_name']);
  });

  it('ignores new required keys that have a default', () => {
    const schema = baseSchema({
      values: {
        user_name: { type: 'string', required: true, message: '', group: 'setup' },
        org_name: {
          type: 'string',
          required: true,
          message: '',
          group: 'setup',
          default: 'Independent',
        },
      },
    });
    const additions = computeSchemaAdditions(schema, { brain: 'included' }, { user_name: 'b' });
    expect(additions.newRequiredKeys).toEqual([]);
  });

  it('lists removable modules not in current selections as optional offers', () => {
    const schema = baseSchema({
      modules: {
        brain: { label: 'Brain', paths: ['brain/'], removable: false },
        extras: { label: 'Extras', paths: ['extras/'], removable: true },
        work: { label: 'Work', paths: ['work/'], removable: true },
      },
    });
    const additions = computeSchemaAdditions(schema, { brain: 'included', extras: 'included' }, {});
    expect(additions.newOptionalModules.map((m) => m.id)).toEqual(['work']);
  });

  it('lists dropped modules', () => {
    const schema = baseSchema({ modules: { brain: { label: 'Brain', paths: ['brain/'], removable: false } } });
    const additions = computeSchemaAdditions(schema, { brain: 'included', legacy: 'included' }, {});
    expect(additions.dropped).toEqual(['legacy']);
  });
});

describe('mergeModuleSelections', () => {
  it('forces non-removable modules to included and carries over prior choices', () => {
    const schema = baseSchema({
      modules: {
        brain: { label: 'Brain', paths: ['brain/'], removable: false },
        extras: { label: 'Extras', paths: ['extras/'], removable: true },
        work: { label: 'Work', paths: ['work/'], removable: true },
      },
    });
    const merged = mergeModuleSelections(
      { brain: 'included', extras: 'excluded' },
      schema,
      { work: 'included' },
    );
    expect(merged).toEqual({ brain: 'included', extras: 'excluded', work: 'included' });
  });

  it('drops modules that are no longer in the new schema', () => {
    const schema = baseSchema();
    const merged = mergeModuleSelections(
      { brain: 'included', legacy: 'included' },
      schema,
      {},
    );
    expect(merged).toEqual({ brain: 'included' });
  });
});

describe('removedFilesNeedingDecision', () => {
  it('returns modified files that are no longer in the new shard', () => {
    const drift: DriftReport = {
      managed: [],
      modified: [
        { path: 'CLAUDE.md', template: 't/c.njk', renderedHash: 'a', actualHash: 'b', ownership: 'modified' },
        { path: 'brain/Index.md', template: 't/bi.njk', renderedHash: 'c', actualHash: 'd', ownership: 'modified' },
      ],
      volatile: [],
      missing: [],
      orphaned: [],
    };
    const newPaths = new Set(['CLAUDE.md']);
    expect(removedFilesNeedingDecision(drift, newPaths)).toEqual(['brain/Index.md']);
  });
});

// ---------------------------------------------------------------------------
// Integration-style planUpdate tests backed by a real temp vault.
// ---------------------------------------------------------------------------

describe('planUpdate', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'shardmind-plan-'));
  });

  afterEach(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  async function buildShardTempDir(
    files: Record<string, string>,
  ): Promise<string> {
    const shardDir = path.join(tempRoot, 'shard-' + Math.random().toString(36).slice(2, 8));
    const templatesDir = path.join(shardDir, SHARD_TEMPLATES_DIR);
    await fsp.mkdir(templatesDir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(templatesDir, rel);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, content, 'utf-8');
    }
    return shardDir;
  }

  async function buildVault(opts: {
    vaultFiles: Record<string, string>;
    cachedTemplates: Record<string, string>;
  }): Promise<string> {
    const vault = path.join(tempRoot, 'vault-' + Math.random().toString(36).slice(2, 8));
    await fsp.mkdir(vault, { recursive: true });
    for (const [rel, content] of Object.entries(opts.vaultFiles)) {
      const abs = path.join(vault, rel);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, content, 'utf-8');
    }
    const cacheDir = path.join(vault, CACHED_TEMPLATES);
    await fsp.mkdir(cacheDir, { recursive: true });
    for (const [rel, content] of Object.entries(opts.cachedTemplates)) {
      const abs = path.join(cacheDir, rel);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, content, 'utf-8');
    }
    return vault;
  }

  it('overwrites a managed file whose template has changed', async () => {
    const schema = baseSchema({
      modules: { brain: { label: 'Brain', paths: ['brain/'], removable: false } },
    });
    const selections: ModuleSelections = { brain: 'included' };

    const oldTemplate = 'Hello {{ user_name }}, v1.\n';
    const newTemplate = 'Hello {{ user_name }}, v2!\n';
    const values = { user_name: 'brenno' };

    const oldRendered = 'Hello brenno, v1.\n';
    const newRendered = 'Hello brenno, v2!\n';

    const vault = await buildVault({
      vaultFiles: { 'brain/Index.md': oldRendered },
      cachedTemplates: { 'brain/Index.md.njk': oldTemplate },
    });
    const shardDir = await buildShardTempDir({ 'brain/Index.md.njk': newTemplate });

    const state: ShardState = makeShardState({
      version: '1.0.0',
      modules: selections,
      files: {
        'brain/Index.md': makeFileState({
          template: `${SHARD_TEMPLATES_DIR}/brain/Index.md.njk`,
          rendered_hash: sha256(oldRendered),
          ownership: 'managed',
        }),
      },
    });

    const drift: DriftReport = {
      managed: [
        {
          path: 'brain/Index.md',
          template: `${SHARD_TEMPLATES_DIR}/brain/Index.md.njk`,
          renderedHash: sha256(oldRendered),
          actualHash: sha256(oldRendered),
          ownership: 'managed',
        },
      ],
      modified: [],
      volatile: [],
      missing: [],
      orphaned: [],
    };

    const plan = await planUpdate({
      vault: { root: vault, state, drift },
      values: { old: values, new: values },
      newShard: {
        schema,
        selections,
        tempDir: shardDir,
        renderContext: renderCtx(values),
      },
      removedFileDecisions: {},
    });

    expect(plan.actions.map((a) => a.kind)).toEqual(['overwrite']);
    const action = plan.actions[0]!;
    expect(action.kind).toBe('overwrite');
    if (action.kind !== 'overwrite') throw new Error('narrowing');
    expect(action.path).toBe('brain/Index.md');
    expect(action.content).toBe(newRendered);
    expect(plan.counts.silent).toBe(1);
    expect(plan.pendingConflicts).toEqual([]);
  });

  it('no-ops on a managed file that is identical to the new render', async () => {
    const schema = baseSchema();
    const selections: ModuleSelections = { brain: 'included' };
    const template = 'Hello {{ user_name }}.\n';
    const values = { user_name: 'brenno' };
    const rendered = 'Hello brenno.\n';

    const vault = await buildVault({
      vaultFiles: { 'brain/Index.md': rendered },
      cachedTemplates: { 'brain/Index.md.njk': template },
    });
    const shardDir = await buildShardTempDir({ 'brain/Index.md.njk': template });

    const drift: DriftReport = {
      managed: [
        {
          path: 'brain/Index.md',
          template: `${SHARD_TEMPLATES_DIR}/brain/Index.md.njk`,
          renderedHash: sha256(rendered),
          actualHash: sha256(rendered),
          ownership: 'managed',
        },
      ],
      modified: [],
      volatile: [],
      missing: [],
      orphaned: [],
    };

    const plan = await planUpdate({
      vault: { root: vault, state: makeShardState({
        version: '1.0.0',
        modules: selections,
        files: {
          'brain/Index.md': makeFileState({
            template: `${SHARD_TEMPLATES_DIR}/brain/Index.md.njk`,
            rendered_hash: sha256(rendered),
          }),
        },
      }), drift },
      values: { old: values, new: values },
      newShard: {
        schema,
        selections,
        tempDir: shardDir,
        renderContext: renderCtx(values),
      },
      removedFileDecisions: {},
    });

    expect(plan.actions.map((a) => a.kind)).toEqual(['noop']);
    expect(plan.counts.silent).toBe(1);
  });

  it('plans a three-way merge for a modified file with non-overlapping edits', async () => {
    const schema = baseSchema();
    const selections: ModuleSelections = { brain: 'included' };

    const oldTemplate = [
      'line a',
      'line b',
      'line c',
      '',
    ].join('\n');
    const newTemplate = [
      'line a',
      'line b updated by shard',
      'line c',
      '',
    ].join('\n');
    const userEdited = [
      'line a',
      'line b',
      'line c',
      'line d added by user',
      '',
    ].join('\n');

    const vault = await buildVault({
      vaultFiles: { 'brain/Index.md': userEdited },
      cachedTemplates: { 'brain/Index.md.njk': oldTemplate },
    });
    const shardDir = await buildShardTempDir({ 'brain/Index.md.njk': newTemplate });

    const drift: DriftReport = {
      managed: [],
      modified: [
        {
          path: 'brain/Index.md',
          template: `${SHARD_TEMPLATES_DIR}/brain/Index.md.njk`,
          renderedHash: sha256(oldTemplate),
          actualHash: sha256(userEdited),
          ownership: 'modified',
        },
      ],
      volatile: [],
      missing: [],
      orphaned: [],
    };

    const plan = await planUpdate({
      vault: { root: vault, state: makeShardState({
        version: '1.0.0',
        modules: selections,
        files: {
          'brain/Index.md': makeFileState({
            template: `${SHARD_TEMPLATES_DIR}/brain/Index.md.njk`,
            rendered_hash: sha256(oldTemplate),
            ownership: 'modified',
          }),
        },
      }), drift },
      values: { old: {}, new: {} },
      newShard: {
        schema,
        selections,
        tempDir: shardDir,
        renderContext: renderCtx({}),
      },
      removedFileDecisions: {},
    });

    expect(plan.actions).toHaveLength(1);
    const action = plan.actions[0]!;
    expect(action.kind).toBe('auto_merge');
    if (action.kind !== 'auto_merge') throw new Error('narrowing');
    expect(action.content).toContain('line b updated by shard');
    expect(action.content).toContain('line d added by user');
  });

  it('emits a pending conflict when both sides edited the same region', async () => {
    const schema = baseSchema();
    const selections: ModuleSelections = { brain: 'included' };

    const oldTemplate = 'line a\nline b\nline c\n';
    const newTemplate = 'line a\nshard line\nline c\n';
    const userEdited = 'line a\nuser line\nline c\n';

    const vault = await buildVault({
      vaultFiles: { 'brain/Index.md': userEdited },
      cachedTemplates: { 'brain/Index.md.njk': oldTemplate },
    });
    const shardDir = await buildShardTempDir({ 'brain/Index.md.njk': newTemplate });

    const drift: DriftReport = {
      managed: [],
      modified: [
        {
          path: 'brain/Index.md',
          template: `${SHARD_TEMPLATES_DIR}/brain/Index.md.njk`,
          renderedHash: sha256(oldTemplate),
          actualHash: sha256(userEdited),
          ownership: 'modified',
        },
      ],
      volatile: [],
      missing: [],
      orphaned: [],
    };

    const plan = await planUpdate({
      vault: { root: vault, state: makeShardState({
        version: '1.0.0',
        modules: selections,
        files: {
          'brain/Index.md': makeFileState({
            template: `${SHARD_TEMPLATES_DIR}/brain/Index.md.njk`,
            rendered_hash: sha256(oldTemplate),
            ownership: 'modified',
          }),
        },
      }), drift },
      values: { old: {}, new: {} },
      newShard: {
        schema,
        selections,
        tempDir: shardDir,
        renderContext: renderCtx({}),
      },
      removedFileDecisions: {},
    });

    expect(plan.counts.conflicts).toBe(1);
    expect(plan.pendingConflicts).toHaveLength(1);
    expect(plan.pendingConflicts[0]!.path).toBe('brain/Index.md');
  });

  it('adds a new file introduced by the new shard', async () => {
    const schema = baseSchema();
    const selections: ModuleSelections = { brain: 'included' };
    const template = 'fresh file\n';

    const vault = await buildVault({
      vaultFiles: {},
      cachedTemplates: {},
    });
    const shardDir = await buildShardTempDir({ 'brain/Fresh.md.njk': template });

    const drift: DriftReport = {
      managed: [], modified: [], volatile: [], missing: [], orphaned: [],
    };

    const plan = await planUpdate({
      vault: { root: vault, state: makeShardState({ version: '1.0.0', modules: selections, files: {} }), drift },
      values: { old: {}, new: {} },
      newShard: {
        schema,
        selections,
        tempDir: shardDir,
        renderContext: renderCtx({}),
      },
      removedFileDecisions: {},
    });

    expect(plan.actions).toEqual([
      expect.objectContaining({ kind: 'add', path: 'brain/Fresh.md.njk'.replace('.njk', ''), content: template }),
    ]);
    expect(plan.counts.added).toBe(1);
  });

  it('deletes a managed file that the new shard no longer produces', async () => {
    const schema = baseSchema();
    const selections: ModuleSelections = { brain: 'included' };

    const vault = await buildVault({
      vaultFiles: { 'brain/Obsolete.md': 'old content\n' },
      cachedTemplates: { 'brain/Obsolete.md.njk': 'old content\n' },
    });
    const shardDir = await buildShardTempDir({});  // nothing in new shard

    const drift: DriftReport = {
      managed: [
        {
          path: 'brain/Obsolete.md',
          template: `${SHARD_TEMPLATES_DIR}/brain/Obsolete.md.njk`,
          renderedHash: sha256('old content\n'),
          actualHash: sha256('old content\n'),
          ownership: 'managed',
        },
      ],
      modified: [], volatile: [], missing: [], orphaned: [],
    };

    const plan = await planUpdate({
      vault: { root: vault, state: makeShardState({
        version: '1.0.0',
        modules: selections,
        files: {
          'brain/Obsolete.md': makeFileState({
            template: `${SHARD_TEMPLATES_DIR}/brain/Obsolete.md.njk`,
            rendered_hash: sha256('old content\n'),
          }),
        },
      }), drift },
      values: { old: {}, new: {} },
      newShard: {
        schema,
        selections,
        tempDir: shardDir,
        renderContext: renderCtx({}),
      },
      removedFileDecisions: {},
    });

    expect(plan.actions).toEqual([{ kind: 'delete', path: 'brain/Obsolete.md' }]);
    expect(plan.counts.deleted).toBe(1);
  });

  it('keeps a modified file removed from the new shard by default', async () => {
    const schema = baseSchema();
    const selections: ModuleSelections = { brain: 'included' };

    const vault = await buildVault({
      vaultFiles: { 'brain/UserEdited.md': 'my edits\n' },
      cachedTemplates: { 'brain/UserEdited.md.njk': 'original\n' },
    });
    const shardDir = await buildShardTempDir({});

    const drift: DriftReport = {
      managed: [], volatile: [], missing: [], orphaned: [],
      modified: [
        {
          path: 'brain/UserEdited.md',
          template: `${SHARD_TEMPLATES_DIR}/brain/UserEdited.md.njk`,
          renderedHash: sha256('original\n'),
          actualHash: sha256('my edits\n'),
          ownership: 'modified',
        },
      ],
    };

    const plan = await planUpdate({
      vault: { root: vault, state: makeShardState({
        version: '1.0.0',
        modules: selections,
        files: {
          'brain/UserEdited.md': makeFileState({
            template: `${SHARD_TEMPLATES_DIR}/brain/UserEdited.md.njk`,
            rendered_hash: sha256('original\n'),
            ownership: 'modified',
          }),
        },
      }), drift },
      values: { old: {}, new: {} },
      newShard: {
        schema,
        selections,
        tempDir: shardDir,
        renderContext: renderCtx({}),
      },
      removedFileDecisions: {},
    });

    expect(plan.actions).toEqual([{ kind: 'keep_as_user', path: 'brain/UserEdited.md' }]);
    expect(plan.counts.keptAsUser).toBe(1);
  });

  it('honors an explicit "delete" decision for a modified removed file', async () => {
    const schema = baseSchema();
    const selections: ModuleSelections = { brain: 'included' };

    const vault = await buildVault({
      vaultFiles: { 'brain/UserEdited.md': 'my edits\n' },
      cachedTemplates: { 'brain/UserEdited.md.njk': 'original\n' },
    });
    const shardDir = await buildShardTempDir({});

    const drift: DriftReport = {
      managed: [], volatile: [], missing: [], orphaned: [],
      modified: [
        {
          path: 'brain/UserEdited.md',
          template: `${SHARD_TEMPLATES_DIR}/brain/UserEdited.md.njk`,
          renderedHash: sha256('original\n'),
          actualHash: sha256('my edits\n'),
          ownership: 'modified',
        },
      ],
    };

    const plan = await planUpdate({
      vault: { root: vault, state: makeShardState({
        version: '1.0.0',
        modules: selections,
        files: {
          'brain/UserEdited.md': makeFileState({
            template: `${SHARD_TEMPLATES_DIR}/brain/UserEdited.md.njk`,
            rendered_hash: sha256('original\n'),
            ownership: 'modified',
          }),
        },
      }), drift },
      values: { old: {}, new: {} },
      newShard: {
        schema,
        selections,
        tempDir: shardDir,
        renderContext: renderCtx({}),
      },
      removedFileDecisions: { 'brain/UserEdited.md': 'delete' },
    });

    expect(plan.actions).toEqual([{ kind: 'delete', path: 'brain/UserEdited.md' }]);
    expect(plan.counts.deleted).toBe(1);
  });

  it('restores a file recorded in state that is missing from disk', async () => {
    const schema = baseSchema();
    const selections: ModuleSelections = { brain: 'included' };
    const template = 'restored content\n';

    const vault = await buildVault({
      vaultFiles: {},
      cachedTemplates: { 'brain/Index.md.njk': template },
    });
    const shardDir = await buildShardTempDir({ 'brain/Index.md.njk': template });

    const drift: DriftReport = {
      managed: [], modified: [], volatile: [], orphaned: [],
      missing: [
        {
          path: 'brain/Index.md',
          template: `${SHARD_TEMPLATES_DIR}/brain/Index.md.njk`,
          renderedHash: sha256(template),
          actualHash: null,
          ownership: 'managed',
        },
      ],
    };

    const plan = await planUpdate({
      vault: { root: vault, state: makeShardState({
        version: '1.0.0',
        modules: selections,
        files: {
          'brain/Index.md': makeFileState({
            template: `${SHARD_TEMPLATES_DIR}/brain/Index.md.njk`,
            rendered_hash: sha256(template),
          }),
        },
      }), drift },
      values: { old: {}, new: {} },
      newShard: {
        schema,
        selections,
        tempDir: shardDir,
        renderContext: renderCtx({}),
      },
      removedFileDecisions: {},
    });

    expect(plan.actions).toEqual([
      expect.objectContaining({ kind: 'restore_missing', path: 'brain/Index.md', content: template }),
    ]);
    expect(plan.counts.restored).toBe(1);
  });

  it('passes through volatile files untouched', async () => {
    const schema = baseSchema();
    const selections: ModuleSelections = { brain: 'included' };

    const vault = await buildVault({
      vaultFiles: { 'brain/Log.md': 'user content\n' },
      cachedTemplates: { 'brain/Log.md.njk': 'template\n' },
    });
    const shardDir = await buildShardTempDir({ 'brain/Log.md.njk': 'template\n' });

    const drift: DriftReport = {
      managed: [], modified: [], missing: [], orphaned: [],
      volatile: [
        {
          path: 'brain/Log.md',
          template: `${SHARD_TEMPLATES_DIR}/brain/Log.md.njk`,
          renderedHash: sha256('template\n'),
          actualHash: null,
          ownership: 'volatile',
        },
      ],
    };

    const plan = await planUpdate({
      vault: { root: vault, state: makeShardState({
        version: '1.0.0',
        modules: selections,
        files: {
          'brain/Log.md': makeFileState({
            template: `${SHARD_TEMPLATES_DIR}/brain/Log.md.njk`,
            rendered_hash: sha256('template\n'),
            ownership: 'user',
          }),
        },
      }), drift },
      values: { old: {}, new: {} },
      newShard: {
        schema,
        selections,
        tempDir: shardDir,
        renderContext: renderCtx({}),
      },
      removedFileDecisions: {},
    });

    expect(plan.actions.find((a) => a.kind === 'skip_volatile')).toEqual({
      kind: 'skip_volatile',
      path: 'brain/Log.md',
    });
    expect(plan.counts.volatile).toBe(1);
  });
});
