/**
 * Direct unit tests for drift.detectDrift — complements the fixture-driven
 * suite in drift.test.ts (which targets computeMergeAction + orchestration
 * dispatch). Each test builds a throwaway vault with a hand-crafted state.json
 * and asserts the resulting DriftReport bucket assignment.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { detectDrift } from '../../source/core/drift.js';
import { sha256 } from '../../source/core/fs-utils.js';
import { makeShardState } from '../helpers/index.js';

let vaultRoot: string;

beforeEach(async () => {
  vaultRoot = path.join(os.tmpdir(), `drift-unit-${crypto.randomUUID()}`);
  await fsp.mkdir(vaultRoot, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(vaultRoot, { recursive: true, force: true });
});

async function writeFile(relPath: string, content: string): Promise<void> {
  const abs = path.join(vaultRoot, relPath);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, 'utf-8');
}

describe('detectDrift', () => {
  it('classifies a hash-matching file as managed', async () => {
    const content = '# Managed\n';
    await writeFile('notes/a.md', content);
    const state = makeShardState({ files: {
      'notes/a.md': {
        template: 't.njk',
        rendered_hash: sha256(content),
        ownership: 'managed',
      },
    } });

    const report = await detectDrift(vaultRoot, state);

    expect(report.managed).toHaveLength(1);
    expect(report.managed[0]?.path).toBe('notes/a.md');
    expect(report.managed[0]?.actualHash).toBe(sha256(content));
    expect(report.managed[0]?.ownership).toBe('managed');
    expect(report.modified).toHaveLength(0);
    expect(report.volatile).toHaveLength(0);
    expect(report.missing).toHaveLength(0);
  });

  it('classifies a hash-differing file as modified', async () => {
    await writeFile('notes/b.md', '# Edited by user\n');
    const state = makeShardState({ files: {
      'notes/b.md': {
        template: 't.njk',
        rendered_hash: sha256('# Original\n'),
        ownership: 'managed',
      },
    } });

    const report = await detectDrift(vaultRoot, state);

    expect(report.modified).toHaveLength(1);
    expect(report.modified[0]?.ownership).toBe('modified');
    expect(report.managed).toHaveLength(0);
  });

  it('maps state ownership=user onto the volatile bucket', async () => {
    // Content intentionally doesn't match the recorded hash — the whole point
    // of volatile is that drift never hashes it.
    await writeFile('inbox.md', '# edits the user is free to make\n');
    const state = makeShardState({ files: {
      'inbox.md': {
        template: 'inbox.njk',
        rendered_hash: 'stale-hash-on-purpose',
        ownership: 'user',
      },
    } });

    const report = await detectDrift(vaultRoot, state);

    expect(report.volatile).toHaveLength(1);
    expect(report.volatile[0]?.path).toBe('inbox.md');
    expect(report.volatile[0]?.ownership).toBe('volatile');
    expect(report.volatile[0]?.actualHash).toBeNull();
    expect(report.managed).toHaveLength(0);
    expect(report.modified).toHaveLength(0);
  });

  it('reports a file as missing when absent on disk', async () => {
    const state = makeShardState({ files: {
      'gone.md': {
        template: 't.njk',
        rendered_hash: sha256('# was here\n'),
        ownership: 'managed',
      },
    } });

    const report = await detectDrift(vaultRoot, state);

    expect(report.missing).toHaveLength(1);
    expect(report.missing[0]?.path).toBe('gone.md');
    expect(report.missing[0]?.actualHash).toBeNull();
  });

  it('propagates state ownership=modified onto missing entries', async () => {
    const state = makeShardState({ files: {
      'gone.md': {
        template: 't.njk',
        rendered_hash: sha256('# was here\n'),
        ownership: 'modified',
      },
    } });

    const report = await detectDrift(vaultRoot, state);

    expect(report.missing[0]?.ownership).toBe('modified');
  });

  it('classifies a mixed vault across all buckets in one pass', async () => {
    const managedContent = 'managed\n';
    const modifiedContent = 'user edited\n';
    const volatileContent = 'inbox scratch\n';
    await writeFile('m.md', managedContent);
    await writeFile('x.md', modifiedContent);
    await writeFile('v.md', volatileContent);

    const state = makeShardState({ files: {
      'm.md': { template: 't.njk', rendered_hash: sha256(managedContent), ownership: 'managed' },
      'x.md': { template: 't.njk', rendered_hash: sha256('original\n'), ownership: 'managed' },
      'v.md': { template: 'inbox.njk', rendered_hash: 'stale', ownership: 'user' },
      'missing.md': { template: 't.njk', rendered_hash: sha256('x\n'), ownership: 'managed' },
    } });

    const report = await detectDrift(vaultRoot, state);

    expect(report.managed.map(e => e.path)).toEqual(['m.md']);
    expect(report.modified.map(e => e.path)).toEqual(['x.md']);
    expect(report.volatile.map(e => e.path)).toEqual(['v.md']);
    expect(report.missing.map(e => e.path)).toEqual(['missing.md']);
  });

  it('returns empty buckets for a state with no files', async () => {
    const report = await detectDrift(vaultRoot, makeShardState({ files: {} }));

    expect(report.managed).toEqual([]);
    expect(report.modified).toEqual([]);
    expect(report.volatile).toEqual([]);
    expect(report.missing).toEqual([]);
    expect(report.orphaned).toEqual([]);
  });
});

describe('detectDrift — orphan detection', () => {
  it('reports a user file alongside a tracked file as orphaned', async () => {
    await writeFile('skills/leadership.md', '# Leadership\n');
    await writeFile('skills/my-extra-skill.md', '# My extra skill\n');

    const state = makeShardState({ files: {
      'skills/leadership.md': {
        template: 'skills/_each.md.njk',
        rendered_hash: sha256('# Leadership\n'),
        ownership: 'managed',
      },
    } });

    const report = await detectDrift(vaultRoot, state);

    expect(report.orphaned).toEqual(['skills/my-extra-skill.md']);
    expect(report.managed).toHaveLength(1);
  });

  it('does not recurse into untracked subdirectories', async () => {
    await writeFile('CLAUDE.md', '# shard\n');
    await writeFile('brain/daily/2026-04-19.md', 'user note\n');

    const state = makeShardState({ files: {
      'CLAUDE.md': {
        template: 'CLAUDE.md.njk',
        rendered_hash: sha256('# shard\n'),
        ownership: 'managed',
      },
    } });

    const report = await detectDrift(vaultRoot, state);

    // `brain/daily/` has no tracked files — user content there is not the
    // shard's concern and must not appear as an orphan.
    expect(report.orphaned).not.toContain('brain/daily/2026-04-19.md');
  });

  it('excludes engine-reserved files (shard-values.yaml)', async () => {
    await writeFile('CLAUDE.md', '# shard\n');
    await writeFile('shard-values.yaml', 'user_name: "Alice"\n');

    const state = makeShardState({ files: {
      'CLAUDE.md': {
        template: 'CLAUDE.md.njk',
        rendered_hash: sha256('# shard\n'),
        ownership: 'managed',
      },
    } });

    const report = await detectDrift(vaultRoot, state);

    expect(report.orphaned).not.toContain('shard-values.yaml');
  });

  it('never scans .shardmind/, .git/, or .obsidian/', async () => {
    await writeFile('CLAUDE.md', '# shard\n');
    await writeFile('.shardmind/state.json', '{}');
    await writeFile('.git/HEAD', 'ref: refs/heads/main\n');
    await writeFile('.obsidian/app.json', '{}');

    const state = makeShardState({ files: {
      'CLAUDE.md': {
        template: 'CLAUDE.md.njk',
        rendered_hash: sha256('# shard\n'),
        ownership: 'managed',
      },
    } });

    const report = await detectDrift(vaultRoot, state);

    expect(report.orphaned).toEqual([]);
  });

  it('aggregates orphans across multiple tracked directories', async () => {
    await writeFile('CLAUDE.md', '# root\n');
    await writeFile('extra-at-root.md', 'user\n');
    await writeFile('skills/leadership.md', '# L\n');
    await writeFile('skills/my-extra.md', 'user\n');

    const state = makeShardState({ files: {
      'CLAUDE.md': {
        template: 'CLAUDE.md.njk',
        rendered_hash: sha256('# root\n'),
        ownership: 'managed',
      },
      'skills/leadership.md': {
        template: 'skills/_each.md.njk',
        rendered_hash: sha256('# L\n'),
        ownership: 'managed',
      },
    } });

    const report = await detectDrift(vaultRoot, state);

    expect(report.orphaned).toEqual(['extra-at-root.md', 'skills/my-extra.md']);
  });
});
