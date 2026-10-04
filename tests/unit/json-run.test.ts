/**
 * `source/core/json-run.ts` (#198): which runs are `--json` runs of update,
 * adopt or status, and making stdout non-interactive for them.
 * See docs/IMPLEMENTATION.md §4.21.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isJsonRun, markNonInteractive } from '../../source/core/json-run.js';

describe('isJsonRun', () => {
  it.each([
    [['--json']],
    [['--json', '--verbose']],
    [['update', '--dry-run', '--json']],
    [['adopt', 'github:acme/demo', '--dry-run', '--json']],
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
    [['update', '--json=true', '--dry-run']],
    [['install', 'github:acme/demo', '--json']],
    [['validate', '--json']],
    [['update', '--', '--json']],
  ])('is not a JSON run: %j', (argv) => {
    expect(isJsonRun(argv)).toBe(false);
  });
});

describe('every command with --json goes through the gate', () => {
  // A command that gains a `json` option must be a JSON run here, or its
  // --json in a terminal would get Ink's cursor codes and live prompts again.
  // `validate --json` never mounts Ink (#34), so it is exempt.
  const commandsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../source/commands');
  const withJson = fs
    .readdirSync(commandsDir)
    .filter((file) => file.endsWith('.tsx'))
    .filter((file) => /^\s*json:\s*zod/m.test(fs.readFileSync(path.join(commandsDir, file), 'utf-8')))
    .map((file) => file.replace(/\.tsx$/, ''))
    .filter((name) => name !== 'validate');

  it('finds the --json commands', () => {
    expect(withJson).toEqual(expect.arrayContaining(['index', 'update', 'adopt']));
  });

  it.each(withJson)('%s --json is a JSON run', (name) => {
    expect(isJsonRun(name === 'index' ? ['--json'] : [name, '--json'])).toBe(true);
  });
});

describe('markNonInteractive', () => {
  it('makes a terminal stream report it is not a TTY', () => {
    const stream = { isTTY: true } as { isTTY?: boolean };
    markNonInteractive(stream);
    expect(stream.isTTY).toBe(false);
  });

  it('leaves a piped stream as it is', () => {
    const stream = {} as { isTTY?: boolean };
    markNonInteractive(stream);
    expect(stream.isTTY).toBeFalsy();
  });
});
