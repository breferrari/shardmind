/**
 * Adversarial + property-based tests for the update planner + executor.
 *
 * Complements `update-planner.test.ts` (happy-path fixture tests) by
 * pushing against:
 *   - Missing / corrupt cached templates
 *   - Iterator array shrink (_each templates that produced paths now gone)
 *   - Unicode + CRLF content in user files and templates
 *   - Concurrent backup directories (same-second collision guard)
 *   - Rollback idempotency (re-running rollback should not error)
 *   - Property: plan is deterministic (same inputs → same actions list)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import fc from 'fast-check';
import {
  planUpdate,
  renderNewShard,
} from '../../source/core/update-planner.js';
import {
  createBackupDir,
  rollbackUpdate,
} from '../../source/core/update-executor.js';
import { sha256 } from '../../source/core/fs-utils.js';
import type {
  ShardSchema,
  ShardState,
  ModuleSelections,
  RenderContext,
  DriftReport,
} from '../../source/runtime/types.js';
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
    values: {},
    groups: [{ id: 'setup', label: 'Setup' }],
    modules: { brain: { label: 'Brain', paths: ['brain/'], removable: false } },
    signals: [],
    frontmatter: {},
    migrations: [],
    ...overrides,
  };
}

function renderCtx(values: Record<string, unknown> = {}): RenderContext {
  return {
    values,
    included_modules: ['brain'],
    shard: { name: 'test', version: '1.0.0' },
    install_date: NOW.toISOString(),
    year: '2026',
  };
}

// ---------------------------------------------------------------------------
// Temp-dir harness
// ---------------------------------------------------------------------------

async function makeVault(
  tempRoot: string,
  vaultFiles: Record<string, string>,
  cachedTemplates: Record<string, string>,
): Promise<string> {
  const vault = path.join(tempRoot, 'vault-' + crypto.randomUUID());
  await fsp.mkdir(vault, { recursive: true });
  for (const [rel, content] of Object.entries(vaultFiles)) {
    const abs = path.join(vault, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, 'utf-8');
  }
  const cacheDir = path.join(vault, CACHED_TEMPLATES);
  await fsp.mkdir(cacheDir, { recursive: true });
  for (const [rel, content] of Object.entries(cachedTemplates)) {
    const abs = path.join(cacheDir, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, 'utf-8');
  }
  return vault;
}

async function makeShardDir(
  tempRoot: string,
  files: Record<string, string>,
): Promise<string> {
  const shardDir = path.join(tempRoot, 'shard-' + crypto.randomUUID());
  const templatesDir = path.join(shardDir, SHARD_TEMPLATES_DIR);
  await fsp.mkdir(templatesDir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(templatesDir, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, 'utf-8');
  }
  return shardDir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('planUpdate — hostile inputs', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'update-adv-'));
  });
  afterEach(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  it('falls back to direct conflict when the cached template is missing for a modified file', async () => {
    const schema = baseSchema();
    const selections: ModuleSelections = { brain: 'included' };

    // Vault has a modified file but NO cached template for it.
    const onDisk = 'user wrote something\n';
    const newContent = 'shard new content\n';
    const vault = await makeVault(
      tempRoot,
      { 'brain/Index.md': onDisk },
      {}, // empty cache — simulates corruption
    );
    const shardDir = await makeShardDir(tempRoot, { 'brain/Index.md.njk': newContent });

    const state = makeShardState({
      version: '1.0.0',
      modules: selections,
      files: {
        'brain/Index.md': makeFileState({
          template: `${SHARD_TEMPLATES_DIR}/brain/Index.md.njk`,
          rendered_hash: 'stale',
          ownership: 'modified',
        }),
      },
    });

    const drift: DriftReport = {
      managed: [], volatile: [], missing: [], orphaned: [],
      modified: [
        {
          path: 'brain/Index.md',
          template: `${SHARD_TEMPLATES_DIR}/brain/Index.md.njk`,
          renderedHash: 'stale',
          actualHash: sha256(onDisk),
          ownership: 'modified',
        },
      ],
    };

    const plan = await planUpdate({
      vault: { root: vault, state, drift },
      values: { old: {}, new: {} },
      newShard: {
        schema,
        selections,
        tempDir: shardDir,
        renderContext: renderCtx(),
      },
      removedFileDecisions: {},
    });

    expect(plan.counts.conflicts).toBe(1);
    const conflict = plan.actions.find((a) => a.kind === 'conflict');
    expect(conflict).toBeDefined();
    if (conflict?.kind !== 'conflict') throw new Error('narrowing');
    // Direct-fallback conflict packs theirs + ours as single region.
    expect(conflict.result.conflicts).toHaveLength(1);
    expect(conflict.result.conflicts[0]!.theirs).toBe(onDisk);
    expect(conflict.result.conflicts[0]!.ours).toBe(newContent);
    // The templateKey is relative to the new tempdir (templates/<...>),
    // not an absolute path (the previous bug in conflictFromDirect
    // passed '' for tempDir which produced an absolute path).
    expect(conflict.templateKey).toBe(`${SHARD_TEMPLATES_DIR}/brain/Index.md.njk`);
  });

  it('deletes orphaned files from state when the iterator array shrinks', async () => {
    // Simulate the _each scenario: state has items/a, items/b, items/c all
    // from a single iterator template. New render produces only a and b.
    // Planner should emit delete actions for items/c (drift.managed) and
    // drop the state entry.
    const schema = baseSchema();
    const selections: ModuleSelections = { brain: 'included' };

    const content = 'item note\n';
    const vault = await makeVault(
      tempRoot,
      {
        'items/a/note.md': content,
        'items/b/note.md': content,
        'items/c/note.md': content,
      },
      {
        'items/_each/note.md.njk': 'item note\n',
      },
    );
    // New shard still has the _each template, but the iterator value 'c'
    // is gone from values. We simulate by not including a c-output.
    const shardDir = await makeShardDir(tempRoot, {
      'items/a/note.md': 'item note\n',
      'items/b/note.md': 'item note\n',
    });

    const state = makeShardState({
      modules: selections,
      files: {
        'items/a/note.md': makeFileState({
          template: `${SHARD_TEMPLATES_DIR}/items/_each/note.md.njk`,
          rendered_hash: sha256(content),
          iterator_key: 'items',
        }),
        'items/b/note.md': makeFileState({
          template: `${SHARD_TEMPLATES_DIR}/items/_each/note.md.njk`,
          rendered_hash: sha256(content),
          iterator_key: 'items',
        }),
        'items/c/note.md': makeFileState({
          template: `${SHARD_TEMPLATES_DIR}/items/_each/note.md.njk`,
          rendered_hash: sha256(content),
          iterator_key: 'items',
        }),
      },
    });

    const drift: DriftReport = {
      volatile: [], modified: [], missing: [], orphaned: [],
      managed: [
        { path: 'items/a/note.md', template: null, renderedHash: sha256(content), actualHash: sha256(content), ownership: 'managed' },
        { path: 'items/b/note.md', template: null, renderedHash: sha256(content), actualHash: sha256(content), ownership: 'managed' },
        { path: 'items/c/note.md', template: null, renderedHash: sha256(content), actualHash: sha256(content), ownership: 'managed' },
      ],
    };

    const plan = await planUpdate({
      vault: { root: vault, state, drift },
      values: { old: {}, new: {} },
      newShard: { schema, selections, tempDir: shardDir, renderContext: renderCtx() },
      removedFileDecisions: {},
    });

    const deleted = plan.actions.filter((a) => a.kind === 'delete').map((a) => a.path);
    expect(deleted).toContain('items/c/note.md');
  });

  it('CRLF-edited user files do not produce spurious conflicts on non-overlapping edits', async () => {
    const schema = baseSchema();
    const selections: ModuleSelections = { brain: 'included' };

    // Old and new templates differ at the top; user (on Windows/CRLF)
    // added a distinct line at the bottom. These are non-overlapping
    // edits; the merge engine should reconcile them cleanly without
    // penalizing CRLF input.
    const oldTemplate = 'line 1\nline 2\nline 3\n';
    const newTemplate = 'line 1 updated\nline 2\nline 3\n';
    const userCRLF = 'line 1\r\nline 2\r\nline 3\r\nuser-added tail\r\n';

    const vault = await makeVault(
      tempRoot,
      { 'brain/Index.md': userCRLF },
      { 'brain/Index.md.njk': oldTemplate },
    );
    const shardDir = await makeShardDir(tempRoot, { 'brain/Index.md.njk': newTemplate });

    const state = makeShardState({
      modules: selections,
      files: {
        'brain/Index.md': makeFileState({
          template: `${SHARD_TEMPLATES_DIR}/brain/Index.md.njk`,
          rendered_hash: sha256(oldTemplate),
          ownership: 'modified',
        }),
      },
    });

    const drift: DriftReport = {
      managed: [], volatile: [], missing: [], orphaned: [],
      modified: [
        {
          path: 'brain/Index.md',
          template: `${SHARD_TEMPLATES_DIR}/brain/Index.md.njk`,
          renderedHash: sha256(oldTemplate),
          actualHash: sha256(userCRLF),
          ownership: 'modified',
        },
      ],
    };

    const plan = await planUpdate({
      vault: { root: vault, state, drift },
      values: { old: {}, new: {} },
      newShard: { schema, selections, tempDir: shardDir, renderContext: renderCtx() },
      removedFileDecisions: {},
    });

    expect(plan.counts.conflicts).toBe(0);
    expect(plan.counts.autoMerged).toBe(1);
    const merged = plan.actions.find((a) => a.kind === 'auto_merge');
    if (merged?.kind !== 'auto_merge') throw new Error('narrowing');
    expect(merged.content).toContain('line 1 updated');
    expect(merged.content).toContain('user-added tail');
  });

  it('handles Unicode filenames and emoji-containing content', async () => {
    const schema = baseSchema();
    const selections: ModuleSelections = { brain: 'included' };

    const content = '💡 brilliant idea\n— Émilie\n';
    const vault = await makeVault(
      tempRoot,
      { 'brain/Idées.md': content },
      { 'brain/Idées.md.njk': content },
    );
    const shardDir = await makeShardDir(tempRoot, { 'brain/Idées.md.njk': content });

    const state = makeShardState({
      modules: selections,
      files: {
        'brain/Idées.md': makeFileState({
          template: `${SHARD_TEMPLATES_DIR}/brain/Idées.md.njk`,
          rendered_hash: sha256(content),
        }),
      },
    });

    const drift: DriftReport = {
      volatile: [], modified: [], missing: [], orphaned: [],
      managed: [
        {
          path: 'brain/Idées.md',
          template: `${SHARD_TEMPLATES_DIR}/brain/Idées.md.njk`,
          renderedHash: sha256(content),
          actualHash: sha256(content),
          ownership: 'managed',
        },
      ],
    };

    const plan = await planUpdate({
      vault: { root: vault, state, drift },
      values: { old: {}, new: {} },
      newShard: { schema, selections, tempDir: shardDir, renderContext: renderCtx() },
      removedFileDecisions: {},
    });

    // Identical content → noop
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]!.kind).toBe('noop');
  });

  it('raises UPDATE_CACHE_MISSING when drift.modified references a file that is not in state', async () => {
    // Inconsistent inputs: drift says "modified" but state.files has no
    // entry. That's a serialization bug; the planner should surface it
    // loudly rather than silently producing bad actions.
    const schema = baseSchema();
    const selections: ModuleSelections = { brain: 'included' };
    const vault = await makeVault(tempRoot, { 'x.md': 'whatever' }, {});
    const shardDir = await makeShardDir(tempRoot, { 'x.md.njk': 'whatever' });

    const state = makeShardState({ modules: selections, files: {} });
    const drift: DriftReport = {
      managed: [], volatile: [], missing: [], orphaned: [],
      modified: [
        {
          path: 'x.md',
          template: null,
          renderedHash: 'h',
          actualHash: 'i',
          ownership: 'modified',
        },
      ],
    };

    await expect(
      planUpdate({
        vault: { root: vault, state, drift },
        values: { old: {}, new: {} },
        newShard: { schema, selections, tempDir: shardDir, renderContext: renderCtx() },
        removedFileDecisions: {},
      }),
    ).rejects.toMatchObject({ code: 'UPDATE_CACHE_MISSING' });
  });
});

// ---------------------------------------------------------------------------
// createBackupDir
// ---------------------------------------------------------------------------

describe('createBackupDir — concurrency and clock edge cases', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'update-backup-'));
    // Seed .shardmind/ so createBackupDir can write under it.
    await fsp.mkdir(path.join(tempRoot, SHARDMIND_DIR), { recursive: true });
  });
  afterEach(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  it('allocates distinct directories when called twice at the exact same instant', async () => {
    const frozen = new Date('2026-04-20T10:30:45.123Z');
    const a = await createBackupDir(tempRoot, frozen);
    const b = await createBackupDir(tempRoot, frozen);
    expect(a).not.toBe(b);
    const statA = await fsp.stat(a);
    const statB = await fsp.stat(b);
    expect(statA.isDirectory()).toBe(true);
    expect(statB.isDirectory()).toBe(true);
  });

  it('the second call lands under -1 when the first took the un-suffixed name', async () => {
    const frozen = new Date('2026-04-20T10:30:45.999Z');
    const a = await createBackupDir(tempRoot, frozen);
    const b = await createBackupDir(tempRoot, frozen);
    expect(path.basename(b)).toMatch(/-1$/);
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// rollbackUpdate idempotency
// ---------------------------------------------------------------------------

describe('rollbackUpdate — idempotency + partial snapshots', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'update-rb-'));
  });
  afterEach(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  it('returns an empty failure list when called against a non-existent backup directory', async () => {
    const nonExistent = path.join(tempRoot, 'never-created');
    const failures = await rollbackUpdate(tempRoot, nonExistent, []);
    expect(failures).toEqual([]);
  });

  it('is idempotent: running twice produces the same vault state and returns no failures either time', async () => {
    const vault = path.join(tempRoot, 'vault');
    await fsp.mkdir(vault, { recursive: true });
    const target = path.join(vault, 'note.md');
    await fsp.writeFile(target, 'original\n', 'utf-8');

    const backupDir = path.join(vault, SHARDMIND_DIR, 'backups', 'update-test');
    const backupTarget = path.join(backupDir, 'files', 'note.md');
    await fsp.mkdir(path.dirname(backupTarget), { recursive: true });
    await fsp.writeFile(backupTarget, 'original\n', 'utf-8');

    await fsp.writeFile(target, 'mid-update\n', 'utf-8');

    const firstFailures = await rollbackUpdate(vault, backupDir, []);
    const first = await fsp.readFile(target, 'utf-8');
    const secondFailures = await rollbackUpdate(vault, backupDir, []);
    const second = await fsp.readFile(target, 'utf-8');

    expect(first).toBe('original\n');
    expect(second).toBe('original\n');
    expect(firstFailures).toEqual([]);
    expect(secondFailures).toEqual([]);
  });

  it('preserves binary copy-origin assets byte-for-byte via copyFromSourcePath', async () => {
    // A full runUpdate path would require mocking cache/templates — that's
    // not what this test is about. We surgical-test writeAction via the
    // one public surface that exercises it: renderNewShard → the planner's
    // hash matches the actual bytes (not a UTF-8 round-trip) when
    // copyFromSourcePath is present.
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0xc0, 0xff, 0xee]);
    const shardDir = await makeShardDir(tempRoot, {});
    // Write a binary copy-source INSIDE the shard tempDir (scripts/ is
    // always-copied per modules.ts ALWAYS_COPY_DIRS).
    const scriptsDir = path.join(shardDir, 'scripts');
    await fsp.mkdir(scriptsDir, { recursive: true });
    await fsp.writeFile(path.join(scriptsDir, 'asset.bin'), binary);

    const schema = baseSchema();
    const plan = await renderNewShard(schema, shardDir, { brain: 'included' }, renderCtx());
    const entry = plan.outputs.find((o) => o.outputPath.endsWith('asset.bin'));
    expect(entry).toBeDefined();
    expect(entry!.copyFromSourcePath).toBe(path.join(scriptsDir, 'asset.bin'));
    // The hash is the sha256 of the ORIGINAL bytes, not the UTF-8-
    // round-tripped string. If renderNewShard ever lost this, hash
    // mismatch would cause every update to re-write binary assets.
    expect(entry!.hash).toBe(sha256(binary));
  });

  it('surfaces per-file rollback failures instead of swallowing them', async () => {
    // Build a backup with a file that can't be restored because the
    // destination parent is a file (not a directory) — copyFile will
    // fail with ENOTDIR / EEXIST depending on platform.
    const vault = path.join(tempRoot, 'vault');
    await fsp.mkdir(vault, { recursive: true });
    // Place a regular file where the restore expects a directory.
    await fsp.writeFile(path.join(vault, 'blocker'), 'im-not-a-dir', 'utf-8');

    const backupDir = path.join(vault, SHARDMIND_DIR, 'backups', 'update-test');
    const blockedBackup = path.join(backupDir, 'files', 'blocker', 'note.md');
    await fsp.mkdir(path.dirname(blockedBackup), { recursive: true });
    await fsp.writeFile(blockedBackup, 'restore me\n', 'utf-8');

    const failures = await rollbackUpdate(vault, backupDir, []);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]!.path).toMatch(/blocker[\\/]note\.md/);
    expect(failures[0]!.reason).toMatch(/restore failed/);
  });
});

// ---------------------------------------------------------------------------
// renderNewShard property: deterministic output
// ---------------------------------------------------------------------------

describe('renderNewShard — determinism', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'render-prop-'));
  });
  afterEach(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  it('produces the same outputs list on repeated calls with the same inputs', async () => {
    const schema = baseSchema();
    const selections: ModuleSelections = { brain: 'included' };
    const shardDir = await makeShardDir(tempRoot, {
      'brain/A.md.njk': 'A\n',
      'brain/B.md.njk': 'B\n',
      'brain/C.md.njk': 'C\n',
    });

    const a = await renderNewShard(schema, shardDir, selections, renderCtx());
    const b = await renderNewShard(schema, shardDir, selections, renderCtx());

    expect(a.outputs.map((o) => o.outputPath).sort()).toEqual(
      b.outputs.map((o) => o.outputPath).sort(),
    );
    expect(a.outputs.map((o) => o.hash).sort()).toEqual(
      b.outputs.map((o) => o.hash).sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Property: plan counts sum to drift totals for no-change upgrade
// ---------------------------------------------------------------------------

describe('planUpdate — invariants', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'plan-prop-'));
  });
  afterEach(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  it('for an identical upgrade (same template, same values), every managed file is noop', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.stringMatching(/^[a-z0-9]{1,8}$/), { minLength: 1, maxLength: 5, size: 'small' }),
        async (names) => {
          const unique = Array.from(new Set(names));
          if (unique.length === 0) return;

          const templates: Record<string, string> = {};
          const vaultFiles: Record<string, string> = {};
          const cachedTemplates: Record<string, string> = {};
          const stateFiles: Record<string, ReturnType<typeof makeFileState>> = {};
          const managed: DriftReport['managed'] = [];

          for (const name of unique) {
            const tmplPath = `brain/${name}.md.njk`;
            const outPath = `brain/${name}.md`;
            const content = `content of ${name}\n`;
            templates[tmplPath] = content;
            vaultFiles[outPath] = content;
            cachedTemplates[tmplPath] = content;
            stateFiles[outPath] = makeFileState({
              template: `${SHARD_TEMPLATES_DIR}/${tmplPath}`,
              rendered_hash: sha256(content),
            });
            managed.push({
              path: outPath,
              template: `${SHARD_TEMPLATES_DIR}/${tmplPath}`,
              renderedHash: sha256(content),
              actualHash: sha256(content),
              ownership: 'managed',
            });
          }

          const vault = await makeVault(tempRoot, vaultFiles, cachedTemplates);
          const shardDir = await makeShardDir(tempRoot, templates);
          const state = makeShardState({
            modules: { brain: 'included' },
            files: stateFiles,
          });
          const drift: DriftReport = { managed, modified: [], volatile: [], missing: [], orphaned: [] };

          const plan = await planUpdate({
            vault: { root: vault, state, drift },
            values: { old: {}, new: {} },
            newShard: {
              schema: baseSchema(),
              selections: { brain: 'included' },
              tempDir: shardDir,
              renderContext: renderCtx(),
            },
            removedFileDecisions: {},
          });

          const noops = plan.actions.filter((a) => a.kind === 'noop').length;
          expect(noops).toBe(managed.length);
        },
      ),
      { numRuns: 20 },
    );
  });
});
