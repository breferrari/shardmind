/**
 * `source/core/json-run.ts` (#198): which runs are `--json` runs of update,
 * adopt or status, and making stdout non-interactive for them.
 * See docs/IMPLEMENTATION.md §4.23.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dropTrailingBlankWrites, isJsonRun, markNonInteractive, subcommandOf } from '../../source/core/json-run.js';

describe('isJsonRun', () => {
  it.each([
    [['--json']],
    [['--json', '--verbose']],
    [['update', '--dry-run', '--json']],
    [['adopt', 'github:acme/demo', '--dry-run', '--json']],
    [['--json', 'update', '--dry-run']],
    [['validate', '--json']],
    // Root options (#147) are all boolean flags, so the subcommand after one is still found.
    [['--verbose', 'update', '--dry-run', '--json']],
    [['--no-update-check', 'adopt', 'github:acme/demo', '--json']],
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
    [['update', '--', '--json']],
  ])('is not a JSON run: %j', (argv) => {
    expect(isJsonRun(argv)).toBe(false);
  });
});

describe('--version goes to Pastel, as --help does (#302)', () => {
  it.each([[['--json', '--version']], [['-v', '--json']], [['--version', '--json']]])('%j is not a JSON run', (argv) => {
    expect(isJsonRun(argv)).toBe(false);
  });
});

describe('subcommandOf (#302)', () => {
  it.each([
    [['--json'], undefined],
    [['--verbose', '--json'], undefined],
    [['adopt', 'github:a/b', '--json'], 'adopt'],
    [['--verbose', 'adopt', '--json'], 'adopt'],
    // A value of a root option reads as the subcommand: the run is not the status command.
    [['--values', 'x', '--json'], 'x'],
    // Nothing after `--` is a subcommand.
    [['--json', '--', 'adopt'], undefined],
  ])('%j → %s', (argv, expected) => {
    expect(subcommandOf(argv)).toBe(expected);
  });
});

describe('every command with --json goes through the gate', () => {
  // A command that gains a `json` option must be a JSON run here, or its
  // --json in a terminal would get Ink's cursor codes and live prompts again.
  const commandsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../source/commands');
  // Any `json:` key declared through zod (`zod.` or `z.`), quoted or not, in
  // any command file at any depth, or in a command's Ink-free options module
  // (`options/<command>.ts`, #302); index.tsx and options/status.ts are the
  // status command.
  const declaresJson = /['"]?\bjson['"]?\s*:\s*z(?:od)?\b/;
  const commandOf = (file: string) => {
    const name = file.replace(/\.tsx?$/, '').split(path.sep).join('/');
    if (name === 'options/status') return 'index';
    return name.startsWith('options/') ? name.slice('options/'.length) : name;
  };
  const withJson = [
    ...new Set(
      (fs.readdirSync(commandsDir, { recursive: true }) as string[])
        .filter((file) => file.endsWith('.tsx') || file.startsWith(`options${path.sep}`))
        .filter((file) => declaresJson.test(fs.readFileSync(path.join(commandsDir, file), 'utf-8')))
        .map(commandOf),
    ),
  ];

  it('finds the --json commands', () => {
    expect(withJson).toEqual(expect.arrayContaining(['index', 'update', 'adopt', 'validate']));
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

describe('root options before the subcommand', () => {
  // isJsonRun and jsonCommandOf take the first non-option argument as the
  // subcommand. That holds while every root option is a boolean flag: an
  // option that took a value (`--profile work update --json`) would make the
  // value look like the subcommand.
  it('are all boolean flags', async () => {
    const { options } = await import('../../source/commands/index.js');
    for (const [name, schema] of Object.entries(options.shape)) {
      expect(schema.safeParse(true).success, name).toBe(true);
      expect(schema.safeParse('update').success, name).toBe(false);
    }
  });
});

describe('dropTrailingBlankWrites (#231)', () => {
  /** A stand-in for process.stdout that records what reaches it. */
  function recorder(): { stream: { write: (chunk: unknown, ...rest: unknown[]) => boolean }; out: string[] } {
    const out: string[] = [];
    const stream = {
      write: (chunk: unknown, ...rest: unknown[]): boolean => {
        out.push(String(chunk));
        const callback = rest.find((r) => typeof r === 'function') as (() => void) | undefined;
        callback?.();
        return true;
      },
    };
    return { stream, out };
  }

  it("drops Ink's lone newline after the document", () => {
    const { stream, out } = recorder();
    dropTrailingBlankWrites(stream);
    stream.write('{\n  "ok": true\n}\n');
    stream.write('\n');
    expect(out.join('')).toBe('{\n  "ok": true\n}\n');
  });

  it('passes a lone newline written before any content', () => {
    const { stream, out } = recorder();
    dropTrailingBlankWrites(stream);
    stream.write('\n');
    stream.write('{}\n');
    expect(out.join('')).toBe('\n{}\n');
  });

  it('passes every write that carries content', () => {
    const { stream, out } = recorder();
    dropTrailingBlankWrites(stream);
    stream.write('{\n');
    stream.write('}\n');
    stream.write('x\n');
    expect(out.join('')).toBe('{\n}\nx\n');
  });

  it("still calls a dropped write's callback, which Ink's exit barrier waits on", () => {
    const { stream } = recorder();
    dropTrailingBlankWrites(stream);
    stream.write('{}\n');
    let called = false;
    const returned = stream.write('\n', () => (called = true));
    expect(called).toBe(true);
    expect(returned).toBe(true);
  });
});
