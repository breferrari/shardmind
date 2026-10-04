/**
 * `--json` document contract (#139 findings 3, 4, 5).
 *
 * These are the shapes an agent parses, so the assertions here are a
 * compatibility promise, not an implementation detail. Two properties matter
 * most and are asserted explicitly rather than left implicit in a snapshot:
 *
 *   1. No file content ever reaches the document. A plan is a decision aid;
 *      serializing buffers would put the whole vault on stdout and, for binary
 *      files, produce garbage.
 *   2. Lists are uncapped and stably ordered. "Which files?" is the question
 *      the summary counts could not answer, so truncating defeats the purpose,
 *      and unstable order makes run-to-run diffing useless.
 */

import { describe, it, expect } from 'vitest';
import {
  JSON_SCHEMA_VERSION,
  adoptPlanResult,
  emitJson,
  jsonFailure,
  jsonSuccess,
  statusResult,
  updatePlanResult,
} from '../../source/core/json-output.js';
import { ShardMindError } from '../../source/runtime/types.js';
import type { StatusReport } from '../../source/runtime/types.js';
import type { AdoptClassification, AdoptPlan } from '../../source/core/adopt-planner.js';
import type { UpdateAction, UpdatePlan } from '../../source/core/update-planner.js';

function matches(path: string): AdoptClassification {
  return { kind: 'matches', path, templateKey: path, shardHash: `h-${path}`, volatile: false };
}

function differs(path: string): AdoptClassification {
  return {
    kind: 'differs',
    path,
    templateKey: path,
    shardContent: Buffer.from('theirs bytes'),
    shardHash: `theirs-${path}`,
    userContent: Buffer.from('mine'),
    userHash: `mine-${path}`,
    isBinary: false,
    volatile: false,
  };
}

function shardOnly(path: string): AdoptClassification {
  return {
    kind: 'shard-only',
    path,
    templateKey: path,
    shardContent: Buffer.from('new file'),
    shardHash: `new-${path}`,
    volatile: true,
  };
}

describe('json envelope', () => {
  it('wraps a success with the schema version and the command', () => {
    const env = jsonSuccess('status', { hello: 'world' });
    expect(env).toEqual({
      schemaVersion: JSON_SCHEMA_VERSION,
      command: 'status',
      ok: true,
      result: { hello: 'world' },
    });
  });

  it('carries code and hint through from a ShardMindError', () => {
    const env = jsonFailure('adopt', new ShardMindError('boom', 'ADOPT_WRITE_FAILED', 'try this'));
    expect(env.ok).toBe(false);
    expect(env.error).toEqual({ code: 'ADOPT_WRITE_FAILED', message: 'boom', hint: 'try this', stack: null });
    expect(env.result).toBeUndefined();
  });

  it('degrades a plain Error to a null code rather than inventing one', () => {
    const err = new Error('kaboom');
    const env = jsonFailure('update', err);
    expect(env.error).toEqual({ code: null, message: 'kaboom', hint: null, stack: err.stack });
  });

  it('survives a non-Error throw', () => {
    expect(jsonFailure('update', 'a string').error).toEqual({ code: null, message: 'a string', hint: null, stack: null });
  });

  it('emits exactly one document and one trailing newline', () => {
    const chunks: string[] = [];
    emitJson(jsonSuccess('status', { a: 1 }), (c) => chunks.push(c));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.endsWith('\n')).toBe(true);
    expect(chunks[0]!.trimEnd().endsWith('}')).toBe(true);
    expect(() => JSON.parse(chunks[0]!)).not.toThrow();
  });
});

