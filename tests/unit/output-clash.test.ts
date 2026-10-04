/**
 * Two shard outputs that name the same file (#240): a static file and a
 * template, two templates, or an `_each` expansion and either. Compared
 * NFC- and case-folded, so the answer is the same on every filesystem.
 */

import { describe, it, expect } from 'vitest';
import { assertNoOutputClashes, findOutputClashes, foldOutputPath } from '../../source/core/output-clash.js';

describe('assertNoOutputClashes (#240)', () => {
  it('passes distinct outputs', () => {
    expect(() =>
      assertNoOutputClashes([
        { outputPath: 'people/alice.md', origin: 'people/alice.md' },
        { outputPath: 'people/bob.md', origin: 'people/_each.md.njk' },
      ]),
    ).not.toThrow();
  });

  it.each([
    ['exactly', 'people/alice.md', 'people/alice.md'],
    ['by case', 'people/alice.md', 'people/Alice.md'],
    ['in Unicode form', 'notes/Café.md', 'notes/Café.md'],
  ])('refuses two outputs that name the same file %s', (_label, a, b) => {
    let err: { code?: string; message: string } | undefined;
    try {
      assertNoOutputClashes([
        { outputPath: a, origin: 'static file' },
        { outputPath: b, origin: 'people/_each.md.njk (item "Alice")' },
      ]);
    } catch (e) {
      err = e as typeof err;
    }
    expect(err?.code).toBe('OUTPUT_PATH_CLASH');
    // Both sources are named, so the author can find them.
    expect(err!.message).toContain('static file');
    expect(err!.message).toContain('people/_each.md.njk');
  });

  it('folds with NFC then case, as the vault-path guard does', () => {
    expect(foldOutputPath('A/Café.md')).toBe(foldOutputPath('a/café.md'));
  });

  it('refuses two outputs whose folders differ only in case', () => {
    const clashes = findOutputClashes([
      { outputPath: 'Notes/a.md', origin: 'Notes/a.md' },
      { outputPath: 'notes/b.md', origin: 'notes/b.md' },
    ]);
    expect(clashes).toHaveLength(1);
    expect(clashes[0]!.at).toContain('Notes/');
  });

  it('refuses a file where another output needs a folder', () => {
    const clashes = findOutputClashes([
      { outputPath: 'notes', origin: 'notes.njk' },
      { outputPath: 'notes/today.md', origin: 'notes/today.md' },
    ]);
    expect(clashes).toHaveLength(1);
    expect(clashes[0]!.first.origin).toBe('notes.njk');
  });

  it('allows two outputs in one folder spelled the same', () => {
    expect(
      findOutputClashes([
        { outputPath: 'notes/a.md', origin: 'a' },
        { outputPath: 'notes/b.md', origin: 'b' },
      ]),
    ).toEqual([]);
  });
});
