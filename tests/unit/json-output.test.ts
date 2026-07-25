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
  updatePlanResult,
} from '../../source/core/json-output.js';
import { ShardMindError } from '../../source/runtime/types.js';
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
    expect(env.error).toEqual({ code: 'ADOPT_WRITE_FAILED', message: 'boom', hint: 'try this' });
    expect(env.result).toBeUndefined();
  });

  it('degrades a plain Error to a null code rather than inventing one', () => {
    const env = jsonFailure('update', new Error('kaboom'));
    expect(env.error).toEqual({ code: null, message: 'kaboom', hint: null });
  });

  it('survives a non-Error throw', () => {
    expect(jsonFailure('update', 'a string').error?.message).toBe('a string');
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
});
