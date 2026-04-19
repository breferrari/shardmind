/**
 * Direct unit tests for the primitive `threeWayMerge`. The fixture suite in
 * drift.test.ts exercises `computeMergeAction` end-to-end; these tests pin
 * down the internal stats accounting and region classification that
 * fixtures don't inspect directly.
 */

import { describe, it, expect } from 'vitest';
import { threeWayMerge } from '../../source/core/differ.js';

describe('threeWayMerge — stats accounting', () => {
  it('counts every unchanged line when base === theirs === ours', () => {
    const text = 'alpha\nbeta\ngamma\n';
    const result = threeWayMerge(text, text, text);

    expect(result.conflicts).toHaveLength(0);
    expect(result.stats.linesUnchanged).toBeGreaterThanOrEqual(3);
    expect(result.stats.linesAutoMerged).toBe(0);
    expect(result.stats.linesConflicted).toBe(0);
    expect(result.content).toBe(text);
  });

  it('records auto-merged lines when only one side diverges from base', () => {
    const base = 'alpha\nbeta\ngamma\n';
    const theirs = 'alpha\nbeta\ngamma\n';
    const ours = 'alpha\nBETA\ngamma\n';

    const result = threeWayMerge(base, theirs, ours);

    expect(result.conflicts).toHaveLength(0);
    expect(result.stats.linesAutoMerged).toBeGreaterThan(0);
    expect(result.stats.linesConflicted).toBe(0);
    expect(result.content).toBe('alpha\nBETA\ngamma\n');
  });

  it('honors a user addition that the shard did not touch', () => {
    const base = '# Notes\n\nLine 1.\n';
    const ours = '# Notes\n\nLine 1.\n';
    const theirs = '# Notes\n\nLine 1.\n\n## Personal\nMy note.\n';

    const result = threeWayMerge(base, theirs, ours);

    expect(result.conflicts).toHaveLength(0);
    expect(result.content).toContain('## Personal');
    expect(result.stats.linesConflicted).toBe(0);
  });

  it('reports a conflict with correct line range and content snapshots', () => {
    const base = '# Title\n\nOriginal body.\n';
    const theirs = '# Title\n\nUser body.\n';
    const ours = '# Title\n\nShard body.\n';

    const result = threeWayMerge(base, theirs, ours);

    expect(result.conflicts).toHaveLength(1);
    const [conflict] = result.conflicts;
    expect(conflict).toBeDefined();
    expect(conflict!.theirs).toBe('User body.');
    expect(conflict!.ours).toBe('Shard body.');
    expect(conflict!.base).toBe('Original body.');
    expect(conflict!.lineStart).toBeGreaterThan(0);
    expect(conflict!.lineEnd).toBeGreaterThan(conflict!.lineStart);
    expect(result.stats.linesConflicted).toBeGreaterThan(0);
  });

  it('treats identical divergence (false conflict) as auto-merge', () => {
    const base = 'alpha\nbeta\n';
    const theirs = 'alpha\nBETA\n';
    const ours = 'alpha\nBETA\n';

    const result = threeWayMerge(base, theirs, ours);

    expect(result.conflicts).toHaveLength(0);
    expect(result.content).toBe('alpha\nBETA\n');
    expect(result.stats.linesConflicted).toBe(0);
  });

  it('produces two conflict regions when disagreements are non-adjacent', () => {
    const base = 'shared-a\nbase-x\nshared-b\nbase-y\nshared-c\n';
    const theirs = 'shared-a\ntheirs-x\nshared-b\ntheirs-y\nshared-c\n';
    const ours = 'shared-a\nours-x\nshared-b\nours-y\nshared-c\n';

    const result = threeWayMerge(base, theirs, ours);

    expect(result.conflicts).toHaveLength(2);
    expect(result.conflicts[0]!.lineEnd).toBeLessThan(result.conflicts[1]!.lineStart);
  });
});
