import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import { describe, it, expect } from 'vitest';
import { resolveModules } from '../../source/core/modules.js';
import { parseSchema } from '../../source/core/schema.js';
import type { ShardSchema } from '../../source/runtime/types.js';
import { makeShardSource } from '../helpers/index.js';

const EXAMPLE_SHARD = path.resolve('examples/minimal-shard');

async function loadSchema() {
  return parseSchema(path.join(EXAMPLE_SHARD, '.shardmind', 'shard-schema.yaml'));
}

async function makeTempShard(name: string): Promise<string> {
  return makeShardSource(path.join(os.tmpdir(), `${name}-${crypto.randomUUID()}`));
}

const EMPTY_SCHEMA: ShardSchema = {
  schema_version: 1,
  values: {},
  groups: [],
  modules: {},
  signals: [],
  frontmatter: {},
  migrations: [],
};

describe('resolveModules — v6 shard-root walker', () => {
  it('resolves the migrated minimal-shard with all modules included', async () => {
    const schema = await loadSchema();
    const selections = { brain: 'included' as const, extras: 'included' as const };
    const result = await resolveModules(schema, selections, EXAMPLE_SHARD);

    const renderPaths = result.render.map((f) => f.outputPath).sort();
    const copyPaths = result.copy.map((f) => f.outputPath).sort();

    // `.njk` is the author opt-in to render; the migrated fixture uses it
    // for `.claude/settings.json.njk` (dotfolder config) and the two
    // values-substituted vault files (Home, brain/North Star).
    expect(renderPaths).toEqual(['.claude/settings.json', 'Home.md', 'brain/North Star.md']);

    expect(copyPaths).toContain('CLAUDE.md');
    expect(copyPaths).toContain('.claude/commands/example-command.md');
  });

  it('skips files when their owning module is excluded', async () => {
    const schema = await loadSchema();
    const selections = { brain: 'included' as const, extras: 'excluded' as const };
    const result = await resolveModules(schema, selections, EXAMPLE_SHARD);

    const skipPaths = result.skip.map((f) => f.outputPath);
    expect(skipPaths).toContain('.claude/commands/example-command.md');

    const renderPaths = result.render.map((f) => f.outputPath);
    expect(renderPaths).toContain('brain/North Star.md');

    const copyPaths = result.copy.map((f) => f.outputPath);
    expect(copyPaths).not.toContain('.claude/commands/example-command.md');
  });

  it('honors .shardmindignore at the shard root', async () => {
    const schema = await loadSchema();
    const tmpShard = await makeTempShard('modules-ignore');
    try {
      // Mirror minimal-shard's ignore: `*.gif`. Drop in a .gif and confirm.
      await fs.writeFile(path.join(tmpShard, '.shardmindignore'), '*.gif\n');
      await fs.writeFile(path.join(tmpShard, 'banner.gif'), 'fake-binary');
      await fs.writeFile(path.join(tmpShard, 'README.md'), '# repo');

      const result = await resolveModules(schema, {}, tmpShard);
      const allOutput = [
        ...result.render.map((f) => f.outputPath),
        ...result.copy.map((f) => f.outputPath),
        ...result.skip.map((f) => f.outputPath),
      ];
      expect(allOutput).not.toContain('banner.gif');
      expect(allOutput).toContain('README.md');
    } finally {
      await fs.rm(tmpShard, { recursive: true, force: true });
    }
  });

  it('rejects symlinks anywhere in the shard source', async () => {
    const tmpShard = await makeTempShard('modules-symlink');
    try {
      await fs.writeFile(path.join(tmpShard, 'real.md'), 'real');
      await fs.symlink('real.md', path.join(tmpShard, 'link.md'));
      await expect(resolveModules(EMPTY_SCHEMA, {}, tmpShard)).rejects.toMatchObject({
        code: 'WALK_SYMLINK_REJECTED',
      });
    } finally {
      await fs.rm(tmpShard, { recursive: true, force: true });
    }
  });

  it('rejects symlinks pointing outside the shard root', async () => {
    const outside = path.join(os.tmpdir(), `outside-${crypto.randomUUID()}.md`);
    await fs.writeFile(outside, 'secret');
    const tmpShard = await makeTempShard('modules-symlink-out');
    try {
      await fs.symlink(outside, path.join(tmpShard, 'escape.md'));
      await expect(resolveModules(EMPTY_SCHEMA, {}, tmpShard)).rejects.toMatchObject({
        code: 'WALK_SYMLINK_REJECTED',
      });
    } finally {
      await fs.rm(tmpShard, { recursive: true, force: true });
      await fs.rm(outside, { force: true });
    }
  });

  it('walks Unicode + spaces in paths cleanly', async () => {
    const tmpShard = await makeTempShard('modules-unicode');
    try {
      await fs.mkdir(path.join(tmpShard, 'brain'), { recursive: true });
      await fs.writeFile(path.join(tmpShard, 'brain', 'Idées de projet.md'), 'fr');
      await fs.writeFile(path.join(tmpShard, 'A B C.md'), 'spaces');

      const result = await resolveModules(EMPTY_SCHEMA, {}, tmpShard);
      const copyPaths = result.copy.map((f) => f.outputPath);
      expect(copyPaths).toContain('brain/Idées de projet.md');
      expect(copyPaths).toContain('A B C.md');
    } finally {
      await fs.rm(tmpShard, { recursive: true, force: true });
    }
  });

  it('any .njk file renders (dotfolder or not) — author opt-in via the suffix', async () => {
    const tmpShard = await makeTempShard('modules-njk-rule');
    try {
      await fs.mkdir(path.join(tmpShard, '.claude'), { recursive: true });
      await fs.writeFile(path.join(tmpShard, '.claude', 'settings.json.njk'), '{}');
      // .njk at vault-visible paths also renders — spec defers `rendered_files`
      // (rendering files *without* `.njk`) to v0.2 (#86), but `.njk` itself
      // is the existing author opt-in and stays live.
      await fs.writeFile(path.join(tmpShard, 'page.md.njk'), '# page');

      const result = await resolveModules(EMPTY_SCHEMA, {}, tmpShard);
      const renderPaths = result.render.map((f) => f.outputPath);
      const copyPaths = result.copy.map((f) => f.outputPath);
      expect(renderPaths).toContain('.claude/settings.json');
      expect(renderPaths).toContain('page.md');
      expect(copyPaths).not.toContain('page.md.njk');
    } finally {
      await fs.rm(tmpShard, { recursive: true, force: true });
    }
  });

  it('detects _each iterator from parent directory name', async () => {
    const tmpShard = await makeTempShard('modules-each');
    try {
      const subdir = path.join(tmpShard, '.claude', 'perf', 'competencies');
      await fs.mkdir(subdir, { recursive: true });
      await fs.writeFile(path.join(subdir, '_each.md.njk'), '# {{ item.name }}\n');

      const schema: ShardSchema = {
        ...EMPTY_SCHEMA,
        modules: {
          perf: { label: 'Perf', paths: ['.claude/perf/'], removable: true },
        },
      };
      const result = await resolveModules(schema, { perf: 'included' }, tmpShard);
      const eachFile = result.render.find((f) => f.outputPath.includes('_each'));
      expect(eachFile).toBeDefined();
      expect(eachFile!.iterator).toBe('competencies');
    } finally {
      await fs.rm(tmpShard, { recursive: true, force: true });
    }
  });

  it('detects volatile hint in template files', async () => {
    const tmpShard = await makeTempShard('modules-volatile');
    try {
      await fs.mkdir(path.join(tmpShard, '.claude'), { recursive: true });
      await fs.writeFile(
        path.join(tmpShard, '.claude', 'index.md.njk'),
        '{# shardmind: volatile #}\n# Index\n',
      );
      const result = await resolveModules(EMPTY_SCHEMA, {}, tmpShard);
      const indexFile = result.render.find((f) => f.outputPath === '.claude/index.md');
      expect(indexFile).toBeDefined();
      expect(indexFile!.volatile).toBe(true);
    } finally {
      await fs.rm(tmpShard, { recursive: true, force: true });
    }
  });

  it('mod.paths prefix match respects path-segment boundaries', async () => {
    // `paths: ['work/Index.md']` must claim `work/Index.md` itself — but
    // not `work/Index.md.backup` or `work/Index.mdx`. Same for trailing-
    // slash prefixes: `paths: ['brain/']` claims `brain/X` but not
    // `brainstorm/X` (trailing slash already protects that).
    const tmpShard = await makeTempShard('modules-paths-boundary');
    try {
      await fs.mkdir(path.join(tmpShard, 'work'), { recursive: true });
      await fs.mkdir(path.join(tmpShard, 'brain'), { recursive: true });
      await fs.mkdir(path.join(tmpShard, 'brainstorm'), { recursive: true });
      await fs.writeFile(path.join(tmpShard, 'work', 'Index.md'), 'a');
      await fs.writeFile(path.join(tmpShard, 'work', 'Index.md.backup'), 'b');
      await fs.writeFile(path.join(tmpShard, 'brain', 'Note.md'), 'c');
      await fs.writeFile(path.join(tmpShard, 'brainstorm', 'Idea.md'), 'd');

      const schema: ShardSchema = {
        ...EMPTY_SCHEMA,
        modules: {
          // No trailing slash, exact-or-segment-prefix.
          work: { label: 'Work', paths: ['work/Index.md'], removable: true },
          brain: { label: 'Brain', paths: ['brain/'], removable: true },
        },
      };
      const result = await resolveModules(
        schema,
        { work: 'excluded', brain: 'excluded' },
        tmpShard,
      );
      const skipPaths = result.skip.map((f) => f.outputPath);
      const copyPaths = result.copy.map((f) => f.outputPath);

      // Specific-file paths entry must claim only the exact file.
      expect(skipPaths).toContain('work/Index.md');
      expect(skipPaths).not.toContain('work/Index.md.backup');
      expect(copyPaths).toContain('work/Index.md.backup');

      // Trailing-slash prefix must respect the segment boundary too.
      expect(skipPaths).toContain('brain/Note.md');
      expect(skipPaths).not.toContain('brainstorm/Idea.md');
      expect(copyPaths).toContain('brainstorm/Idea.md');
    } finally {
      await fs.rm(tmpShard, { recursive: true, force: true });
    }
  });

  it('per-name commands gating only fires when parent dir is `commands`', async () => {
    const tmpShard = await makeTempShard('modules-commands-collision');
    try {
      await fs.mkdir(path.join(tmpShard, '.claude', 'commands'), { recursive: true });
      await fs.mkdir(path.join(tmpShard, 'notes'), { recursive: true });
      await fs.writeFile(
        path.join(tmpShard, '.claude', 'commands', 'example-command.md'),
        '# command',
      );
      // A note that happens to share the same name — must NOT be gated.
      await fs.writeFile(path.join(tmpShard, 'notes', 'example-command.md'), '# note');

      const schema: ShardSchema = {
        ...EMPTY_SCHEMA,
        modules: {
          extras: {
            label: 'Extras',
            paths: ['extras/'],
            commands: ['example-command'],
            removable: true,
          },
        },
      };
      const result = await resolveModules(schema, { extras: 'excluded' }, tmpShard);
      const skipPaths = result.skip.map((f) => f.outputPath);
      expect(skipPaths).toContain('.claude/commands/example-command.md');
      expect(skipPaths).not.toContain('notes/example-command.md');

      const copyPaths = result.copy.map((f) => f.outputPath);
      expect(copyPaths).toContain('notes/example-command.md');
    } finally {
      await fs.rm(tmpShard, { recursive: true, force: true });
    }
  });

  it('handles missing .shardmindignore + empty shard root gracefully', async () => {
    const tmpShard = await makeTempShard('modules-empty');
    try {
      const result = await resolveModules(EMPTY_SCHEMA, {}, tmpShard);
      const total = result.render.length + result.copy.length;
      // Only the synthetic .shardmind/shard.yaml exists, and Tier 1 excludes it.
      expect(total).toBe(0);
      expect(result.skip).toHaveLength(0);
    } finally {
      await fs.rm(tmpShard, { recursive: true, force: true });
    }
  });
});
