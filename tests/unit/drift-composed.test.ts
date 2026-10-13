/**
 * Drift for one shard of a vault holding several (#406): its own files, its
 * own template cache, and never another shard's file, or any values file, as
 * its orphan. Spec: docs/IMPLEMENTATION.md §4.8 (`foreign`, `cacheDir`).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { detectDrift } from '../../source/core/drift.js';
import { sha256 } from '../../source/core/fs-utils.js';
import { makeShardState } from '../helpers/index.js';

let vault: string;

beforeEach(async () => {
  vault = path.join(os.tmpdir(), `shardmind-drift-composed-${crypto.randomUUID()}`);
  await fsp.mkdir(path.join(vault, 'notes'), { recursive: true });
});

afterEach(async () => {
  await fsp.rm(vault, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<string> {
  await fsp.mkdir(path.dirname(path.join(vault, rel)), { recursive: true });
  await fsp.writeFile(path.join(vault, rel), content);
  return sha256(content);
}

describe('detectDrift in a composed vault (#406)', () => {
  it("never reports another shard's file, or a values file, as this shard's orphan", async () => {
    const base = await write('notes/Base.md', 'base\n');
    await write('notes/Overlay.md', 'overlay\n');
    await write('Home.md', 'home\n');
    await write('shard-values.acme.research.yaml', 'topic: x\n');
    await write('notes/Mine.md', 'my own\n');
    const state = makeShardState({
      files: {
        'notes/Base.md': { template: null, rendered_hash: base, ownership: 'managed' },
        'Home.md': { template: null, rendered_hash: sha256('home\n'), ownership: 'managed' },
      },
    });
    const drift = await detectDrift(vault, state, {
      foreign: new Set(['notes/Overlay.md', 'shard-values.acme.research.yaml']),
    });
    expect(drift.orphaned).toEqual(['notes/Mine.md']);
    expect(drift.managed.map((e) => e.path).sort()).toEqual(['Home.md', 'notes/Base.md']);
  });

  it("reads the shard's own template cache for the volatile check", async () => {
    await write('notes/Daily.md', 'today\n');
    const cache = path.join('.shardmind', 'shards', 'acme', 'research');
    await write(path.join(cache, 'templates', 'notes', 'Daily.md.njk'), '{# shardmind: volatile #}\n{{ now }}\n');
    const state = makeShardState({
      files: { 'notes/Daily.md': { template: 'notes/Daily.md.njk', rendered_hash: 'stale', ownership: 'managed' } },
    });
    expect((await detectDrift(vault, state, { cacheDir: cache })).volatile.map((e) => e.path)).toEqual(['notes/Daily.md']);
    // Not in the base's cache, so not volatile there: it reads as modified.
    expect((await detectDrift(vault, state)).modified.map((e) => e.path)).toEqual(['notes/Daily.md']);
  });
});
