import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import { describe, it, expect } from 'vitest';
import { resolveModules } from '../../source/core/modules.js';
import { parseSchema } from '../../source/core/schema.js';

const EXAMPLE_SHARD = path.resolve('examples/minimal-shard');

async function loadSchema() {
  return parseSchema(path.join(EXAMPLE_SHARD, 'shard-schema.yaml'));
}

describe('resolveModules', () => {
  it('includes all files when all modules are included', async () => {
    const schema = await loadSchema();
    const selections = { brain: 'included' as const, extras: 'included' as const };
    const result = await resolveModules(schema, selections, EXAMPLE_SHARD);

    expect(result.skip).toHaveLength(0);
    expect(result.render.length).toBeGreaterThan(0);

    // All .njk files should be in render
    const renderPaths = result.render.map(f => f.outputPath);
    expect(renderPaths).toContain('CLAUDE.md');
    expect(renderPaths).toContain('Home.md');
    expect(renderPaths).toContain('brain/North Star.md');
    expect(renderPaths).toContain('claude/_core.md');
    expect(renderPaths).toContain('claude/_extras.md');

    // Commands should be in copy
    const copyPaths = result.copy.map(f => f.outputPath);
    expect(copyPaths).toContain('.claude/commands/example-command.md');
  });

  it('skips excluded module files', async () => {
    const schema = await loadSchema();
    const selections = { brain: 'included' as const, extras: 'excluded' as const };
    const result = await resolveModules(schema, selections, EXAMPLE_SHARD);

    const skipPaths = result.skip.map(f => f.outputPath);
    // extras module partial should be skipped
    // Note: claude/_extras.md is not in extras.paths (["extras/"]) but the command is
    expect(skipPaths).toContain('.claude/commands/example-command.md');

    // Brain files should still render
    const renderPaths = result.render.map(f => f.outputPath);
    expect(renderPaths).toContain('brain/North Star.md');
    expect(renderPaths).toContain('CLAUDE.md');
  });

  it('assigns correct module IDs to files', async () => {
    const schema = await loadSchema();
    const selections = { brain: 'included' as const, extras: 'included' as const };
    const result = await resolveModules(schema, selections, EXAMPLE_SHARD);

    const brainFile = result.render.find(f => f.outputPath === 'brain/North Star.md');
    expect(brainFile?.module).toBe('brain');

    const coreFile = result.render.find(f => f.outputPath === 'CLAUDE.md');
    expect(coreFile?.module).toBeNull();

    const homeFile = result.render.find(f => f.outputPath === 'Home.md');
    expect(homeFile?.module).toBeNull();
  });

  it('.njk files go to render, non-.njk to copy', async () => {
    const schema = await loadSchema();
    const selections = { brain: 'included' as const, extras: 'included' as const };
    const result = await resolveModules(schema, selections, EXAMPLE_SHARD);

    // All render entries should have .njk source paths
    for (const entry of result.render) {
      expect(entry.sourcePath).toMatch(/\.njk$/);
    }

    // Copy entries from commands should not be .njk
    const cmdCopy = result.copy.filter(f => f.outputPath.startsWith('.claude/commands/'));
    for (const entry of cmdCopy) {
      expect(entry.sourcePath).not.toMatch(/\.njk$/);
    }
  });

  it('strips templates/ prefix and .njk suffix for output paths', async () => {
    const schema = await loadSchema();
    const selections = { brain: 'included' as const, extras: 'included' as const };
    const result = await resolveModules(schema, selections, EXAMPLE_SHARD);

    for (const entry of result.render) {
      expect(entry.outputPath).not.toContain('templates/');
      expect(entry.outputPath).not.toMatch(/\.njk$/);
    }
  });

  it('detects _each iterator from parent directory name', async () => {
    const tmpDir = path.join(os.tmpdir(), `modules-test-${crypto.randomUUID()}`);
    const templateDir = path.join(tmpDir, 'templates', 'perf', 'competencies');
    await fs.mkdir(templateDir, { recursive: true });
    await fs.writeFile(path.join(templateDir, '_each.md.njk'), '# {{ item.name }}\n');
    // Need shard.yaml and shard-schema.yaml for the shard to be valid
    await fs.writeFile(path.join(tmpDir, 'shard.yaml'), 'apiVersion: v1\nname: test\nnamespace: dev\nversion: 1.0.0');
    await fs.writeFile(path.join(tmpDir, 'shard-schema.yaml'), 'schema_version: 1\nvalues: {}\ngroups: []\nmodules:\n  perf:\n    label: Perf\n    paths: ["perf/"]\n    removable: true\nfrontmatter: {}\nmigrations: []');

    try {
      const schema = await parseSchema(path.join(tmpDir, 'shard-schema.yaml'));
      const selections = { perf: 'included' as const };
      const result = await resolveModules(schema, selections, tmpDir);

      const eachFile = result.render.find(f => f.outputPath.includes('_each'));
      expect(eachFile).toBeDefined();
      expect(eachFile!.iterator).toBe('competencies');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('detects volatile hint in template files', async () => {
    const tmpDir = path.join(os.tmpdir(), `modules-test-${crypto.randomUUID()}`);
    const templateDir = path.join(tmpDir, 'templates');
    await fs.mkdir(templateDir, { recursive: true });
    await fs.writeFile(path.join(templateDir, 'index.md.njk'), '{# shardmind: volatile #}\n# Index\n');

    try {
      const schema = { schema_version: 1, values: {}, groups: [], modules: {}, signals: [], frontmatter: {}, migrations: [] };
      const result = await resolveModules(schema as any, {}, tmpDir);

      const indexFile = result.render.find(f => f.outputPath === 'index.md');
      expect(indexFile).toBeDefined();
      expect(indexFile!.volatile).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('maps commands to .claude/commands/ output path', async () => {
    const schema = await loadSchema();
    const selections = { brain: 'included' as const, extras: 'included' as const };
    const result = await resolveModules(schema, selections, EXAMPLE_SHARD);

    const cmd = result.copy.find(f => f.outputPath === '.claude/commands/example-command.md');
    expect(cmd).toBeDefined();
    expect(cmd!.module).toBe('extras');
  });

  it('handles missing directories gracefully', async () => {
    const tmpDir = path.join(os.tmpdir(), `modules-test-${crypto.randomUUID()}`);
    await fs.mkdir(tmpDir, { recursive: true });

    try {
      const schema = { schema_version: 1, values: {}, groups: [], modules: {}, signals: [], frontmatter: {}, migrations: [] };
      const result = await resolveModules(schema as any, {}, tmpDir);

      expect(result.render).toHaveLength(0);
      expect(result.copy).toHaveLength(0);
      expect(result.skip).toHaveLength(0);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