describe('adoptPlanResult', () => {
  const plan: AdoptPlan = {
    matches: [matches('z-same.md')],
    differs: [differs('a-mine.md')],
    shardOnly: [shardOnly('m-new.md')],
    totalShardFiles: 3,
  };

  it('lists every file across all three buckets', () => {
    const out = adoptPlanResult(plan, { dryRun: true, mode: null });
    expect(out.files).toHaveLength(3);
    expect(out.counts).toEqual({ matches: 1, differs: 1, shardOnly: 1, totalShardFiles: 3 });
  });

  it('sorts by path so two runs diff cleanly', () => {
    const out = adoptPlanResult(plan, { dryRun: true, mode: null });
    expect(out.files.map((f) => f.path)).toEqual(['a-mine.md', 'm-new.md', 'z-same.md']);
  });

  it('gives a divergent file both hashes and both sizes', () => {
    const out = adoptPlanResult(plan, { dryRun: true, mode: null });
    const file = out.files.find((f) => f.path === 'a-mine.md')!;
    expect(file.classification).toBe('differs');
    expect(file.shardHash).toBe('theirs-a-mine.md');
    expect(file.userHash).toBe('mine-a-mine.md');
    expect(file.shardBytes).toBe(Buffer.from('theirs bytes').byteLength);
    expect(file.userBytes).toBe(Buffer.from('mine').byteLength);
    expect(file.binary).toBe(false);
  });

  it('never serializes file content', () => {
    const json = JSON.stringify(adoptPlanResult(plan, { dryRun: true, mode: null }));
    expect(json).not.toContain('theirs bytes');
    expect(json).not.toContain('new file');
    expect(json).not.toContain('"type":"Buffer"');
  });

  it('omits userHash for buckets that have no user side', () => {
    const out = adoptPlanResult(plan, { dryRun: true, mode: null });
    expect(out.files.find((f) => f.path === 'z-same.md')!.userHash).toBeUndefined();
    expect(out.files.find((f) => f.path === 'm-new.md')!.userHash).toBeUndefined();
  });

  it('names the old path of a file adopt would move (#179)', () => {
    const moved: AdoptPlan = { ...plan, matches: [{ ...matches('AGENTS.md'), movedFrom: 'CLAUDE.md' } as AdoptClassification] };
    const out = adoptPlanResult(moved, { dryRun: true, mode: null });
    expect(out.files.find((f) => f.path === 'AGENTS.md')!.movedFrom).toBe('CLAUDE.md');
    expect(out.files.find((f) => f.path === 'a-mine.md')!.movedFrom).toBeUndefined();
  });

  it('preserves the volatile flag', () => {
    const out = adoptPlanResult(plan, { dryRun: true, mode: null });
    expect(out.files.find((f) => f.path === 'm-new.md')!.volatile).toBe(true);
  });

  it('reports the requested mode, or null when none was given', () => {
    expect(adoptPlanResult(plan, { dryRun: true, mode: null }).mode).toBeNull();
    expect(adoptPlanResult(plan, { dryRun: true, mode: 'keep-all-mine' }).mode).toBe('keep-all-mine');
  });

  it('does not cap the file list', () => {
    const many: AdoptPlan = {
      matches: Array.from({ length: 250 }, (_, i) => matches(`f${String(i).padStart(3, '0')}.md`)),
      differs: [],
      shardOnly: [],
      totalShardFiles: 250,
    };
    expect(adoptPlanResult(many, { dryRun: true, mode: null }).files).toHaveLength(250);
  });
});

