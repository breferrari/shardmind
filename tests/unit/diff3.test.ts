/**
 * core/diff3.ts (#170): node-diff3's diff3MergeRegions with an LCS that
 * stays fast when lines repeat. node-diff3 itself is the oracle: every
 * region must be identical, since a different alignment would change what
 * an update merges.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { diff3MergeRegions as oracle } from 'node-diff3';
import { diff3MergeRegions } from '../../source/core/diff3.js';

/** Lines from a small alphabet, so most of them repeat. */
const lines = (alphabet: string[], maxLength: number) =>
  fc.array(fc.constantFrom(...alphabet), { maxLength });

/** 150 to 400 lines: fast-check's default size would keep them short. */
const long = () => fc.array(fc.constantFrom('x', 'y', 'z', 'w', 'v', ''), { minLength: 150, maxLength: 400 });

function same(a: string[], o: string[], b: string[]): void {
  expect(diff3MergeRegions(a, o, b)).toEqual(oracle(a, o, b));
}

describe('diff3MergeRegions (#170)', () => {
  it('returns the regions node-diff3 returns, for random inputs heavy with repeats', () => {
    fc.assert(
      fc.property(lines(['x', 'y', 'z', ''], 40), lines(['x', 'y', 'z', ''], 40), lines(['x', 'y', 'z', ''], 40), (a, o, b) => {
        same(a, o, b);
      }),
      { numRuns: 3000 },
    );
  });

  it('returns the same regions when a and b are edits of o, as in an update', () => {
    const edits = (o: string[]) =>
      fc
        .array(fc.tuple(fc.nat(), fc.constantFrom('insert', 'delete', 'replace'), fc.constantFrom('x', 'y', 'q', '')), { maxLength: 6 })
        .map((ops) => {
          const out = [...o];
          for (const [at, op, line] of ops) {
            const i = out.length === 0 ? 0 : at % (out.length + (op === 'insert' ? 1 : 0));
            if (op === 'insert') out.splice(i, 0, line);
            else if (out.length > 0 && op === 'delete') out.splice(i % out.length, 1);
            else if (out.length > 0) out[i % out.length] = line;
          }
          return out;
        });
    fc.assert(
      fc.property(
        lines(['x', 'y', 'z', 'w', ''], 60).chain((o) => fc.tuple(fc.constant(o), edits(o), edits(o))),
        ([o, a, b]) => {
          same(a, o, b);
        },
      ),
      { numRuns: 3000 },
    );
  });

  it('returns the regions node-diff3 returns for longer inputs, where the slot search runs deep', () => {
    // Hundreds of candidates, so the binary search takes many steps.
    fc.assert(
      fc.property(long(), long(), long(), (a, o, b) => {
        same(a, o, b);
      }),
      { numRuns: 60 },
    );
  });

  it('keeps the alignments that repeats make ambiguous (#114)', () => {
    same(['x', 'y'], ['y', 'y'], ['y']);
    same(['y'], ['y', 'y'], ['x', 'y']);
    same([], [], []);
    same(['a'], [], ['b']);
    same(['', ''], [''], ['', '', '']);
  });

  it('keys lines by content safely: a line named like an Object.prototype key', () => {
    same(['constructor', 'toString', '__proto__'], ['__proto__', 'constructor'], ['hasOwnProperty', 'constructor']);
  });

  it('merges 32,000 repeat-heavy lines edited on both sides within the test timeout', () => {
    // No wall-clock assertion: the bound is the test timeout. The port takes
    // about half a second here; node-diff3's cubic LCS would take minutes, so
    // a regression fails by far, and a loaded runner does not (#114, #170).
    const o: string[] = [];
    for (let i = 0; i < 32000; i++) o.push(`row ${i % 100}`);
    const a = [...o];
    a[9600] = 'user edit';
    const b = [...o];
    b[22400] = 'shard edit';
    const regions = diff3MergeRegions(a, o, b);
    expect(regions.some((r) => r.stable && r.buffer === 'a')).toBe(true);
    expect(regions.some((r) => r.stable && r.buffer === 'b')).toBe(true);
  }, 20_000);

  it('matches node-diff3 at 4,000 repeat-heavy lines, the scale where the change matters', () => {
    const o: string[] = [];
    for (let i = 0; i < 4000; i++) o.push(`row ${i % 100}`);
    const a = [...o];
    a[1200] = 'user edit';
    a.splice(3000, 0, 'row 7', 'row 8');
    const b = [...o];
    b[2800] = 'shard edit';
    b.splice(500, 3);
    same(a, o, b);
  });

  it('matches node-diff3 when every line is the same, one huge equivalence class', () => {
    const o = Array.from({ length: 600 }, () => '');
    const a = [...o];
    a.splice(150, 0, 'user edit');
    const b = [...o];
    b[450] = 'shard edit';
    b.splice(10, 2);
    same(a, o, b);
  });

  it('matches node-diff3 on the same repeat-heavy shape at a size the oracle handles quickly', () => {
    const o: string[] = [];
    for (let i = 0; i < 1500; i++) o.push(`row ${i % 100}`);
    const a = [...o];
    a[450] = 'user edit';
    a.splice(900, 0, 'row 3');
    const b = [...o];
    b[1050] = 'shard edit';
    b.splice(100, 5);
    same(a, o, b);
  });
});
