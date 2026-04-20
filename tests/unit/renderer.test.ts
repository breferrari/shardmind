import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { describe, it, expect } from 'vitest';
import { createRenderer, renderFile, renderString } from '../../source/core/renderer.js';
import type { FileEntry, RenderContext } from '../../source/runtime/types.js';

const FIXTURES = path.resolve('tests/fixtures/render');

function makeContext(overrides: Partial<RenderContext> & { values: Record<string, unknown> }): RenderContext {
  return {
    included_modules: [],
    shard: { name: 'test', version: '0.1.0' },
    install_date: '2026-04-01',
    year: '2026',
    ...overrides,
  };
}

function makeEntry(overrides: Partial<FileEntry> & { sourcePath: string; outputPath: string }): FileEntry {
  return {
    module: null,
    volatile: false,
    iterator: null,
    ...overrides,
  };
}

async function loadFixture(name: string) {
  const dir = path.join(FIXTURES, name);
  const template = await fs.readFile(path.join(dir, 'template.md.njk'), 'utf-8');
  const valuesRaw = await fs.readFile(path.join(dir, 'values.yaml'), 'utf-8');
  const expected = await fs.readFile(path.join(dir, 'expected.md'), 'utf-8');
  const values = parseYaml(valuesRaw) as Record<string, unknown>;
  return { dir, template, values, expected };
}

