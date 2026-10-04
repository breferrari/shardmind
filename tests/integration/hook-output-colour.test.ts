/**
 * Hook output is coloured exactly when our own output is (#37).
 *
 * Each scenario runs tests/fixtures/colour/probe.ts in a child process with a
 * minimal environment, because chalk fixes its level once per process. The
 * assertion is agreement, not a particular level, so it survives chalk
 * changing its heuristics. The scenarios are the ones where a hand copy of
 * chalk's rule disagreed with chalk: TERM unset in a terminal, CI with no
 * known vendor, FORCE_COLOR values chalk parses with parseInt.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROBE = path.join(REPO_ROOT, 'tests/fixtures/colour/probe.ts');
const FAKE_TTY =
  'data:text/javascript,' +
  encodeURIComponent(
    "import tty from 'node:tty';" +
      'const isatty = tty.isatty;' +
      'tty.isatty = (fd) => fd === 1 || isatty(fd);' +
      'process.stdout.isTTY = true;',
  );

// Only what a child needs to start; nothing that steers colour (CI vendors,
// TERM, COLORTERM, FORCE_COLOR, NO_COLOR) leaks in from the runner.
const BASE_KEYS = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'];

function probe(env: Record<string, string>, tty: boolean): { ours: boolean; hook: boolean } {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of BASE_KEYS) if (process.env[key] !== undefined) childEnv[key] = process.env[key];
  Object.assign(childEnv, env);
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', ...(tty ? ['--import', FAKE_TTY] : []), PROBE],
    { cwd: REPO_ROOT, env: childEnv, encoding: 'utf-8', timeout: 25_000 },
  );
  if (result.status !== 0) throw new Error(`probe failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as { ours: boolean; hook: boolean };
}

const SCENARIOS: Array<[string, Record<string, string>, boolean]> = [
  ['a terminal with a colour TERM', { TERM: 'xterm-256color' }, true],
  ['a terminal with TERM unset', {}, true],
  ['a terminal with TERM=dumb', { TERM: 'dumb' }, true],
  ['a terminal under CI with no known vendor', { CI: '1' }, true],
  ['a terminal under CI with no vendor and a colour TERM', { CI: '1', TERM: 'xterm' }, true],
  ['a pipe', {}, false],
  ['a terminal under FORCE_COLOR=00', { FORCE_COLOR: '00', TERM: 'xterm' }, true],
  ['a pipe under FORCE_COLOR=00', { FORCE_COLOR: '00' }, false],
  ['a terminal under FORCE_COLOR=-1', { FORCE_COLOR: '-1', TERM: 'xterm' }, true],
  ['a pipe under FORCE_COLOR=-1', { FORCE_COLOR: '-1' }, false],
  ['a pipe under FORCE_COLOR=1', { FORCE_COLOR: '1' }, false],
  ['a terminal under NO_COLOR', { NO_COLOR: '1', TERM: 'xterm' }, true],
  ['a terminal under NO_COLOR and FORCE_COLOR', { NO_COLOR: '1', FORCE_COLOR: '1', TERM: 'xterm' }, true],
];

describe('hook output follows our colour decision', () => {
  const seen: boolean[] = [];

  it.each(SCENARIOS)('agrees in %s', (_name, env, tty) => {
    const { ours, hook } = probe(env, tty);
    seen.push(ours);
    expect(hook).toBe(ours);
  });

  it('covers both coloured and plain runs, so agreement is not vacuous', () => {
    expect(seen).toContain(true);
    expect(seen).toContain(false);
  });
});
