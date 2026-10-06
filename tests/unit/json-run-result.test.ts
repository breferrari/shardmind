/**
 * The result document of a real `update --json` / `adopt --json` run
 * (#348): each file's outcome is a pure function of what the plan said and
 * how it was resolved. Spec: OPERATIONS §--json runs.
 */

import { describe, it, expect } from 'vitest';
import {
  adoptRunResult,
  updateOutcome,
  updateRunResult,
  upToDateRunResult,
} from '../../source/core/json-output.js';
import { emptyUpdatePlanCounts, type UpdateAction, type UpdatePlan } from '../../source/core/update-planner.js';
import type { UpdateSummary } from '../../source/core/update-executor.js';
import type { AdoptSummary } from '../../source/core/adopt-executor.js';
import type { AdoptClassification, AdoptPlan } from '../../source/core/adopt-planner.js';
import type { HookOutcome } from '../../source/core/hook-orchestrator.js';

const act = (kind: UpdateAction['kind'], path: string, extra: Record<string, unknown> = {}) =>
  ({ kind, path, renderedHash: `r-${path}`, baselineHash: `b-${path}`, newContentHash: `n-${path}`, theirsHash: `t-${path}`, reason: 'identical', result: { content: '', conflicts: [], stats: {} }, ...extra }) as unknown as UpdateAction;

function summary(over: Partial<UpdateSummary> = {}): UpdateSummary {
  return {
    fromVersion: '1.0.0',
    toVersion: '2.0.0',
    counts: emptyUpdatePlanCounts(),
    conflictsResolved: 0,
    conflictsKeptMine: 0,
    conflictsSkipped: 0,
    conflictsAcceptedNew: 0,
    conflictsEdited: 0,
    autoMergeStats: { linesUnchanged: 0, linesAutoMerged: 0, linesConflicted: 0 },
    wroteFiles: [],
    deletedFiles: [],
    addedFiles: [],
    replacedFiles: [],
    keptUntracked: [],
    renamedFiles: [],
    ...over,
  } as UpdateSummary;
}

const plan = (actions: UpdateAction[]): UpdatePlan => ({ actions, pendingConflicts: [], counts: emptyUpdatePlanCounts() }) as UpdatePlan;

describe('updateOutcome (#348)', () => {
  it.each([
    ['add', 'written'],
    ['overwrite', 'replaced'],
    ['auto_merge', 'merged'],
    ['restore_missing', 'restored'],
    ['keep_as_user', 'kept'],
    ['delete', 'deleted'],
    ['noop', 'unchanged'],
    ['skip_volatile', 'unchanged'],
  ] as const)('%s is %s', (kind, outcome) => {
    expect(updateOutcome(act(kind, 'a.md'), undefined, new Set())).toBe(outcome);
  });

  it('a conflict is kept, replaced, merged or kept-untracked by its resolution', () => {
    const c = act('conflict', 'c.md');
    expect(updateOutcome(c, 'keep_mine', new Set())).toBe('kept');
    expect(updateOutcome(c, 'skip', new Set())).toBe('kept');
    expect(updateOutcome(c, 'keep_and_track', new Set())).toBe('kept');
    expect(updateOutcome(c, 'accept_new', new Set())).toBe('replaced');
    expect(updateOutcome(c, { kind: 'edited', content: 'x' }, new Set())).toBe('merged');
    expect(updateOutcome(c, 'keep_mine', new Set(['c.md']))).toBe('kept-untracked');
  });

  it('a conflict with no resolution is a bug, never a silent outcome', () => {
    expect(() => updateOutcome(act('conflict', 'c.md'), undefined, new Set())).toThrow(/no resolution/);
  });
});

describe('updateRunResult (#348)', () => {
  it('lists every planned path once, sorted, with its outcome and the headless conflict marked', () => {
    const doc = updateRunResult({
      plan: plan([act('overwrite', 'z.md'), act('conflict', 'b.md'), act('add', 'a.md', { renamedFrom: 'old/a.md' })]),
      resolutions: { 'b.md': 'keep_mine' },
      summary: summary(),
      hooks: [],
      backupDir: '.shardmind/backups/update-1',
      migrationWarnings: ['renamed x'],
      externalTools: [],
      durationMs: 12,
    });
    expect(doc).toMatchObject({ dryRun: false, fromVersion: '1.0.0', toVersion: '2.0.0', backupDir: '.shardmind/backups/update-1', durationMs: 12 });
    expect(doc.files).toEqual([
      { path: 'a.md', outcome: 'written', shardHash: 'r-a.md', renamedFrom: 'old/a.md' },
      { path: 'b.md', outcome: 'kept', shardHash: 'n-b.md', userHash: 't-b.md', conflict: { resolution: 'keep_mine', by: 'json-default' } },
      { path: 'z.md', outcome: 'replaced', shardHash: 'r-z.md' },
    ]);
    expect(doc.warnings.migrations).toEqual(['renamed x']);
  });

  it('marks an up-to-date vault, with nothing written', () => {
    expect(upToDateRunResult('3.1.0')).toMatchObject({ dryRun: false, upToDate: true, fromVersion: '3.1.0', toVersion: '3.1.0', files: [], backupDir: null });
  });

  it('reports each hook as completed, failed (with its first line) or skipped, and leaves absent and deferred ones out', () => {
    const hooks: HookOutcome[] = [
      { slot: 'bootstrap', summary: { exitCode: 0, stdout: 'ok', stderr: '', logPath: '.shardmind/logs/bootstrap.log' } },
      { slot: 'personalize', summary: { skipped: 'values-are-defaults' } },
      { slot: 'post-update', summary: { exitCode: 1, stderr: '\nhook timed out after 60s\nmore' } },
      { slot: 'post-install', summary: null },
      { slot: 'post-update', summary: { deferred: true } },
    ] as unknown as HookOutcome[];
    const doc = updateRunResult({ plan: plan([]), resolutions: {}, summary: summary(), hooks, backupDir: null, migrationWarnings: [], externalTools: [], durationMs: 0 });
    expect(doc.hooks).toEqual([
      { slot: 'bootstrap', outcome: 'completed', exitCode: 0, log: '.shardmind/logs/bootstrap.log' },
      { slot: 'personalize', outcome: 'skipped' },
      { slot: 'post-update', outcome: 'failed', exitCode: 1, message: 'hook timed out after 60s' },
    ]);
  });

  it('turns a hook boundary violation into a warning', () => {
    const hooks = [{ slot: 'personalize', summary: { exitCode: 0, violation: { kind: 'unmanaged-create', paths: ['x.md', 'y.md'] } } }] as unknown as HookOutcome[];
    const doc = updateRunResult({ plan: plan([]), resolutions: {}, summary: summary(), hooks, backupDir: null, migrationWarnings: [], externalTools: [], durationMs: 0 });
    expect(doc.warnings.hookBoundary).toEqual(['personalize: unmanaged-create x.md, y.md']);
  });
});

