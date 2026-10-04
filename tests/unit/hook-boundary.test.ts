import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fc from 'fast-check';
import {
  snapshotUnmanaged,
  detectManagedWrites,
  detectUnmanagedCreates,
  loadBoundaryIgnore,
} from '../../source/core/hook-boundary.js';
import { parseShardmindignore } from '../../source/core/shardmindignore.js';
import { makeShardState, makeFileState } from '../helpers/shard-state.js';

const EMPTY_IGNORE = parseShardmindignore('');

/** A walk result with the given paths and unreadable folders. */
function snap(paths: Iterable<string>, unreadable: string[] = []) {
  return { paths: new Set(paths), unreadable };
}

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
    const set = snap(['Home.md', '.qmd/index']);
    expect(detectUnmanagedCreates(set, set, state)).toBeNull();
  });

  it('flags an unmanaged file created by personalize', () => {
    const before = snap(['Home.md']);
    const after = snap(['Home.md', '.cache/stray.json']);
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
    const before = snap(['Home.md']);
    const after = snap(['Home.md', 'brain/North Star.md']);
    expect(detectUnmanagedCreates(after, before, state)).toBeNull();
  });

  it('does not flag paths already present before the hook', () => {
    const before = snap(['Home.md', '.qmd/index']);
    const after = snap(['Home.md', '.qmd/index']);
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
          const v = detectUnmanagedCreates(snap(after), snap(before), st);
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

  it('reports the walk as incomplete when nothing was created but a folder was unreadable', () => {
    const v = detectUnmanagedCreates(snap(['Home.md'], ['.cache']), snap(['Home.md']), state);
    expect(v).toEqual({ slot: 'personalize', kind: 'incomplete', paths: ['.cache'] });
  });

  it('lists unreadable folders from both walks alongside created files', () => {
    const before = snap(['Home.md'], ['b', 'shared']);
    const after = snap(['Home.md', 'stray.json'], ['a', 'shared']);
    expect(detectUnmanagedCreates(after, before, state)).toEqual({
      slot: 'personalize',
      kind: 'unmanaged-create',
      paths: ['stray.json'],
      unreadable: ['a', 'b', 'shared'],
    });
  });

  it('does not count a path under a folder unreadable before the hook as created', () => {
    // `.qmd/` could not be read before the hook, so its files may have been
    // there all along: they are not attributable to personalize.
    const before = snap(['Home.md'], ['.qmd']);
    const after = snap(['Home.md', '.qmd/index', '.qmdx/new']);
    expect(detectUnmanagedCreates(after, before, state)).toEqual({
      slot: 'personalize',
      kind: 'unmanaged-create',
      paths: ['.qmdx/new'],
      unreadable: ['.qmd'],
    });
  });

  it('reports incomplete, not nothing, when a folder unreadable before the hook holds a new file after it', () => {
    // `.qmd/` became readable after the hook and holds a file: it may be new,
    // or may have been there all along. Neither "created" nor "nothing".
    const v = detectUnmanagedCreates(snap(['Home.md', '.qmd/new']), snap(['Home.md'], ['.qmd']), state);
    expect(v).toEqual({ slot: 'personalize', kind: 'incomplete', paths: ['.qmd'] });
  });

  it('counts nothing as created when the vault root was unreadable before the hook', () => {
    const v = detectUnmanagedCreates(snap(['Home.md', 'new.md']), snap([], ['.']), state);
    expect(v).toEqual({ slot: 'personalize', kind: 'incomplete', paths: ['.'] });
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
    const walk = await snapshotUnmanaged(dir, EMPTY_IGNORE);
    expect(walk).toEqual(snap(['Home.md', 'brain/North Star.md']));
  });

  it('excludes Tier 1 paths (.shardmind/, .git/)', async () => {
    await write('Home.md');
    await write(path.join('.shardmind', 'state.json'));
    await write(path.join('.git', 'HEAD'));
    const walk = await snapshotUnmanaged(dir, EMPTY_IGNORE);
    expect(walk).toEqual(snap(['Home.md']));
  });

  it('excludes paths matched by .shardmindignore', async () => {
    await write('Home.md');
    await write(path.join('.qmd', 'index.bin'));
    const ignore = parseShardmindignore('.qmd/\n');
    const walk = await snapshotUnmanaged(dir, ignore);
    expect(walk).toEqual(snap(['Home.md']));
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
    const walk = await snapshotUnmanaged(dir, EMPTY_IGNORE);
    expect(walk.paths.has('real.md')).toBe(true);
    if (symlinkSupported) expect(walk.paths.has('link.md')).toBe(false);
  });

  describe('readdir failures (#175)', () => {
    const realReaddir = fsp.readdir.bind(fsp);
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /**
     * Fail `readdir` of the vault-relative folder `rel` ('' = the root) with
     * `codes`, one per call, then fall through to the real readdir. Returns
     * the number of reads of that folder.
     */
    function failReaddir(rel: string, codes: string[]): { calls: number } {
      const target = path.resolve(dir, rel);
      const seen = { calls: 0 };
      const fake = async (p: string, opts: { withFileTypes: true }) => {
        if (path.resolve(p) === target) {
          seen.calls += 1;
          const code = codes[seen.calls - 1];
          if (code) throw Object.assign(new Error(`${code}: injected`), { code });
        }
        return realReaddir(p, opts);
      };
      vi.spyOn(fsp, 'readdir').mockImplementation(fake as typeof fsp.readdir);
      return seen;
    }

    it('reads a folder that vanished (ENOENT) as empty, not unreadable', async () => {
      await write('Home.md');
      await write(path.join('.cache', 'a.json'));
      const seen = failReaddir('.cache', ['ENOENT']);
      expect(await snapshotUnmanaged(dir, EMPTY_IGNORE)).toEqual(snap(['Home.md']));
      expect(seen.calls).toBe(1);
    });

    for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
      it(`reads a folder again after a transient ${code}`, async () => {
        await write('Home.md');
        await write(path.join('.cache', 'a.json'));
        const seen = failReaddir('.cache', [code]);
        expect(await snapshotUnmanaged(dir, EMPTY_IGNORE)).toEqual(snap(['Home.md', '.cache/a.json']));
        expect(seen.calls).toBe(2);
      });

      it(`reports a folder that fails ${code} twice as unreadable, not empty`, async () => {
        await write('Home.md');
        await write(path.join('.cache', 'a.json'));
        const seen = failReaddir('.cache', [code, code]);
        expect(await snapshotUnmanaged(dir, EMPTY_IGNORE)).toEqual(snap(['Home.md'], ['.cache']));
        expect(seen.calls).toBe(2);
      });
    }

    it('reads a folder a file replaced (ENOTDIR) as empty, not unreadable', async () => {
      await write('Home.md');
      await write(path.join('.cache', 'a.json'));
      const seen = failReaddir('.cache', ['ENOTDIR']);
      expect(await snapshotUnmanaged(dir, EMPTY_IGNORE)).toEqual(snap(['Home.md']));
      expect(seen.calls).toBe(1);
    });

    it('reports any other error as unreadable without a second read', async () => {
      await write('Home.md');
      await write(path.join('deep', 'er', 'a.json'));
      const seen = failReaddir(path.join('deep', 'er'), ['EIO']);
      expect(await snapshotUnmanaged(dir, EMPTY_IGNORE)).toEqual(snap(['Home.md'], ['deep/er']));
      expect(seen.calls).toBe(1);
    });

    it("names an unreadable vault root '.'", async () => {
      await write('Home.md');
      failReaddir('', ['EPERM', 'EPERM']);
      expect(await snapshotUnmanaged(dir, EMPTY_IGNORE)).toEqual(snap([], ['.']));
    });
  });
});

