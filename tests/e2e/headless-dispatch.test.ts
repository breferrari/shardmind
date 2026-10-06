/**
 * Which `--json` runs `cli.ts` answers headless (#302): a command must be an
 * own key of its table, and `--version` still goes to Pastel.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import os from 'node:os';
import { ensureBuilt } from './helpers/build-once.js';
import { spawnCli } from './helpers/spawn-cli.js';

beforeAll(async () => {
  await ensureBuilt();
}, 120_000);

describe('headless --json dispatch (#302)', () => {
  it('`constructor --json` is not a headless command: Pastel refuses it, no crash report', async () => {
    const result = await spawnCli(['constructor', '--json'], { cwd: os.tmpdir() });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain('This is a bug in shardmind');
    expect(result.stdout).not.toContain('"ok": false');
  }, 60_000);

  it('`--json --version` prints the version, as without --json', async () => {
    const result = await spawnCli(['--json', '--version'], { cwd: os.tmpdir() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 60_000);
});