const entry = (kind: AdoptClassification['kind'], path: string) =>
  ({ kind, path, shardHash: `s-${path}`, userHash: `u-${path}`, volatile: false, shardContent: Buffer.from('s'), userContent: Buffer.from('u'), isBinary: false }) as unknown as AdoptClassification;

function adoptPlan(): AdoptPlan {
  return {
    matches: [entry('matches', 'm.md')],
    differs: [entry('differs', 'd1.md'), entry('differs', 'd2.md')],
    behind: [entry('differs', 'b.md')],
    shardOnly: [entry('shard-only', 'n.md')],
    totalShardFiles: 5,
  };
}

const adoptSummary = {} as AdoptSummary;

describe('adoptRunResult (#348)', () => {
  it('maps each classification and resolution to its outcome, with counts that agree', () => {
    const doc = adoptRunResult({
      plan: adoptPlan(),
      resolutions: { 'd1.md': 'keep_mine', 'd2.md': 'use_shard' },
      mode: 'keep-all-mine',
      modeGiven: false,
      version: '9.0.1',
      summary: adoptSummary,
      hooks: [],
      backupDir: '.shardmind/backups/adopt-1',
      externalTools: [],
      durationMs: 5,
    });
    expect(doc.files.map((f) => [f.path, f.outcome])).toEqual([
      ['b.md', 'updated-behind'],
      ['d1.md', 'kept-mine'],
      ['d2.md', 'used-shard'],
      ['m.md', 'matched'],
      ['n.md', 'installed'],
    ]);
    expect(doc.counts).toEqual({ matched: 1, keptMine: 1, usedShard: 1, merged: 0, updatedBehind: 1, installed: 1, total: 5 });
    expect(doc.warnings.experimental).toEqual([]);
  });

  it('says who decided: the headless default with no --mode, the mode when one was given', () => {
    const run = (modeGiven: boolean, mode: string) =>
      adoptRunResult({ plan: adoptPlan(), resolutions: { 'd1.md': 'keep_mine', 'd2.md': 'keep_mine' }, mode, modeGiven, version: '1', summary: adoptSummary, hooks: [], backupDir: null, externalTools: [], durationMs: 0 });
    expect(run(false, 'keep-all-mine').files.find((f) => f.path === 'd1.md')!.conflict).toEqual({ resolution: 'keep_mine', by: 'json-default' });
    expect(run(true, 'keep-all-mine').files.find((f) => f.path === 'd1.md')!.conflict).toEqual({ resolution: 'keep_mine', by: 'mode' });
  });

  it('under auto-merge: a merged file is the mode’s, a conflicting one kept by the headless rule; the experimental warning is set', () => {
    const doc = adoptRunResult({
      plan: adoptPlan(),
      resolutions: { 'd1.md': { kind: 'merged', content: Buffer.from('x'), hash: 'h' }, 'd2.md': 'keep_mine' },
      mode: 'auto-merge',
      modeGiven: true,
      version: '1',
      summary: adoptSummary,
      hooks: [],
      backupDir: null,
      externalTools: [],
      durationMs: 0,
    });
    expect(doc.files.find((f) => f.path === 'd1.md')).toMatchObject({ outcome: 'merged', conflict: { resolution: 'merged', by: 'mode' } });
    expect(doc.files.find((f) => f.path === 'd2.md')).toMatchObject({ outcome: 'kept-mine', conflict: { resolution: 'keep_mine', by: 'json-default' } });
    expect(doc.warnings.experimental).toEqual(['adopt --mode auto-merge']);
  });

  it('a differing file with no resolution is a bug', () => {
    expect(() =>
      adoptRunResult({ plan: adoptPlan(), resolutions: {}, mode: null, modeGiven: false, version: '1', summary: adoptSummary, hooks: [], backupDir: null, externalTools: [], durationMs: 0 }),
    ).toThrow(/no resolution/);
  });
});
