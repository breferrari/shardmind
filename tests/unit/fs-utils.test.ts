import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { looksBinary, removePath } from '../../source/core/fs-utils.js';

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
