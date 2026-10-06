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

  it('a root option before the subcommand still runs it headless: `--verbose adopt --json` answers a document (#147, #302)', async () => {
    const result = await spawnCli(['--verbose', 'adopt', 'github:a/b', '--json'], { cwd: os.tmpdir() });
    expect(result.exitCode).toBe(1);
    // --json without --dry-run: the headless runner's refusal, as one document.
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, command: 'adopt', error: { code: 'JSON_REQUIRES_DRY_RUN' } });
  }, 60_000);

  it('an option of the subcommand before it is refused as a document, as Pastel refuses it (#302)', async () => {
    const result = await spawnCli(['--dry-run', 'update', '--json'], { cwd: os.tmpdir() });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      command: 'update',
      error: { code: 'ARGS_INVALID', message: "error: unknown option '--dry-run'" },
    });
  }, 60_000);
});
