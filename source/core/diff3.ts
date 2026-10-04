/**
 * `diff3MergeRegions`, ported from node-diff3 3.2.1 with an LCS that stays
 * fast when lines repeat (#170). Every region is identical to node-diff3's:
 * `tests/unit/diff3.test.ts` holds it to node-diff3 itself.
 *
 * The one change is in `lcs`. node-diff3 finds each match's slot among the
 * candidates by a linear scan from `r`, and a match that finds no slot
 * leaves `r` where it was, so the next match rescans the same stretch. That
 * is cubic with repeated lines: 4,000 lines of 100 distinct took 294 ms, and
 * 10,000 about 4.5 s. The candidates at positions >= `r` are the previous
 * row's thresholds, whose `buffer2index` strictly increases, so the slot is
 * the largest `s >= r` with `buffer2index < j`, taken only when the next
 * candidate's `buffer2index > j`. A binary search finds that same `s`.
 *
 * One smaller change leaves the output as it was: the sorted hunks are
 * walked by index rather than `shift()`ed. Everything else is node-diff3's
 * code, typed. When node-diff3's LCS stops rescanning, this file can go back
 * to importing it. Its licence:
 *
 * The MIT License (MIT)
 *
 * diff function extracted from Project Synchrotron.
 *
 * Copyright (c) 2006, 2008 Tony Garnock-Jones <tonyg@lshift.net>
 * Copyright (c) 2006, 2008 LShift Ltd. <query@lshift.net>
 * Copyright (c) 2019-2026 Bryan Housel <bhousel@gmail.com>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to permit
 * persons to whom the Software is furnished to do so, subject to the
 * following conditions:
 *
 * The above copyright notice and this permission notice shall be included
 * in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
 * OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
 * NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 * OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
 * USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

import type { IRegion } from 'node-diff3';

interface Candidate {
  buffer1index: number;
  buffer2index: number;
  chain: Candidate | null;
}

interface DiffIndex {
  buffer1: [number, number];
  buffer2: [number, number];
}

interface Hunk {
  ab: 'a' | 'b';
  oStart: number;
  oLength: number;
  abStart: number;
  abLength: number;
}

const NO_MATCHES: readonly number[] = [];

function lcs(buffer1: readonly string[], buffer2: readonly string[]): Candidate {
  // A null-prototype map: a line such as `__proto__` or `constructor` is a
  // plain key, as in node-diff3 >= 3.2.1 (bhousel/node-diff3#86).
  const equivalenceClasses: Record<string, number[]> = Object.create(null);
  for (let j = 0; j < buffer2.length; j++) {
    const item = buffer2[j]!;
    const known = equivalenceClasses[item];
    if (known) known.push(j);
    else equivalenceClasses[item] = [j];
  }

  const NULLRESULT: Candidate = { buffer1index: -1, buffer2index: -1, chain: null };
  const candidates: Candidate[] = [NULLRESULT];

  for (let i = 0; i < buffer1.length; i++) {
    const buffer2indices = equivalenceClasses[buffer1[i]!] ?? NO_MATCHES;
    let r = 0;
    let c = candidates[0]!;

    for (const j of buffer2indices) {
      const s = slotFor(candidates, r, j);
      if (s !== -1) {
        const newCandidate: Candidate = { buffer1index: i, buffer2index: j, chain: candidates[s]! };
        if (r === candidates.length) candidates.push(c);
        else candidates[r] = c;
        r = s + 1;
        c = newCandidate;
        if (r === candidates.length) break;
      }
    }

    candidates[r] = c;
  }

  return candidates[candidates.length - 1]!;
}

/**
 * The slot node-diff3's linear scan finds: the first `s >= r` with
 * `candidates[s].buffer2index < j` and the next candidate's `> j` (or none
 * next). Positions >= `r` strictly increase in `buffer2index`, so only the
 * largest `s` with `buffer2index < j` can qualify. -1 when none does.
 */
