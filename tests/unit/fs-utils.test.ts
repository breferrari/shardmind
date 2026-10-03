import { describe, it, expect } from 'vitest';
import { looksBinary } from '../../source/core/fs-utils.js';

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
