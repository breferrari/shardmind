/**
 * Colour follows the environment (#37, docs/ARCHITECTURE.md §10).
 *
 * A real terminal is faked with a `node --import` preload that runs before
 * the CLI loads: chalk detects a TTY with `tty.isatty(1)`, so the preload
 * patches that (and `process.stdout.isTTY`, which Ink reads).
 * That keeps the scenarios on all three OSes; Layer 2 PTY tests skip
 * Windows.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DIST_CLI, ensureBuilt } from './helpers/build-once.js';
import { FAKE_TTY_IMPORT as FAKE_TTY } from '../helpers/fake-tty.js';

// Any SGR sequence: colour, dim, bold, reset. Ink's cursor codes end in other letters.
const SGR = /\x1b\[[0-9;]*m/;
const ESC = '\x1b';

let cwd: string;

beforeAll(async () => {
  await ensureBuilt();
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'shardmind-e2e-color-'));
});

afterAll(async () => {
  await fs.rm(cwd, { recursive: true, force: true, maxRetries: 5 });
});

/** Runs the CLI with only the colour variables given, plus a colour-capable TERM. */
function run(args: string[], colorEnv: Record<string, string>, opts: { tty: boolean }): string {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('SHARDMIND_') || key === 'NO_COLOR' || key === 'FORCE_COLOR') delete env[key];
  }
  Object.assign(env, { TERM: 'xterm-256color', SHARDMIND_NO_UPDATE_CHECK: '1' }, colorEnv);
  const nodeArgs = opts.tty ? ['--import', FAKE_TTY] : [];
  const result = spawnSync(process.execPath, [...nodeArgs, DIST_CLI, ...args], {
    cwd,
    env,
    encoding: 'utf-8',
    timeout: 25_000,
  });
  if (result.error) throw result.error;
  return result.stdout;
}

describe('colour environment', () => {
  it('colours a terminal by default (control: the fake TTY works)', () => {
    expect(run([], {}, { tty: true })).toMatch(SGR);
  });

  it('drops colour in a terminal when NO_COLOR is set', () => {
    expect(run([], { NO_COLOR: '1' }, { tty: true })).not.toMatch(SGR);
  });

  it('ignores an empty NO_COLOR', () => {
    expect(run([], { NO_COLOR: '' }, { tty: true })).toMatch(SGR);
  });

  it('lets FORCE_COLOR win over NO_COLOR', () => {
    expect(run([], { NO_COLOR: '1', FORCE_COLOR: '1' }, { tty: true })).toMatch(SGR);
  });

  it('keeps colour when piped under FORCE_COLOR', () => {
    expect(run([], { FORCE_COLOR: '1' }, { tty: false })).toMatch(SGR);
  });

  // Pins a contract that holds without #37 too: Commander's help is never styled.
  it('prints --help without ANSI under NO_COLOR', () => {
    const out = run(['install', '--help'], { NO_COLOR: '1' }, { tty: true });
    expect(out).toContain('install');
    expect(out).not.toContain(ESC);
  });

  // Pins the --json contract, which holds without #37 too: the document is
  // JSON.stringify written outside Ink, so no colour variable can reach it.
  it.each<Record<string, string>>([{ FORCE_COLOR: '3' }, { NO_COLOR: '1' }, {}])(
    'writes --json without ANSI for a consumer, under %o',
    (colorEnv) => {
      const out = run(['update', '--json'], colorEnv, { tty: false });
      expect(out).not.toContain(ESC);
      expect(() => JSON.parse(out)).not.toThrow();
    },
  );
});