describe('updatePlanResult', () => {
  const actions: UpdateAction[] = [
    { kind: 'noop', path: 'b.md', reason: 'unchanged' },
    {
      kind: 'conflict',
      path: 'a.md',
      result: { conflicts: 1 } as never,
      newContent: 'new bytes',
      newContentHash: 'new-a',
      theirsHash: 'mine-a',
      templateKey: 'a.md',
      preexisting: true,
    },
    { kind: 'delete', path: 'c.md' },
    { kind: 'add', path: 'd.md', content: 'added bytes', renderedHash: 'new-d', templateKey: 'd.md' },
  ];
  const plan: UpdatePlan = {
    actions,
    pendingConflicts: [],
    counts: {
      silent: 1,
      overwritten: 0,
      adopted: 0,
      autoMerged: 0,
      conflicts: 1,
      volatile: 0,
      added: 1,
      deleted: 1,
      keptAsUser: 0,
      restored: 0,
    },
  };

  it('emits one sorted entry per action with its kind verbatim', () => {
    const out = updatePlanResult(plan, { dryRun: true });
    expect(out.files.map((f) => f.path)).toEqual(['a.md', 'b.md', 'c.md', 'd.md']);
    expect(out.files.map((f) => f.action)).toEqual(['conflict', 'noop', 'delete', 'add']);
  });

  it("names a renamed file's old path (#178)", () => {
    const renamedPlan: UpdatePlan = {
      ...plan,
      actions: [{ kind: 'noop', path: 'AGENTS.md', reason: 'identical', renamedFrom: 'CLAUDE.md' }],
    };
    const [file] = updatePlanResult(renamedPlan, { dryRun: true }).files;
    expect(file!.renamedFrom).toBe('CLAUDE.md');
    expect(updatePlanResult(plan, { dryRun: true }).files.every((f) => f.renamedFrom === undefined)).toBe(true);
  });

  it('gives a conflict both sides plus the preexisting flag', () => {
    const file = updatePlanResult(plan, { dryRun: true }).files.find((f) => f.path === 'a.md')!;
    expect(file.shardHash).toBe('new-a');
    expect(file.userHash).toBe('mine-a');
    expect(file.preexisting).toBe(true);
  });

  it('explains a noop instead of leaving it bare', () => {
    const file = updatePlanResult(plan, { dryRun: true }).files.find((f) => f.path === 'b.md')!;
    expect(file.reason).toBe('unchanged');
  });

  it('never serializes file content or merge internals', () => {
    const json = JSON.stringify(updatePlanResult(plan, { dryRun: true }));
    expect(json).not.toContain('new bytes');
    expect(json).not.toContain('added bytes');
  });

  it('passes the planner counts through unchanged', () => {
    expect(updatePlanResult(plan, { dryRun: true }).counts).toEqual(plan.counts);
  });

  // #150: an auto-merge records the new render as its baseline, so the
  // document reports that hash — what the shard produces, as for a conflict —
  // not the merged bytes, which hold the user's lines.
  it('reports an auto-merge\'s shard hash as the new render, the hash state records', () => {
    const merged: UpdatePlan = {
      ...plan,
      actions: [{
        kind: 'auto_merge',
        path: 'e.md',
        content: 'merged bytes',
        baselineHash: 'render-e',
        ownership: 'modified',
        stats: { linesUnchanged: 1, linesAutoMerged: 1 },
        templateKey: 'e.md',
      }],
    };
    expect(updatePlanResult(merged, { dryRun: true }).files[0]!.shardHash).toBe('render-e');
  });
});

