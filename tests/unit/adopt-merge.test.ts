import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { twoWayUnionMerge } from '../../source/core/adopt-merge.js';

const buf = (s: string) => Buffer.from(s, 'utf8');

describe('twoWayUnionMerge', () => {
  it('identical content → no conflict, content unchanged', () => {
    const s = 'line1\nline2\n';
    const r = twoWayUnionMerge(buf(s), buf(s), false);
    expect(r.hasConflict).toBe(false);
    expect(r.content.toString('utf8')).toBe(s);
  });

  it('pure shard insertion → union takes the shard line, no conflict', () => {
    const user = 'line1\nline2\n';
    const shard = 'line1\ninserted\nline2\n';
    const r = twoWayUnionMerge(buf(user), buf(shard), false);
    expect(r.hasConflict).toBe(false);
    expect(r.content.toString('utf8')).toBe(shard);
  });

  it('pure user-only line (shard deleted it) → union KEEPS the user line, no conflict', () => {
    // Demonstrates the documented limitation: without a base, a shard
    // deletion is indistinguishable from a user-unique line, so it is kept.
    const user = 'line1\nmine\nline2\n';
    const shard = 'line1\nline2\n';
    const r = twoWayUnionMerge(buf(user), buf(shard), false);
    expect(r.hasConflict).toBe(false);
    expect(r.content.toString('utf8')).toBe(user);
  });

  it('non-overlapping edits on both sides → union of both, no conflict', () => {
    const user = 'header\nmine\nfooter\n';
    const shard = 'header\nfooter\ntheirs\n';
    const r = twoWayUnionMerge(buf(user), buf(shard), false);
    expect(r.hasConflict).toBe(false);
    const out = r.content.toString('utf8');
    expect(out).toContain('mine');
    expect(out).toContain('theirs');
    expect(out).toContain('header');
    expect(out).toContain('footer');
  });

  it('overlapping replacement of the same line → conflict', () => {
    const user = 'line1\nMINE\nline3\n';
    const shard = 'line1\nTHEIRS\nline3\n';
    const r = twoWayUnionMerge(buf(user), buf(shard), false);
    expect(r.hasConflict).toBe(true);
  });

  it('trailing-newline-only difference → conservative conflict (documented)', () => {
    // diffLines aligns "line2" vs "line2\n" as a replacement (removed+added
    // in one run), so a file that differs ONLY in its final newline is
    // reported as a conflict and falls through to the per-file prompt rather
    // than auto-resolving. This is intentional best-effort behaviour: the
    // merge never normalizes newlines (that could mask a real diff), so it
    // errs toward asking. Pinned so the choice is explicit, not accidental.
    const user = 'line1\nline2';
    const shard = 'line1\nline2\n';
    expect(twoWayUnionMerge(buf(user), buf(shard), false).hasConflict).toBe(true);
  });

  it('non-UTF-8 but non-binary input → conflict, never lossy-merged', () => {
    // 0xFF is invalid UTF-8 and there is no NUL, so the planner's looksBinary
    // returns false. Merging would corrupt the byte via U+FFFD; the guard
    // forces a prompt instead.
    const user = Buffer.from([0x61, 0xff, 0x0a]); // "a", 0xFF, "\n"
    const shard = Buffer.from('a\nb\n', 'utf8');
    expect(twoWayUnionMerge(user, shard, false).hasConflict).toBe(true);
  });

  it('binary input → always conflict (no line merge attempted)', () => {
    const user = '\x00\x01mine';
    const shard = '\x00\x01theirs';
    const r = twoWayUnionMerge(buf(user), buf(shard), true);
    expect(r.hasConflict).toBe(true);
  });

  it('empty user file, shard has content → union is the shard content', () => {
    const r = twoWayUnionMerge(buf(''), buf('a\nb\n'), false);
    expect(r.hasConflict).toBe(false);
    expect(r.content.toString('utf8')).toBe('a\nb\n');
  });

  it('preserves CRLF bytes in unioned regions', () => {
    const user = 'a\r\nb\r\n';
    const shard = 'a\r\ninserted\r\nb\r\n';
    const r = twoWayUnionMerge(buf(user), buf(shard), false);
    expect(r.hasConflict).toBe(false);
    expect(r.content.toString('utf8')).toBe(shard);
  });

  // ── Properties ──────────────────────────────────────────────────────

  it('property: deterministic — same inputs produce the same result', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (u, s) => {
        const a = twoWayUnionMerge(buf(u), buf(s), false);
        const b = twoWayUnionMerge(buf(u), buf(s), false);
        return (
          a.hasConflict === b.hasConflict &&
          a.content.equals(b.content)
        );
      }),
    );
  });

  it('property: when no conflict, every common line survives in the union', () => {
    // Build user/shard from a shared anchor list with side-unique insertions
    // so the merge is a clean union; assert the anchors all appear.
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z]{1,8}$/), { minLength: 1, maxLength: 6 }),
        fc.stringMatching(/^[A-Z]{1,8}$/),
        fc.stringMatching(/^[0-9]{1,8}$/),
        (anchors, userExtra, shardExtra) => {
          // user = anchors with userExtra appended; shard = anchors with
          // shardExtra appended. The trailing insertions are on different
          // sides at the same tail position, so they may or may not conflict;
          // we only assert the invariant on the no-conflict branch.
          const user = [...anchors, userExtra].join('\n') + '\n';
          const shard = [...anchors, shardExtra].join('\n') + '\n';
          const r = twoWayUnionMerge(buf(user), buf(shard), false);
          if (r.hasConflict) return true; // precondition not met
          const out = r.content.toString('utf8');
          return anchors.every((a) => out.includes(a));
        },
      ),
    );
  });
});