describe('loadBoundaryIgnore (#190)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'shardmind-190-'));
    await fsp.mkdir(path.join(dir, '.shardmind'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fsp.rm(dir, { recursive: true, force: true });
  });
  const own = (body: string) => fsp.writeFile(path.join(dir, '.shardmind', 'boundary-ignore'), body);

  it('excludes nothing when the file is missing', async () => {
    expect(await loadBoundaryIgnore(dir)).toEqual({ filter: null });
  });

  it('excludes the folders the file lists, matched as .shardmindignore is', async () => {
    await own('# held by a scanner\n.cache/\nscratch\n');
    const { filter, problem } = await loadBoundaryIgnore(dir);
    expect(problem).toBeUndefined();
    expect(filter!.ignores('.cache', true)).toBe(true);
    expect(filter!.ignores('scratch', true)).toBe(true);
    expect(filter!.ignores('brain', true)).toBe(false);
  });

  it.each([['*\n'], ['**\n'], ['/*\n'], ['*\n!keep\n']])('refuses %j, which would switch the check off or cannot be parsed', async (body) => {
    await own(body);
    const { filter, problem } = await loadBoundaryIgnore(dir);
    expect(filter).toBeNull();
    expect(problem).toBeTruthy();
  });

  it.each([['shardmind-*\n'], ['.*\n'], ['*.bin\n']])('applies %j, which excludes some names, not all', async (body) => {
    await own(body);
    const { filter, problem } = await loadBoundaryIgnore(dir);
    expect(problem).toBeUndefined();
    expect(filter).not.toBeNull();
  });

  it('reports a file it cannot read, rather than treating it as empty', async () => {
    await fsp.mkdir(path.join(dir, '.shardmind', 'boundary-ignore'));
    const { filter, problem } = await loadBoundaryIgnore(dir);
    expect(filter).toBeNull();
    expect(problem).toMatch(/could not be read/);
  });

  it('never reads an excluded folder, so it cannot make the walk incomplete', async () => {
    await fsp.mkdir(path.join(dir, '.cache'));
    await fsp.writeFile(path.join(dir, '.cache', 'held.bin'), 'x');
    await fsp.writeFile(path.join(dir, 'Home.md'), 'x');
    await own('.cache/\n');
    const { filter } = await loadBoundaryIgnore(dir);
    const realReaddir = fsp.readdir.bind(fsp);
    let cacheReads = 0;
    const fake = async (p: string, opts: { withFileTypes: true }) => {
      if (path.basename(p) === '.cache') {
        cacheReads += 1;
        throw Object.assign(new Error('EBUSY: injected'), { code: 'EBUSY' });
      }
      return realReaddir(p, opts);
    };
    vi.spyOn(fsp, 'readdir').mockImplementation(fake as typeof fsp.readdir);
    expect(await snapshotUnmanaged(dir, filter!)).toEqual(snap(['Home.md']));
    expect(cacheReads).toBe(0);
  });
});
