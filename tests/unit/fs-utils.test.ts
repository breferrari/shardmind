import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { looksBinary, mapConcurrent, removePath } from '../../source/core/fs-utils.js';

// git's convention: a NUL byte in the first 8 KB means binary. The update
// planner relies on it to keep binary files out of the line merge (#63), and
// the adopt planner to skip the text diff.
describe('looksBinary', () => {
  it('is false for text, empty and invalid-UTF-8-without-NUL buffers', () => {
    expect(looksBinary(Buffer.from('# Notes\n\nplain text\n'))).toBe(false);
    expect(looksBinary(Buffer.alloc(0))).toBe(false);
    expect(looksBinary(Buffer.from([0xc3, 0x28, 0xff, 0xfe]))).toBe(false);
  });

  it('is true for a NUL anywhere in the first 8 KB', () => {
    expect(looksBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]))).toBe(true);
    const late = Buffer.alloc(8192, 0x61);
    late[8191] = 0;
    expect(looksBinary(late)).toBe(true);
  });

  it('only reads the first 8 KB, so a NUL after it reads as text', () => {
    const buf = Buffer.alloc(8193, 0x61);
    buf[8192] = 0;
    expect(looksBinary(buf)).toBe(false);
  });
});

describe('removePath (#191)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const errno = (code: string) => Object.assign(new Error(`${code}: injected`), { code });

  /** Fail `fsp.rm` with `codes`, one per call, then remove for real. Returns the call count. */
  function failRm(codes: string[]): { calls: number } {
    const realRm = fsp.rm.bind(fsp);
    const seen = { calls: 0 };
    vi.spyOn(fsp, 'rm').mockImplementation(async (p, opts) => {
      seen.calls += 1;
      const code = codes[seen.calls - 1];
      if (code) throw errno(code);
      return realRm(p, opts);
    });
    return seen;
  }

  async function tree(): Promise<string> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'shardmind-191-'));
    await fsp.mkdir(path.join(dir, 'a', 'b'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'a', 'b', 'f.md'), 'x');
    return dir;
  }

  const gone = (p: string) => fsp.access(p).then(() => false, () => true);

  it('removes a folder tree, and a path that does not exist', async () => {
    const dir = await tree();
    await removePath(dir);
    expect(await gone(dir)).toBe(true);
    await expect(removePath(dir)).resolves.toBeUndefined();
  });

  for (const code of ['ENOTEMPTY', 'EBUSY', 'EPERM']) {
    it(`retries a ${code} that clears, and removes the tree`, async () => {
      const dir = await tree();
      const seen = failRm([code]);
      await removePath(dir, { retryDelay: 1 });
      expect(seen.calls).toBe(2);
      expect(await gone(dir)).toBe(true);
    });
  }

  it('surfaces the original error when it does not clear within maxRetries', async () => {
    const dir = await tree();
    const seen = failRm(['EBUSY', 'EBUSY', 'EBUSY', 'EBUSY']);
    await expect(removePath(dir, { maxRetries: 3, retryDelay: 1 })).rejects.toMatchObject({ code: 'EBUSY', message: 'EBUSY: injected' });
    expect(seen.calls).toBe(4);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('does not retry an error a retry cannot fix', async () => {
    const seen = failRm(['EACCES']);
    await expect(removePath(path.join(os.tmpdir(), 'shardmind-191-none'), { retryDelay: 1 })).rejects.toMatchObject({ code: 'EACCES' });
    expect(seen.calls).toBe(1);
  });
});

describe('mapConcurrent (#274)', () => {
  const tick = () => new Promise<void>((r) => setTimeout(r, 5));

  it('keeps the order of results and runs at most `concurrency` tasks at once', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapConcurrent([1, 2, 3, 4, 5, 6], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await tick();
      running--;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60]);
    expect(peak).toBe(2);
  });

  it('starts no task after one fails, and rejects only once the running ones have finished', async () => {
    const started: number[] = [];
    const finished: number[] = [];
    const run = mapConcurrent([0, 1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      started.push(n);
      if (n === 1) throw new Error('task 1 failed');
      await tick();
      await tick();
      finished.push(n);
      return n;
    });
    await expect(run).rejects.toThrow('task 1 failed');
    // Tasks 0 and 2 were running when 1 failed: they finished before the
    // rejection, and nothing after them started.
    expect([...finished].sort()).toEqual([0, 2]);
    expect([...started].sort()).toEqual([0, 1, 2]);
    // And nothing runs once the caller has its rejection.
    await tick();
    await tick();
    await tick();
    expect([...started].sort()).toEqual([0, 1, 2]);
  });

  it('rejects with the first error when several tasks fail', async () => {
    await expect(
      mapConcurrent([0, 1, 2], 3, async (n) => {
        await new Promise((r) => setTimeout(r, n === 0 ? 1 : 10));
        throw new Error(`task ${n} failed`);
      }),
    ).rejects.toThrow('task 0 failed');
  });

  it('lands no file write after it rejects, when task 1 fails while task 2 is still writing', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'map-concurrent-'));
    try {
      const items = ['a', 'fail', 'b', 'c', 'd', 'e'];
      await expect(
        mapConcurrent(items, 2, async (name) => {
          if (name === 'fail') throw new Error('task 1 failed');
          await new Promise((r) => setTimeout(r, 20));
          await fsp.writeFile(path.join(dir, name), name);
        }),
      ).rejects.toThrow('task 1 failed');
      const atRejection = (await fsp.readdir(dir)).sort();
      await new Promise((r) => setTimeout(r, 100));
      // The write already under way (task 0) landed before the rejection;
      // nothing was written after it.
      expect(atRejection).toEqual(['a']);
      expect((await fsp.readdir(dir)).sort()).toEqual(atRejection);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
