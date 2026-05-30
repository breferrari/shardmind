import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import {
  snapshotUnmanaged,
  detectManagedWrites,
  detectUnmanagedCreates,
} from '../../source/core/hook-boundary.js';
import { parseShardmindignore } from '../../source/core/shardmindignore.js';
import { makeShardState, makeFileState } from '../helpers/shard-state.js';

const EMPTY_IGNORE = parseShardmindignore('');

describe('detectManagedWrites', () => {
  it('returns null when no managed file changed', () => {
    expect(detectManagedWrites([])).toBeNull();
  });

  it('flags a bootstrap managed-write with sorted paths', () => {
    const v = detectManagedWrites(['z.md', 'a.md', 'm.md']);
    expect(v).toEqual({
      slot: 'bootstrap',
      kind: 'managed-write',
      paths: ['a.md', 'm.md', 'z.md'],
    });
  });
});

describe('detectUnmanagedCreates', () => {
  const state = makeShardState({
    files: {
      'Home.md': makeFileState(),
      'brain/North Star.md': makeFileState(),
    },
  });

  it('returns null when nothing new appeared', () => {
    const set = new Set(['Home.md', '.qmd/index']);
    expect(detectUnmanagedCreates(set, set, state)).toBeNull();
  });

  it('flags an unmanaged file created by personalize', () => {
    const before = new Set(['Home.md']);
    const after = new Set(['Home.md', '.cache/stray.json']);
    const v = detectUnmanagedCreates(after, before, state);
    expect(v).toEqual({
      slot: 'personalize',
      kind: 'unmanaged-create',
      paths: ['.cache/stray.json'],
    });
  });

  it('does not flag a created path that is a managed file', () => {
    // A managed path absent from `before` but tracked in state.files is not an
    // "unmanaged create" — it belongs to the engine, not the hook.
    const before = new Set(['Home.md']);
    const after = new Set(['Home.md', 'brain/North Star.md']);
    expect(detectUnmanagedCreates(after, before, state)).toBeNull();
  });

  it('does not flag paths already present before the hook', () => {
    const before = new Set(['Home.md', '.qmd/index']);
    const after = new Set(['Home.md', '.qmd/index']);
    expect(detectUnmanagedCreates(after, before, state)).toBeNull();
  });

  it('property: flagged == after \\ before, minus managed paths', () => {
    const segment = fc.stringMatching(/^[a-z0-9]{1,8}$/);
    const relPath = fc.array(segment, { minLength: 1, maxLength: 3 }).map((s) => s.join('/'));
    fc.assert(
      fc.property(
        fc.uniqueArray(relPath, { maxLength: 12 }),
        fc.uniqueArray(relPath, { maxLength: 12 }),
        fc.uniqueArray(relPath, { maxLength: 6 }),
        (beforeArr, afterArr, managedArr) => {
          const before = new Set(beforeArr);
          const after = new Set(afterArr);
          const files: Record<string, ReturnType<typeof makeFileState>> = {};
          for (const m of managedArr) files[m] = makeFileState();
          const st = makeShardState({ files });

          const expected = afterArr
            .filter((p) => !before.has(p) && files[p] === undefined)
            .sort();
          const v = detectUnmanagedCreates(after, before, st);
          if (expected.length === 0) {
            expect(v).toBeNull();
          } else {
            expect(v!.paths).toEqual(expected);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('snapshotUnmanaged', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'shardmind-boundary-'));
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const write = async (rel: string, body = 'x'): Promise<void> => {
    const abs = path.join(dir, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, body);
  };

  it('returns vault-relative posix paths for every regular file', async () => {
    await write('Home.md');
    await write(path.join('brain', 'North Star.md'));
    const snap = await snapshotUnmanaged(dir, EMPTY_IGNORE);
    expect(snap).toEqual(new Set(['Home.md', 'brain/North Star.md']));
  });

  it('excludes Tier 1 paths (.shardmind/, .git/)', async () => {
    await write('Home.md');
    await write(path.join('.shardmind', 'state.json'));
    await write(path.join('.git', 'HEAD'));
    const snap = await snapshotUnmanaged(dir, EMPTY_IGNORE);
    expect(snap).toEqual(new Set(['Home.md']));
  });

  it('excludes paths matched by .shardmindignore', async () => {
    await write('Home.md');
    await write(path.join('.qmd', 'index.bin'));
    const ignore = parseShardmindignore('.qmd/\n');
    const snap = await snapshotUnmanaged(dir, ignore);
    expect(snap).toEqual(new Set(['Home.md']));
  });

  it('skips symlinks rather than following or recording them', async () => {
    await write('real.md');
    let symlinkSupported = true;
    try {
      await fsp.symlink(path.join(dir, 'real.md'), path.join(dir, 'link.md'));
    } catch {
      // Windows without privilege / filesystems without symlink support.
      symlinkSupported = false;
    }
    const snap = await snapshotUnmanaged(dir, EMPTY_IGNORE);
    expect(snap.has('real.md')).toBe(true);
    if (symlinkSupported) expect(snap.has('link.md')).toBe(false);
  });
});
