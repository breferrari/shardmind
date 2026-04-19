/**
 * CRLF/LF robustness for the three-way merge. On Windows, a user's vault
 * file may be saved with CRLF; base/ours are renderer output (always LF).
 * Without normalization every line in `theirs` would trail with '\r' and
 * diff3 would report every line as different.
 */

import { describe, it, expect } from 'vitest';
import { threeWayMerge } from '../../source/core/differ.js';

describe('threeWayMerge — line ending robustness', () => {
  it('treats CRLF theirs as identical to LF base/ours when content matches', () => {
    const base = '# Title\n\nLine one.\nLine two.\n';
    const ours = '# Title\n\nLine one.\nLine two.\n';
    const theirs = base.replace(/\n/g, '\r\n');

    const result = threeWayMerge(base, theirs, ours);

    expect(result.conflicts).toHaveLength(0);
    expect(result.stats.linesConflicted).toBe(0);
  });

  it('detects a real conflict even when theirs uses CRLF', () => {
    const base = '# Title\n\nOriginal body.\n';
    const ours = '# Title\n\nShard-updated body.\n';
    const theirs = '# Title\r\n\r\nUser-edited body.\r\n';

    const result = threeWayMerge(base, theirs, ours);

    expect(result.conflicts).toHaveLength(1);
    expect(result.content).toContain('<<<<<<< yours');
    expect(result.content).not.toContain('\r');
  });
});