describe('statusResult (#139)', () => {
  function report(overrides: Partial<StatusReport> = {}): StatusReport {
    return {
      manifest: { apiVersion: 'v1', name: 'minimal', namespace: 'shardmind', version: '0.1.0', dependencies: [], hooks: {} } as never,
      state: {
        schema_version: 2,
        shard: 'shardmind/minimal',
        source: 'github:acme/demo',
        version: '0.1.0',
        tarball_sha256: 'sha',
        installed_at: '2026-10-01T00:00:00.000Z',
        updated_at: '2026-10-02T00:00:00.000Z',
        values_hash: 'vh',
        modules: { brain: 'included', perf: 'excluded' },
        files: { 'Home.md': { template: 'Home.md', rendered_hash: 'h', ownership: 'modified' } },
      },
      installedAgo: '3 days ago',
      updatedAgo: '2 days ago',
      drift: {
        managed: 4,
        modified: 2,
        volatile: 1,
        missing: 1,
        orphaned: 1,
        modifiedPaths: ['Home.md', 'brain/Notes.md'],
        modifiedChanges: null,
        orphanedPaths: ['old.md'],
        missingPaths: ['gone.md'],
        truncated: false,
        failed: false,
      },
      update: { kind: 'available', current: '0.1.0', latest: '0.2.0', cacheAge: 'fresh' },
      modules: { included: ['brain'], excluded: ['perf'] },
      values: { valid: true, total: 4, invalidKeys: [], invalidCount: 0, fileMissing: false, checked: true },
      frontmatter: null,
      environment: null,
      warnings: [{ severity: 'info', message: 'v0.2.0 available', hint: "Run 'shardmind update'." }],
      ...overrides,
    };
  }

  it('answers installed: false for a directory that is not a managed vault', () => {
    expect(statusResult(null)).toEqual({ installed: false });
  });

  it('maps the installed vault without the display-only fields', () => {
    const out = statusResult(report());
    expect(out).toMatchObject({
      installed: true,
      shard: 'shardmind/minimal',
      source: 'github:acme/demo',
      version: '0.1.0',
      installedAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-02T00:00:00.000Z',
      update: { kind: 'available', current: '0.1.0', latest: '0.2.0', cacheAge: 'fresh' },
      modules: { included: ['brain'], excluded: ['perf'] },
      values: { valid: true, total: 4, invalidKeys: [], fileMissing: false },
      frontmatter: null,
      environment: null,
      warnings: [{ severity: 'info', message: 'v0.2.0 available', hint: "Run 'shardmind update'." }],
    });
    const json = JSON.stringify(out);
    // Relative times are a rendering of installedAt/updatedAt, and the
    // per-file state is engine bookkeeping; neither belongs in the document.
    expect(json).not.toContain('days ago');
    expect(json).not.toContain('rendered_hash');
    expect(out).not.toHaveProperty('ref');
  });

  it('lists every file bucket with its counts', () => {
    const out = statusResult(report());
    expect(out.installed && out.files).toEqual({
      counts: { managed: 4, modified: 2, volatile: 1, missing: 1, orphaned: 1 },
      modified: [{ path: 'Home.md' }, { path: 'brain/Notes.md' }],
      missing: ['gone.md'],
      orphaned: ['old.md'],
    });
  });

  it('adds line counts or the skip reason to each modified file under --verbose', () => {
    const base = report();
    const out = statusResult(
      report({
        drift: {
          ...base.drift,
          modifiedChanges: [
            { path: 'Home.md', linesAdded: 3, linesRemoved: 1 },
            { path: 'brain/Notes.md', skipped: true, reason: 'no-template' },
          ],
        },
      }),
    );
    expect(out.installed && out.files.modified).toEqual([
      { path: 'Home.md', linesAdded: 3, linesRemoved: 1 },
      { path: 'brain/Notes.md', diffSkipped: 'no-template' },
    ]);
  });

  it('sorts modified and missing by path, keeping each line count with its file', () => {
    const base = report();
    const out = statusResult(
      report({
        drift: {
          ...base.drift,
          // Drift lists these in state.json key order, not sorted.
          modifiedPaths: ['z.md', 'a.md'],
          modifiedChanges: [
            { path: 'z.md', linesAdded: 9, linesRemoved: 0 },
            { path: 'a.md', linesAdded: 1, linesRemoved: 2 },
          ],
          missingPaths: ['y.md', 'b.md'],
        },
      }),
    );
    expect(out.installed && out.files.modified).toEqual([
      { path: 'a.md', linesAdded: 1, linesRemoved: 2 },
      { path: 'z.md', linesAdded: 9, linesRemoved: 0 },
    ]);
    expect(out.installed && out.files.missing).toEqual(['b.md', 'y.md']);
  });

  it('gives files: null when drift detection failed, never a clean zero count', () => {
    const base = report();
    const out = statusResult(report({ drift: { ...base.drift, failed: true } }));
    expect(out.installed && out.files).toBeNull();
  });

  it('gives values.valid: null when the values could not be checked', () => {
    const base = report();
    const out = statusResult(
      report({ values: { ...base.values, valid: false, total: 0, checked: false } }),
    );
    expect(out.installed && out.values.valid).toBeNull();
    expect(out.installed && out.values.total).toBeNull();
  });

  it('sorts invalid value keys and frontmatter issues too', () => {
    const base = report();
    const out = statusResult(
      report({
        values: { ...base.values, valid: false, invalidKeys: ['z_key', 'a_key'], invalidCount: 2 },
        frontmatter: {
          valid: 1,
          total: 3,
          issues: [
            { path: 'z.md', missing: ['date'], noteType: null },
            { path: 'a.md', missing: ['title'], noteType: 'person' },
          ],
          issueCount: 2,
          truncated: false,
        },
      }),
    );
    expect(out.installed && out.values.invalidKeys).toEqual(['a_key', 'z_key']);
    expect(out.installed && out.frontmatter!.issues.map((i) => i.path)).toEqual(['a.md', 'z.md']);
  });

  it('reports the shard and version the human view shows, not raw state.json fields', () => {
    const base = report();
    // A hand-broken state.json; the manifest (cached, or synthesized from
    // state by the report) is what the header renders.
    const out = statusResult(
      report({ state: { ...base.state, version: '', shard: ' acme ' } }),
    );
    expect(out).toMatchObject({ version: '0.1.0', shard: 'shardmind/minimal' });
  });

  it('carries ref and resolvedSha for a #<ref> install', () => {
    const base = report();
    const out = statusResult(
      report({ state: { ...base.state, ref: 'main', resolvedSha: 'a'.repeat(40) } }),
    );
    expect(out).toMatchObject({ ref: 'main', resolvedSha: 'a'.repeat(40) });
  });
});
