/**
 * Three identical inputs merge without running diff3 (#114). node-diff3's
 * LCS slows toward cubic time on inputs with many repeated lines, so a
 * 10K-line file of 100 distinct lines took seconds to merge with itself.
 * The shortcut must not change any merge: these properties compare
 * `mergeRegions` with node-diff3 on the same inputs.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { diff3MergeRegions, type IRegion } from 'node-diff3';
import { mergeRegions, threeWayMerge } from '../../source/core/differ.js';

/**
 * Regions as what they say, not where: stable runs from the same buffer
 * joined, unstable regions as their three sides.
 */
function canonical(regions: IRegion<string>[]): unknown[] {
  const out: unknown[] = [];
  for (const r of regions) {
    if (r.stable) {
      const prev = out[out.length - 1] as { stable: true; buffer: string; lines: string[] } | undefined;
      if (prev && prev.stable && prev.buffer === r.buffer) prev.lines.push(...r.bufferContent);
      else out.push({ stable: true, buffer: r.buffer, lines: [...r.bufferContent] });
    } else {
      out.push({ stable: false, a: r.aContent, o: r.oContent, b: r.bContent });
    }
  }
  return out;
}

// Few distinct lines, so repeats and identical inputs are common.
const doc = fc.array(fc.constantFrom('x', 'y', 'z', ''), { maxLength: 14 });

describe('mergeRegions (#114)', () => {
  it('gives the same regions as diff3', () => {
    fc.assert(
      fc.property(doc, doc, doc, (a, o, b) => {
        expect(canonical(mergeRegions(a, o, b))).toEqual(canonical(diff3MergeRegions(a, o, b)));
      }),
      { numRuns: 2000 },
    );
  });

  it('gives the same regions as diff3 when all three are identical', () => {
    fc.assert(
      fc.property(doc, (o) => {
        expect(canonical(mergeRegions([...o], o, [...o]))).toEqual(canonical(diff3MergeRegions([...o], o, [...o])));
      }),
      { numRuns: 500 },
    );
  });

  it('merges 10K repeated identical lines quickly', () => {
    const content = Array.from({ length: 10_000 }, (_, i) => `line-${i % 100}`).join('\n') + '\n';
    const start = performance.now();
    const result = threeWayMerge(content, content, content);
    // A loose bound: through diff3 this took seconds; the shortcut takes milliseconds.
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(result.content).toBe(content);
    expect(result.stats).toEqual({ linesUnchanged: 10_000, linesAutoMerged: 0, linesConflicted: 0 });
  });

  // Trimming the shared prefix and suffix before diffing would be faster in
  // general, and was rejected: with repeated lines it changes the alignment
  // diff3 picks, and this clean merge became a conflict.
  it('keeps a clean merge clean where trimming the shared suffix would not', () => {
    const result = threeWayMerge('y\ny', 'x\ny', 'y');
    expect(result.content).toBe('x\ny');
    expect(result.conflicts).toEqual([]);
  });
});