function slotFor(candidates: readonly Candidate[], r: number, j: number): number {
  let lo = r;
  let hi = candidates.length - 1;
  let s = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (candidates[mid]!.buffer2index < j) {
      s = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (s === -1) return -1;
  return s === candidates.length - 1 || candidates[s + 1]!.buffer2index > j ? s : -1;
}

function diffIndices(buffer1: readonly string[], buffer2: readonly string[]): DiffIndex[] {
  const result: DiffIndex[] = [];
  let tail1 = buffer1.length;
  let tail2 = buffer2.length;

  for (let candidate: Candidate | null = lcs(buffer1, buffer2); candidate !== null; candidate = candidate.chain) {
    const mismatchLength1 = tail1 - candidate.buffer1index - 1;
    const mismatchLength2 = tail2 - candidate.buffer2index - 1;
    tail1 = candidate.buffer1index;
    tail2 = candidate.buffer2index;
    if (mismatchLength1 || mismatchLength2) {
      result.push({ buffer1: [tail1 + 1, mismatchLength1], buffer2: [tail2 + 1, mismatchLength2] });
    }
  }

  result.reverse();
  return result;
}

/** node-diff3's `diff3MergeRegions(a, o, b)`, region for region. */
export function diff3MergeRegions(a: string[], o: string[], b: string[]): IRegion<string>[] {
  const hunks: Hunk[] = [];
  const addHunk = (h: DiffIndex, ab: 'a' | 'b'): void => {
    hunks.push({ ab, oStart: h.buffer1[0], oLength: h.buffer1[1], abStart: h.buffer2[0], abLength: h.buffer2[1] });
  };
  diffIndices(o, a).forEach((item) => addHunk(item, 'a'));
  diffIndices(o, b).forEach((item) => addHunk(item, 'b'));
  hunks.sort((x, y) => x.oStart - y.oStart);

  const results: IRegion<string>[] = [];
  let currOffset = 0;

  const advanceTo = (endOffset: number): void => {
    if (endOffset > currOffset) {
      results.push({
        stable: true,
        buffer: 'o',
        bufferStart: currOffset,
        bufferLength: endOffset - currOffset,
        bufferContent: o.slice(currOffset, endOffset),
      });
      currOffset = endOffset;
    }
  };

  // An index into the sorted hunks, where node-diff3 shifts the array (the
  // same order, without a quadratic shift).
  let next = 0;
  while (next < hunks.length) {
    let hunk = hunks[next++]!;
    const regionStart = hunk.oStart;
    let regionEnd = hunk.oStart + hunk.oLength;
    const regionHunks: Hunk[] = [hunk];
    advanceTo(regionStart);

    while (next < hunks.length) {
      const nextHunk = hunks[next]!;
      const nextHunkStart = nextHunk.oStart;
      if (nextHunkStart > regionEnd) break;
      regionEnd = Math.max(regionEnd, nextHunkStart + nextHunk.oLength);
      regionHunks.push(hunks[next++]!);
    }

    if (regionHunks.length === 1) {
      if (hunk.abLength > 0) {
        const buffer = hunk.ab === 'a' ? a : b;
        results.push({
          stable: true,
          buffer: hunk.ab,
          bufferStart: hunk.abStart,
          bufferLength: hunk.abLength,
          bufferContent: buffer.slice(hunk.abStart, hunk.abStart + hunk.abLength),
        });
      }
    } else {
      const bounds = {
        a: [a.length, -1, o.length, -1],
        b: [b.length, -1, o.length, -1],
      };
      for (hunk of regionHunks) {
        const oStart = hunk.oStart;
        const oEnd = oStart + hunk.oLength;
        const abStart = hunk.abStart;
        const abEnd = abStart + hunk.abLength;
        const b2 = bounds[hunk.ab];
        b2[0] = Math.min(abStart, b2[0]!);
        b2[1] = Math.max(abEnd, b2[1]!);
        b2[2] = Math.min(oStart, b2[2]!);
        b2[3] = Math.max(oEnd, b2[3]!);
      }

      const aStart = bounds.a[0]! + (regionStart - bounds.a[2]!);
      const aEnd = bounds.a[1]! + (regionEnd - bounds.a[3]!);
      const bStart = bounds.b[0]! + (regionStart - bounds.b[2]!);
      const bEnd = bounds.b[1]! + (regionEnd - bounds.b[3]!);

      results.push({
        stable: false,
        aStart,
        aLength: aEnd - aStart,
        aContent: a.slice(aStart, aEnd),
        oStart: regionStart,
        oLength: regionEnd - regionStart,
        oContent: o.slice(regionStart, regionEnd),
        bStart,
        bLength: bEnd - bStart,
        bContent: b.slice(bStart, bEnd),
      });
    }

    currOffset = regionEnd;
  }

  advanceTo(o.length);
  return results;
}
