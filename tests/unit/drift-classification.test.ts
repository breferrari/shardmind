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
import { makeStateWithFiles } from '../helpers/shard-state.js';

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
    const state = makeStateWithFiles({
      'notes/a.md': {
        template: 't.njk',
        rendered_hash: sha256(content),
        ownership: 'managed',
      },
    });

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
    const state = makeStateWithFiles({
      'notes/b.md': {
        template: 't.njk',
        rendered_hash: sha256('# Original\n'),
        ownership: 'managed',
      },
    });

    const report = await detectDrift(vaultRoot, state);

    expect(report.modified).toHaveLength(1);
    expect(report.modified[0]?.ownership).toBe('modified');
    expect(report.managed).toHaveLength(0);
  });

  it('maps state ownership=user onto the volatile bucket', async () => {
    // Content intentionally doesn't match the recorded hash — the whole point
    // of volatile is that drift never hashes it.
    await writeFile('inbox.md', '# edits the user is free to make\n');
    const state = makeStateWithFiles({
      'inbox.md': {
        template: 'inbox.njk',
        rendered_hash: 'stale-hash-on-purpose',
        ownership: 'user',
      },
    });

    const report = await detectDrift(vaultRoot, state);

    expect(report.volatile).toHaveLength(1);
    expect(report.volatile[0]?.path).toBe('inbox.md');
    expect(report.volatile[0]?.ownership).toBe('volatile');
    expect(report.volatile[0]?.actualHash).toBeNull();
    expect(report.managed).toHaveLength(0);
    expect(report.modified).toHaveLength(0);
  });

  it('reports a file as missing when absent on disk', async () => {
    const state = makeStateWithFiles({
      'gone.md': {
        template: 't.njk',
        rendered_hash: sha256('# was here\n'),
        ownership: 'managed',
      },
    });

    const report = await detectDrift(vaultRoot, state);

    expect(report.missing).toHaveLength(1);
    expect(report.missing[0]?.path).toBe('gone.md');
    expect(report.missing[0]?.actualHash).toBeNull();
  });

  it('propagates state ownership=modified onto missing entries', async () => {
    const state = makeStateWithFiles({
      'gone.md': {
        template: 't.njk',
        rendered_hash: sha256('# was here\n'),
        ownership: 'modified',
      },
    });

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

    const state = makeStateWithFiles({
      'm.md': { template: 't.njk', rendered_hash: sha256(managedContent), ownership: 'managed' },
      'x.md': { template: 't.njk', rendered_hash: sha256('original\n'), ownership: 'managed' },
      'v.md': { template: 'inbox.njk', rendered_hash: 'stale', ownership: 'user' },
      'missing.md': { template: 't.njk', rendered_hash: sha256('x\n'), ownership: 'managed' },
    });

    const report = await detectDrift(vaultRoot, state);

    expect(report.managed.map(e => e.path)).toEqual(['m.md']);
    expect(report.modified.map(e => e.path)).toEqual(['x.md']);
    expect(report.volatile.map(e => e.path)).toEqual(['v.md']);
    expect(report.missing.map(e => e.path)).toEqual(['missing.md']);
    expect(report.orphaned).toEqual([]); // deferred in v0.1
  });

  it('returns empty buckets for a state with no files', async () => {
    const report = await detectDrift(vaultRoot, makeStateWithFiles({}));

    expect(report.managed).toEqual([]);
    expect(report.modified).toEqual([]);
    expect(report.volatile).toEqual([]);
    expect(report.missing).toEqual([]);
    expect(report.orphaned).toEqual([]);
  });
});