describe('renderFile', () => {
  describe('fixture scenarios', () => {
    it('simple-note: frontmatter + body rendering', async () => {
      const fixture = await loadFixture('simple-note');
      const env = createRenderer(fixture.dir);
      const entry = makeEntry({
        sourcePath: path.join(fixture.dir, 'template.md.njk'),
        outputPath: 'Home.md',
      });
      const ctx = makeContext({ values: fixture.values });

      const result = await renderFile(entry, ctx, env) as import('../../source/runtime/types.js').RenderedFile;
      expect(result.content).toBe(fixture.expected);
      expect(result.outputPath).toBe('Home.md');
      expect(result.volatile).toBe(false);
    });

    it('frontmatter-special-chars: YAML escaping', async () => {
      const fixture = await loadFixture('frontmatter-special-chars');
      const env = createRenderer(fixture.dir);
      const entry = makeEntry({
        sourcePath: path.join(fixture.dir, 'template.md.njk'),
        outputPath: 'org.md',
      });
      const ctx = makeContext({ values: fixture.values });

      const result = await renderFile(entry, ctx, env) as import('../../source/runtime/types.js').RenderedFile;
      expect(result.content).toBe(fixture.expected);
    });

    it('plain-no-frontmatter: template without frontmatter', async () => {
      const fixture = await loadFixture('plain-no-frontmatter');
      const env = createRenderer(fixture.dir);
      const entry = makeEntry({
        sourcePath: path.join(fixture.dir, 'template.md.njk'),
        outputPath: 'welcome.md',
      });
      const ctx = makeContext({ values: fixture.values });

      const result = await renderFile(entry, ctx, env) as import('../../source/runtime/types.js').RenderedFile;
      expect(result.content).toBe(fixture.expected);
    });

    it('volatile-hint: detects volatile marker', async () => {
      const fixture = await loadFixture('volatile-hint');
      const env = createRenderer(fixture.dir);
      const entry = makeEntry({
        sourcePath: path.join(fixture.dir, 'template.md.njk'),
        outputPath: 'index.md',
      });
      const ctx = makeContext({ values: fixture.values });

      const result = await renderFile(entry, ctx, env) as import('../../source/runtime/types.js').RenderedFile;
      expect(result.content).toBe(fixture.expected);
      expect(result.volatile).toBe(true);
    });

    it('conditional-blocks: if/for rendering', async () => {
      const fixture = await loadFixture('conditional-blocks');
      const env = createRenderer(fixture.dir);
      const entry = makeEntry({
        sourcePath: path.join(fixture.dir, 'template.md.njk'),
        outputPath: 'vault.md',
      });
      const ctx = makeContext({
        values: fixture.values,
        included_modules: ['brain', 'extras'],
      });

      const result = await renderFile(entry, ctx, env) as import('../../source/runtime/types.js').RenderedFile;
      expect(result.content).toBe(fixture.expected);
    });
  });

  describe('_each iterator', () => {
    it('produces multiple RenderedFile entries', async () => {
      const os = await import('node:os');
      const tmpDir = path.join(os.tmpdir(), `renderer-test-${crypto.randomUUID()}`);
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, '_each.md.njk'),
        '# {{ item.name }}\n\nSlug: {{ item.slug }}.\n',
      );

      try {
        const env = createRenderer(tmpDir);
        const entry = makeEntry({
          sourcePath: path.join(tmpDir, '_each.md.njk'),
          outputPath: 'skills/_each.md',
          iterator: 'skills',
        });
        const ctx = makeContext({
          values: {
            skills: [
              { name: 'Leadership', slug: 'leadership' },
              { name: 'Coding', slug: 'coding' },
            ],
          },
        });

        const results = await renderFile(entry, ctx, env) as import('../../source/runtime/types.js').RenderedFile[];
        expect(results).toHaveLength(2);
        expect(results[0]!.outputPath).toBe('skills/leadership.md');
        expect(results[0]!.content).toContain('# Leadership');
        expect(results[1]!.outputPath).toBe('skills/coding.md');
        expect(results[1]!.content).toContain('# Coding');
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('throws RENDER_ITERATOR_ERROR when value is not an array', async () => {
      const os = await import('node:os');
      const tmpDir = path.join(os.tmpdir(), `renderer-test-${crypto.randomUUID()}`);
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.writeFile(path.join(tmpDir, '_each.md.njk'), '# {{ item.name }}\n');

      try {
        const env = createRenderer(tmpDir);
        const entry = makeEntry({
          sourcePath: path.join(tmpDir, '_each.md.njk'),
          outputPath: 'skills/_each.md',
          iterator: 'skills',
        });
        const ctx = makeContext({ values: { skills: 'not-an-array' } });

        const err = await renderFile(entry, ctx, env).catch(e => e);
        expect(err.code).toBe('RENDER_ITERATOR_ERROR');
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('rewrites Windows-reserved slugs so fsp.writeFile succeeds on NTFS', async () => {
      // CON / PRN / AUX / NUL / COM[1-9] / LPT[1-9] are NTFS device
      // names; a shard author writing `slug: CON` produces an output
      // path `projects/CON.md` that crashes install on Windows. The
      // reserved-name check runs on the STEM (portion before first dot)
      // so `CON.txt` and `LPT1.md` also rewrite — NTFS blocks them too.
      const os = await import('node:os');
      const tmpDir = path.join(os.tmpdir(), `renderer-test-${crypto.randomUUID()}`);
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.writeFile(path.join(tmpDir, '_each.md.njk'), '# {{ item.name }}\n');

      try {
        const env = createRenderer(tmpDir);
        const entry = makeEntry({
          sourcePath: path.join(tmpDir, '_each.md.njk'),
          outputPath: 'projects/_each.md',
          iterator: 'projects',
        });
        const ctx = makeContext({
          values: {
            projects: [
              { name: 'Bare', slug: 'CON' },
              { name: 'Lower', slug: 'com1' },
              { name: 'StemReserved', slug: 'CON.txt' },
              { name: 'MultiDot', slug: 'LPT1.foo.bar' },
              { name: 'Normal', slug: 'normal-slug' },
            ],
          },
        });

        const results = await renderFile(entry, ctx, env) as import('../../source/runtime/types.js').RenderedFile[];
        expect(results.map(r => r.outputPath)).toEqual([
          'projects/_CON.md',
          'projects/_com1.md',
          'projects/_CON.txt.md',
          'projects/_LPT1.foo.bar.md',
          'projects/normal-slug.md',
        ]);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('falls back to `_` when the slug collapses to empty after rewrites', async () => {
      // A slug that's only spaces, or empty, would rewrite to "" —
      // producing an output path like `notes/.md` (dotfile on POSIX,
      // hidden on Windows). Fall back to `_` so every output path has
      // a legible stem. (Pure-dots collapses to `-` via `..` rewrite
      // plus trailing-dot strip; `-` is a fine filename stem, so
      // only the truly-empty case needs the fallback.)
      const os = await import('node:os');
      const tmpDir = path.join(os.tmpdir(), `renderer-test-${crypto.randomUUID()}`);
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.writeFile(path.join(tmpDir, '_each.md.njk'), '# {{ item.name }}\n');

      try {
        const env = createRenderer(tmpDir);
        const entry = makeEntry({
          sourcePath: path.join(tmpDir, '_each.md.njk'),
          outputPath: 'notes/_each.md',
          iterator: 'notes',
        });
        const ctx = makeContext({
          values: {
            notes: [
              { name: 'OnlySpaces', slug: '   ' },
              { name: 'Empty', slug: '' },
            ],
          },
        });

        const results = await renderFile(entry, ctx, env) as import('../../source/runtime/types.js').RenderedFile[];
        for (const r of results) {
          expect(r.outputPath).toBe('notes/_.md');
        }
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('strips trailing dots and spaces from slugs (NTFS strips them silently)', async () => {
      const os = await import('node:os');
      const tmpDir = path.join(os.tmpdir(), `renderer-test-${crypto.randomUUID()}`);
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.writeFile(path.join(tmpDir, '_each.md.njk'), '# {{ item.name }}\n');

      try {
        const env = createRenderer(tmpDir);
        const entry = makeEntry({
          sourcePath: path.join(tmpDir, '_each.md.njk'),
          outputPath: 'notes/_each.md',
          iterator: 'notes',
        });
        const ctx = makeContext({
          values: {
            notes: [
              // `..` is the path-traversal guard; any leftover trailing
              // dot is then stripped so NTFS doesn't silently drop it.
              // `trailing...` → `trailing-.` (traversal guard) → `trailing-`.
              { name: 'Dots', slug: 'trailing...' },
              { name: 'TrailingSpace', slug: 'trailing ' },
              // Pure trailing dots without traversal → stripped cleanly.
              { name: 'PureDot', slug: 'singledot.' },
            ],
          },
        });

        const results = await renderFile(entry, ctx, env) as import('../../source/runtime/types.js').RenderedFile[];
        const paths = results.map(r => r.outputPath);
        // What matters: no output path ends in `.md` with an NTFS-
        // strippable `. ` before the extension. Validate by asserting
        // the slug portion (before `.md`) never ends with a bare dot
        // or space.
        for (const p of paths) {
          const stem = p.replace(/\.md$/, '');
          const tail = stem.slice(stem.lastIndexOf('/') + 1);
          expect(tail).not.toMatch(/[. ]$/);
        }
        expect(paths[1]).toBe('notes/trailing.md');
        expect(paths[2]).toBe('notes/singledot.md');
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('hashing', () => {
    it('computes correct sha256 hash', async () => {
      const fixture = await loadFixture('plain-no-frontmatter');
      const env = createRenderer(fixture.dir);
      const entry = makeEntry({
        sourcePath: path.join(fixture.dir, 'template.md.njk'),
        outputPath: 'test.md',
      });
      const ctx = makeContext({ values: fixture.values });

      const result = await renderFile(entry, ctx, env) as import('../../source/runtime/types.js').RenderedFile;
      const expectedHash = crypto.createHash('sha256').update(result.content).digest('hex');
      expect(result.hash).toBe(expectedHash);
    });
  });

  describe('error handling', () => {
    it('throws RENDER_TEMPLATE_ERROR on Nunjucks syntax error', async () => {
      const os = await import('node:os');
      const tmpDir = path.join(os.tmpdir(), `renderer-test-${crypto.randomUUID()}`);
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'bad.md.njk'), '{% if %}broken{% endif %}\n');

      try {
        const env = createRenderer(tmpDir);
        const entry = makeEntry({
          sourcePath: path.join(tmpDir, 'bad.md.njk'),
          outputPath: 'bad.md',
        });
        const ctx = makeContext({ values: {} });

        const err = await renderFile(entry, ctx, env).catch(e => e);
        expect(err.code).toBe('RENDER_TEMPLATE_ERROR');
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });
});

describe('renderString', () => {
  it('renders a plain body template without frontmatter', () => {
    const ctx = makeContext({ values: { user_name: 'Alice' } });
    const source = '# Hello\n\nHi {{ user_name }}.\n';
    expect(renderString(source, ctx, 'hello.md')).toBe('# Hello\n\nHi Alice.\n');
  });

  it('normalizes frontmatter YAML through parse→stringify', () => {
    const ctx = makeContext({ values: {} });
    const source = '---\ntags: [brain, active]\nstatus: current\n---\n\n# Note\n\nBody.\n';
    const rendered = renderString(source, ctx, 'note.md');
    expect(rendered).toBe(
      '---\ntags:\n  - brain\n  - active\nstatus: current\n---\n\n# Note\n\nBody.\n',
    );
  });

  it('substitutes context keys (shard, install_date) inside frontmatter', () => {
    const ctx = makeContext({
      values: { user_name: 'Alice' },
      install_date: '2026-04-19',
    });
    const source = '---\ndate: {{ install_date }}\nowner: {{ user_name }}\n---\n\nBody.\n';
    expect(renderString(source, ctx, 'note.md')).toBe(
      '---\ndate: 2026-04-19\nowner: Alice\n---\n\nBody.\n',
    );
  });

  it('throws RENDER_TEMPLATE_ERROR on Nunjucks syntax error', () => {
    const ctx = makeContext({ values: {} });
    try {
      renderString('{% if %}broken{% endif %}', ctx, 'bad.md');
      expect.fail('renderString should have thrown');
    } catch (err: unknown) {
      expect((err as { code: string }).code).toBe('RENDER_TEMPLATE_ERROR');
    }
  });

  it('accepts a caller-supplied env', () => {
    const env = createRenderer(path.resolve('tests/fixtures/render/simple-note'));
    env.addFilter('shout', (s: string) => s.toUpperCase());
    const ctx = makeContext({ values: { name: 'alice' } });
    expect(renderString('Hi {{ name | shout }}!', ctx, 'x.md', env)).toBe('Hi ALICE!');
  });
});
