/**
 * `source/core/json-run.ts` (#198): which runs are `--json` runs of update,
 * adopt or status, and making stdout non-interactive for them.
 * See docs/IMPLEMENTATION.md §4.21.
 */

import { describe, it, expect } from 'vitest';
import { isJsonRun, markStdoutNonInteractive } from '../../source/core/json-run.js';

describe('isJsonRun', () => {
  it.each([
    [['--json']],
    [['--json', '--verbose']],
    [['update', '--dry-run', '--json']],
    [['adopt', 'github:acme/demo', '--dry-run', '--json']],
    [['update', '--json=true', '--dry-run']],
    [['--json', 'update', '--dry-run']],
  ])('is a JSON run: %j', (argv) => {
    expect(isJsonRun(argv)).toBe(true);
  });

  it.each([
    [[]],
    [['update', '--dry-run']],
    [['update', '--json', '--help']],
    [['--json', '-h']],
    [['update', '--json=false']],
    [['install', 'github:acme/demo', '--json']],
    [['validate', '--json']],
    [['update', '--', '--json']],
  ])('is not a JSON run: %j', (argv) => {
    expect(isJsonRun(argv)).toBe(false);
  });
});

describe('markStdoutNonInteractive', () => {
  it('makes a terminal stream report it is not a TTY', () => {
    const stream = { isTTY: true } as { isTTY?: boolean };
    markStdoutNonInteractive(stream);
    expect(stream.isTTY).toBe(false);
  });

  it('leaves a piped stream as it is', () => {
    const stream = {} as { isTTY?: boolean };
    markStdoutNonInteractive(stream);
    expect(stream.isTTY).toBeFalsy();
  });
});
