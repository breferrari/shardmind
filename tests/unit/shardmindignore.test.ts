import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  loadShardmindignore,
  parseShardmindignore,
} from '../../source/core/shardmindignore.js';
import { ShardMindError } from '../../source/runtime/types.js';

async function tempDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `shardmindignore-test-${crypto.randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

describe('shardmindignore parser', () => {
  it('returns an empty filter when file is missing', async () => {
    const dir = await tempDir();
    try {
      const filter = await loadShardmindignore(dir);
      expect(filter.ignores('anything', false)).toBe(false);
      expect(filter.ignores('foo/bar', true)).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty filter on an empty / whitespace-only / comments-only file', async () => {
    expect(parseShardmindignore('').ignores('anything', false)).toBe(false);
    expect(parseShardmindignore('   \n\n').ignores('anything', false)).toBe(false);
    expect(
      parseShardmindignore('# comment\n   # another\n\n').ignores('anything', false),
    ).toBe(false);
  });

  it('matches simple basename globs', () => {
    const filter = parseShardmindignore('*.gif\n*.png\n');
    expect(filter.ignores('foo.gif', false)).toBe(true);
    expect(filter.ignores('media/banner.png', false)).toBe(true);
    expect(filter.ignores('readme.md', false)).toBe(false);
  });

  it('honors anchored patterns (leading slash = repo-root only)', () => {
    const filter = parseShardmindignore('/CONTRIBUTING.md\n');
    expect(filter.ignores('CONTRIBUTING.md', false)).toBe(true);
    expect(filter.ignores('docs/CONTRIBUTING.md', false)).toBe(false);
  });

  it('honors directory-only patterns (trailing slash)', () => {
    const filter = parseShardmindignore('build/\n');
    expect(filter.ignores('build', true)).toBe(true);
    expect(filter.ignores('build/output.txt', false)).toBe(true);
    // A regular file named 'build' (no trailing slash semantically) — not a dir
    expect(filter.ignores('build', false)).toBe(false);
  });

  it('supports `**` recursive glob and char classes', () => {
    const filter = parseShardmindignore('**/*.tmp\nlog-[0-9].txt\n');
    expect(filter.ignores('a/b/c/draft.tmp', false)).toBe(true);
    expect(filter.ignores('log-3.txt', false)).toBe(true);
    expect(filter.ignores('log-x.txt', false)).toBe(false);
  });

  it('matches the obsidian-mind-typical pattern set', () => {
    const filter = parseShardmindignore(`
# Repo-meta — meaningful on GitHub, noise in a vault
CONTRIBUTING.md
README.*.md

