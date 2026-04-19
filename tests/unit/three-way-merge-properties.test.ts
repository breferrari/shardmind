/**
 * Property-based invariants for `threeWayMerge`.
 *
 * Fixture tests prove the engine works on hand-authored cases; these tests
 * prove it satisfies mathematical invariants across the space of possible
 * inputs. When a fixture regresses, you learn one thing broke. When a
 * property regresses, you learn the whole class of inputs that trigger it.
 *
 * Invariants pinned down here:
 *   1. Identity: threeWayMerge(x, x, x) is x, with no conflicts.
 *   2. "Theirs only" auto-merge: base === ours ⇒ result is theirs.
 *   3. "Ours only" auto-merge: base === theirs ⇒ result is ours.
 *   4. False-conflict resolution: theirs === ours ⇒ result is theirs, no conflicts.
 *   5. No spurious conflicts when base/ours are LF and theirs is CRLF of the same content.
 *   6. Stats conservation: linesUnchanged + linesAutoMerged + linesConflicted <= total emitted lines.
 *      (strict ≤ because conflicts emit marker lines that aren't counted in linesConflicted.)
 */

import { describe, it } from 'vitest';
import fc from 'fast-check';
import { threeWayMerge } from '../../source/core/differ.js';

/**
 * Arbitrary that generates short, multi-line text. Constrained to printable
 * ASCII plus LF; no CR (CR is tested explicitly in invariant 5), no trailing
 * whitespace games. Empty documents included.
 */
const multilineText = fc
  .array(
    fc.string({
      unit: fc.constantFrom(...' abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-_#'),
      minLength: 0,
      maxLength: 30,
    }),
    { minLength: 0, maxLength: 12 },
  )
  .map(lines => lines.join('\n'));

describe('threeWayMerge — property-based invariants', () => {
  it('identity: merge(x, x, x) produces x with no conflicts', () => {
    fc.assert(
      fc.property(multilineText, x => {
        const result = threeWayMerge(x, x, x);
        return (
          result.content === x &&
          result.conflicts.length === 0 &&
          result.stats.linesConflicted === 0
        );
      }),
      { numRuns: 200 },
    );
  });

  it('theirs only: base === ours ⇒ merged content equals theirs', () => {
    fc.assert(
      fc.property(multilineText, multilineText, (theirs, baseAndOurs) => {
        const result = threeWayMerge(baseAndOurs, theirs, baseAndOurs);
        return result.content === theirs && result.stats.linesConflicted === 0;
      }),
      { numRuns: 200 },
    );
  });

  it('ours only: base === theirs ⇒ merged content equals ours', () => {
    fc.assert(
      fc.property(multilineText, multilineText, (baseAndTheirs, ours) => {
        const result = threeWayMerge(baseAndTheirs, baseAndTheirs, ours);
        return result.content === ours && result.stats.linesConflicted === 0;
      }),
      { numRuns: 200 },
    );
  });

  it('false conflict: theirs === ours ⇒ merged content equals theirs, no conflicts', () => {
    fc.assert(
      fc.property(multilineText, multilineText, (base, theirsAndOurs) => {
        const result = threeWayMerge(base, theirsAndOurs, theirsAndOurs);
        return result.content === theirsAndOurs && result.conflicts.length === 0;
      }),
      { numRuns: 200 },
    );
  });

  it('CRLF theirs against LF base/ours produces no extra conflicts vs LF theirs', () => {
    fc.assert(
      fc.property(multilineText, multilineText, multilineText, (base, theirs, ours) => {
        const lfResult = threeWayMerge(base, theirs, ours);
        const crlfTheirs = theirs.replace(/\n/g, '\r\n');
        const crlfResult = threeWayMerge(base, crlfTheirs, ours);
        return crlfResult.conflicts.length === lfResult.conflicts.length;
      }),
      { numRuns: 200 },
    );
  });

  it('stats bookkeeping: stat totals never exceed content line count', () => {
    fc.assert(
      fc.property(multilineText, multilineText, multilineText, (base, theirs, ours) => {
        const result = threeWayMerge(base, theirs, ours);
        const emittedLines = result.content.split('\n').length;
        const { linesUnchanged, linesAutoMerged, linesConflicted } = result.stats;
        // Conflict markers (<<<<<<< / ======= / >>>>>>> ) inflate emitted
        // lines beyond what stats track, so strict ≤ rather than equality.
        return linesUnchanged + linesAutoMerged + linesConflicted <= emittedLines;
      }),
      { numRuns: 200 },
    );
  });
});
