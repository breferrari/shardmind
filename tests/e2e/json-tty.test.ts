/**
 * `--json` writes one document and nothing else, also when stdout is a
 * terminal (#198). A mounted Ink app used to write cursor and synchronized-
 * output codes around the document (`\x1b[?2026h\x1b[?25l` before it,
 * `\x1b[?25h` after), even though the command renders nothing under --json.
 * Piped output was already clean (tests/e2e/color.test.ts).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DIST_CLI, ensureBuilt } from './helpers/build-once.js';
import { FAKE_TTY_IMPORT } from '../helpers/fake-tty.js';

const ESC = '\x1b';
let cwd: string;

beforeAll(async () => {
  await ensureBuilt();
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'shardmind-e2e-json-tty-'));
});

afterAll(async () => {
  await fs.rm(cwd, { recursive: true, force: true, maxRetries: 5 });
});

/** Runs the CLI with stdout faked as a colour terminal, outside any vault. */
function runInTerminal(args: string[]): { stdout: string; stderr: string; status: number | null } {
  return run(args, true);
}

function run(args: string[], tty: boolean): { stdout: string; stderr: string; status: number | null } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('SHARDMIND_') || key === 'NO_COLOR' || key === 'FORCE_COLOR' || key === 'CI') delete env[key];
  }
  Object.assign(env, { TERM: 'xterm-256color', SHARDMIND_NO_UPDATE_CHECK: '1' });
  const result = spawnSync(process.execPath, [...(tty ? ['--import', FAKE_TTY_IMPORT] : []), DIST_CLI, ...args], {
    cwd,
    env,
    encoding: 'utf-8',
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

describe('--json in a terminal', () => {
  it.each([
    ['update', ['update', '--dry-run', '--json']],
    ['adopt', ['adopt', 'github:acme/demo', '--dry-run', '--json']],
    ['status', ['--json']],
  ])('%s writes one document with no terminal control codes', (_name, args) => {
    const { stdout } = runInTerminal(args);
    expect(stdout).not.toContain(ESC);
    expect(() => JSON.parse(stdout)).not.toThrow();
  }, 90_000);

  it.each([
    ['update', ['update', '--dry-run', '--json']],
    ['status', ['--json']],
    // Would go on to act without --dry-run: refused the same way in both.
    ['update without --dry-run', ['update', '--json']],
  ])('%s writes in a terminal exactly what it writes piped, exit code and stderr included', (_name, args) => {
    const terminal = run(args, true);
    const piped = run(args, false);
    expect(terminal.stdout).toBe(piped.stdout);
    expect(terminal.status).toBe(piped.status);
    expect(terminal.stderr).toBe(piped.stderr);
  }, 120_000);

  it('still draws the interactive UI without --json (control: the fake terminal works)', () => {
    expect(runInTerminal([]).stdout).toContain(ESC);
  }, 90_000);
});