# Marketing media
*.gif
*.png
obsidian-mind-logo.*
`);
    expect(filter.ignores('CONTRIBUTING.md', false)).toBe(true);
    expect(filter.ignores('README.ja.md', false)).toBe(true);
    expect(filter.ignores('README.ko.md', false)).toBe(true);
    expect(filter.ignores('README.md', false)).toBe(false); // not a translation
    expect(filter.ignores('docs/screenshot.gif', false)).toBe(true);
    expect(filter.ignores('obsidian-mind-logo.svg', false)).toBe(true);
    expect(filter.ignores('brain/Index.md', false)).toBe(false);
  });

  it('re-includes a file a broader pattern excluded (#87)', () => {
    const filter = parseShardmindignore('*.gif\n!onboarding.gif\n');
    expect(filter.ignores('onboarding.gif', false)).toBe(false);
    expect(filter.ignores('banner.gif', false)).toBe(true);
    expect(filter.ignores('media/onboarding.gif', false)).toBe(false);
    expect(filter.ignores('media/other.gif', false)).toBe(true);
  });

  it('lets a later pattern override an earlier one, either way (#87)', () => {
    // A re-include followed by a broader exclude: the exclude wins.
    expect(parseShardmindignore('!keep.md\n*.md\n').ignores('keep.md', false)).toBe(true);
    // An exclude, a re-include, an exclude again: the last word holds.
    expect(parseShardmindignore('*.md\n!keep.md\nkeep.md\n').ignores('keep.md', false)).toBe(true);
  });

  it('re-includes a file under a folder whose contents are excluded, not the folder itself (#87)', () => {
    const filter = parseShardmindignore('assets/*\n!assets/keep.md\n');
    expect(filter.ignores('assets', true)).toBe(false);
    expect(filter.ignores('assets/keep.md', false)).toBe(false);
    expect(filter.ignores('assets/drop.md', false)).toBe(true);
  });

  it('cannot re-include a file whose parent folder is excluded, as in git (#87)', () => {
    const filter = parseShardmindignore('assets/\n!assets/keep.md\n');
    expect(filter.ignores('assets', true)).toBe(true);
    expect(filter.ignores('assets/keep.md', false)).toBe(true);
  });

  it('accepts a negation line that names nothing excluded', () => {
    expect(parseShardmindignore('!nothing-excluded.md\n').ignores('nothing-excluded.md', false)).toBe(false);
  });

  it('accepts gitignore-escaped literal-bang patterns (`\\!file`)', () => {
    // Per gitignore spec, `\!literal.md` is a non-negation pattern that
    // matches a file named `!literal.md`, not a re-include.
    const filter = parseShardmindignore('\\!literal-bang.md\n*.tmp\n');
    expect(filter.ignores('!literal-bang.md', false)).toBe(true);
    expect(filter.ignores('literal-bang.md', false)).toBe(false);
    expect(filter.ignores('foo.tmp', false)).toBe(true);
  });

  it('handles unicode patterns and paths safely', () => {
    const filter = parseShardmindignore('Idées-*.md\n');
    expect(filter.ignores('Idées-2026.md', false)).toBe(true);
    expect(filter.ignores('Idées-de-projet.md', false)).toBe(true);
    expect(filter.ignores('Notes.md', false)).toBe(false);
  });

  it('reads from disk (loadShardmindignore)', async () => {
    const dir = await tempDir();
    try {
      await fs.writeFile(path.join(dir, '.shardmindignore'), '*.gif\nbuild/\n');
      const filter = await loadShardmindignore(dir);
      expect(filter.ignores('foo.gif', false)).toBe(true);
      expect(filter.ignores('build', true)).toBe(true);
      expect(filter.ignores('keeper.md', false)).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('throws SHARDMINDIGNORE_READ_FAILED on non-ENOENT IO errors', async () => {
    // ENOENT → empty filter (covered above). Other IO failures (EPERM,
    // EACCES, EIO) must surface as the typed error so the install command
    // can render an actionable message instead of a blank crash.
    if (process.platform === 'win32') return; // chmod semantics differ on Windows
    const dir = await tempDir();
    const ignorePath = path.join(dir, '.shardmindignore');
    try {
      await fs.writeFile(ignorePath, '*.gif\n');
      await fs.chmod(ignorePath, 0o000);
      try {
        await loadShardmindignore(dir);
        expect.fail('expected ShardMindError');
      } catch (err) {
        if (err instanceof ShardMindError) {
          expect(err.code).toBe('SHARDMINDIGNORE_READ_FAILED');
        } else {
          // Some sandboxed CI runners ignore chmod 0 (root-equivalent perms);
          // skip the assertion rather than flake. Tests run as the file owner
          // on macOS/Linux dev machines, which is the case we care about.
          await fs.chmod(ignorePath, 0o644);
          throw err;
        }
      }
    } finally {
      await fs.chmod(ignorePath, 0o644).catch(() => {});
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('property: parser accepts arbitrary glob patterns, negations included, without crashing', () => {
    const safeGlob = fc.stringMatching(/^!?[A-Za-z0-9*?\/_.\-\[\]]+$/);
    fc.assert(
      fc.property(fc.array(safeGlob, { maxLength: 50 }), (patterns) => {
        const safe = patterns.filter((p) => p.length > 0);
        const text = safe.join('\n');
        expect(() => parseShardmindignore(text)).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it('property: large pattern set (5000 globs) parses + matches under a sane bound', () => {
    const patterns = Array.from({ length: 5000 }, (_, i) => `pat-${i}-*.md`);
    const start = Date.now();
    const filter = parseShardmindignore(patterns.join('\n'));
    expect(filter.ignores('pat-2500-foo.md', false)).toBe(true);
    expect(filter.ignores('pat-9999-foo.md', false)).toBe(false);
    expect(Date.now() - start).toBeLessThan(2000); // generous; smoke only
  });
});
