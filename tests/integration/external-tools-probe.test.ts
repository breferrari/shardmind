/**
 * The production probe (#138), against real processes on every OS. On
 * Windows a tool is usually an npm `.cmd` shim, which Node will not spawn
 * directly (CVE-2024-27980), so the probe runs it through cmd.exe with only
 * the resolved path and pattern-checked args.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeProbe, resolveExecutable } from '../../source/core/external-tools.js';
import { envWithSearchPath, writeFakeTool as writeTool } from '../helpers/fake-tool.js';

const isWindows = process.platform === 'win32';
let root: string;

/** A probe whose PATH is only `dir` plus the system folders. */
function probeOn(dir: string, timeoutMs = 5_000) {
  return makeProbe({ env: envWithSearchPath([dir]), timeoutMs });
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'shardmind-probe-'));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
});

describe('the production probe', () => {
  it('reads a tool on PATH', async () => {
    const dir = path.join(root, 'ok');
    await writeTool(dir, 'mytool', { win: 'echo mytool 1.2.3', posix: 'echo mytool 1.2.3' });
    expect(await probeOn(dir)('mytool', ['--version'])).toEqual({ kind: 'output', stdout: expect.stringContaining('mytool 1.2.3') });
  });

  it('passes the args through', async () => {
    const dir = path.join(root, 'args');
    await writeTool(dir, 'echoargs', { win: 'echo %*', posix: 'echo "$@"' });
    const outcome = await probeOn(dir)('echoargs', ['version', '--format=json']);
    expect(outcome).toEqual({ kind: 'output', stdout: expect.stringContaining('version --format=json') });
  });

  // A relative entry would resolve against the working directory, which is
  // the vault: a file the shard shipped there must never run as the tool.
  it('ignores relative PATH entries, so a file in the working directory never runs', async () => {
    const vault = path.join(root, 'vault');
    const marker = path.join(root, 'ran-relative');
    await writeTool(vault, 'planted', { win: `echo ran > "${marker}"`, posix: `touch '${marker}'` });
    const previous = process.cwd();
    process.chdir(vault);
    try {
      const env = envWithSearchPath(['.', '']);
      expect(resolveExecutable('planted', env)).toBeUndefined();
      expect(await makeProbe({ env })('planted', ['--version'])).toEqual({ kind: 'not-found' });
    } finally {
      process.chdir(previous);
    }
    await expect(fs.stat(marker)).rejects.toThrow();
  });

  // The default PATHEXT also lists .JS, .VBS and .MSC, which no probe can run.
  it.runIf(isWindows)('takes only .com, .exe, .bat and .cmd from PATHEXT', async () => {
    const dir = path.join(root, 'pathext');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'multi.js'), 'console.log("not me")\n');
    const cmd = await writeTool(dir, 'multi', { win: 'echo multi 1.2.3', posix: 'echo multi 1.2.3' });
    const env = { ...envWithSearchPath([dir]), PATHEXT: '.JS;.VBS;.CMD' };
    expect(resolveExecutable('multi', env)?.toLowerCase()).toBe(cmd.toLowerCase());
    expect(await makeProbe({ env })('multi', ['--version'])).toEqual({ kind: 'output', stdout: expect.stringContaining('multi 1.2.3') });
  });

  it('reports a tool missing from PATH as not found', async () => {
    expect(await probeOn(path.join(root, 'empty'))('shardmind-no-such-tool', ['--version'])).toEqual({ kind: 'not-found' });
  });

  it('reports a non-zero exit', async () => {
    const dir = path.join(root, 'exit');
    await writeTool(dir, 'failing', { win: 'exit /b 3', posix: 'exit 3' });
    expect(await probeOn(dir)('failing', ['--version'])).toEqual({ kind: 'failed', reason: 'exited 3' });
  });

  it('stops a tool that runs past the timeout', async () => {
    const dir = path.join(root, 'slow');
    await writeTool(dir, 'slow', { win: 'ping -n 30 127.0.0.1 >nul', posix: 'sleep 30' });
    const started = Date.now();
    expect(await probeOn(dir, 500)('slow', ['--version'])).toEqual({ kind: 'failed', reason: 'timed out after 0.5s' });
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it('refuses a resolved path that holds a shell metacharacter, before running it', async () => {
    const dir = path.join(root, 'a&b');
    const marker = path.join(root, 'ran-unsafe');
    await writeTool(dir, 'unsafe', { win: `echo ran > "${marker}"`, posix: `touch '${marker}'` });
    const outcome = await probeOn(dir)('unsafe', ['--version']);
    expect(outcome).toMatchObject({ kind: 'failed', reason: expect.stringContaining('unsafe path') });
    await expect(fs.stat(marker)).rejects.toThrow();
  });

  it.each([
    ['a cmd.exe sequence', 'mytool', ['--version&calc']],
    ['a variable', 'mytool', ['%PATH%']],
    ['a hostile name', 'mytool & calc', ['--version']],
    ['a path as the name', '../mytool', ['--version']],
  ])('refuses %s before running anything', async (_name, command, args) => {
    const dir = path.join(root, 'guard');
    const marker = path.join(root, 'ran-guard');
    await writeTool(dir, 'mytool', { win: `echo ran > "${marker}"`, posix: `touch '${marker}'` });
    const outcome = await probeOn(dir)(command, args);
    expect(outcome).toMatchObject({ kind: 'failed', reason: expect.stringMatching(/^unsafe /) });
    await expect(fs.stat(marker)).rejects.toThrow();
  });

  // The CVE-2024-27980 workaround, pinned on a real npm shim.
  it.runIf(isWindows)('reads npm.cmd through cmd.exe', async () => {
    const resolved = resolveExecutable('npm', process.env);
    expect(resolved?.toLowerCase().endsWith('npm.cmd')).toBe(true);
    const outcome = await makeProbe({ env: process.env, timeoutMs: 30_000 })('npm', ['--version']);
    expect(outcome).toEqual({ kind: 'output', stdout: expect.stringMatching(/\d+\.\d+\.\d+/) });
  }, 40_000);

  it.runIf(!isWindows)('reads npm on PATH', async () => {
    const outcome = await makeProbe({ env: process.env, timeoutMs: 30_000 })('npm', ['--version']);
    expect(outcome).toEqual({ kind: 'output', stdout: expect.stringMatching(/\d+\.\d+\.\d+/) });
  }, 40_000);
});
