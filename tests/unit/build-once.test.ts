/**
 * The E2E build guard (#176).
 *
 * `dist/` is built once per vitest run, in the main process, by the global
 * setup. Workers only check that it exists. Before #176 every E2E worker ran
 * its own `tsup` when `dist/` was stale, and tsup's `clean: true` emptied
 * `dist/` under any test that was spawning `dist/cli.js` at that moment.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';
import { buildIfStale, ensureBuilt, type BuildRunner } from '../e2e/helpers/build-once.js';
import config from '../../vitest.config.js';

const OLD = new Date('2026-01-01T00:00:00Z');
const NEW = new Date('2026-06-01T00:00:00Z');

let root: string;

async function write(rel: string, mtime: Date): Promise<void> {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, rel);
  await fs.utimes(full, mtime, mtime);
}

async function exists(rel: string): Promise<boolean> {
  return fs
    .access(path.join(root, rel))
    .then(() => true)
    .catch(() => false);
}

function result(status: number | null, stderr = ''): SpawnSyncReturns<string> {
  return { pid: 0, output: [], stdout: '', stderr, status, signal: null };
}

/** A runner that records its calls and, on success, writes `dist/` the way tsup would. */
function fakeRunner(statuses: number[]): BuildRunner & { calls: number } {
  const run = Object.assign(
    (_capture: boolean): SpawnSyncReturns<string> => {
      const status = statuses[run.calls] ?? 0;
      run.calls += 1;
      if (status !== 0) return result(status, 'boom: tsup failed');
      // spawnSync is synchronous, so the fake writes synchronously too.
      for (const rel of ['dist/cli.js', 'dist/runtime/index.js']) {
        const full = path.join(root, rel);
        fsSync.mkdirSync(path.dirname(full), { recursive: true });
        fsSync.writeFileSync(full, 'built');
      }
      return result(0);
    },
    { calls: 0 },
  );
  return run;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'shardmind-build-once-'));
  await write('source/cli.ts', OLD);
  await write('source/core/state.ts', OLD);
  for (const f of ['tsup.config.ts', 'tsconfig.json', 'package.json']) await write(f, OLD);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('buildIfStale (global setup)', () => {
  it('builds once when a source file is newer than dist/', async () => {
    await write('dist/cli.js', OLD);
    await write('dist/runtime/index.js', OLD);
    await write('source/core/state.ts', NEW);
    const run = fakeRunner([0]);

    await buildIfStale(root, run);

    expect(run.calls).toBe(1);
  });

  it('does not build when dist/ is newer than every input', async () => {
    await write('dist/cli.js', NEW);
    await write('dist/runtime/index.js', NEW);
    const run = fakeRunner([0]);

    await buildIfStale(root, run);

    expect(run.calls).toBe(0);
  });

  it('builds when dist/cli.js is missing even if dist/runtime is fresh', async () => {
    await write('dist/runtime/index.js', NEW);
    const run = fakeRunner([0]);

    await buildIfStale(root, run);

    expect(run.calls).toBe(1);
    expect(await exists('dist/cli.js')).toBe(true);
  });

  it('builds when a build-config file is newer than dist/', async () => {
    await write('dist/cli.js', OLD);
    await write('dist/runtime/index.js', OLD);
    await write('tsup.config.ts', NEW);
    const run = fakeRunner([0]);

    await buildIfStale(root, run);

    expect(run.calls).toBe(1);
  });

  it('retries a failed build once and succeeds', async () => {
    const run = fakeRunner([1, 0]);

    await buildIfStale(root, run);

    expect(run.calls).toBe(2);
  });

  it('throws with the failure reason when both attempts fail', async () => {
    const run = fakeRunner([1, 1]);

    await expect(buildIfStale(root, run)).rejects.toThrow(/exit code 1 \(retried once\)[\s\S]*boom/);
    expect(run.calls).toBe(2);
  });
});

describe('ensureBuilt (workers)', () => {
  it('never writes dist/ when it is stale', async () => {
    await write('dist/cli.js', OLD);
    await write('dist/runtime/index.js', OLD);
    await write('source/core/state.ts', NEW);
    const before = (await fs.stat(path.join(root, 'dist/cli.js'))).mtimeMs;

    await ensureBuilt(root);

    // Still the stale file: a worker leaves dist/ to the global setup.
    expect((await fs.stat(path.join(root, 'dist/cli.js'))).mtimeMs).toBe(before);
    expect(await fs.readFile(path.join(root, 'dist/cli.js'), 'utf-8')).toBe('dist/cli.js');
  });

  it('rejects, naming the global setup, when dist/cli.js is missing', async () => {
    await write('dist/runtime/index.js', NEW);

    await expect(ensureBuilt(root)).rejects.toThrow(/global setup/);
    expect(await exists('dist/cli.js')).toBe(false);
  });

  it('rejects when dist/runtime/index.js is missing', async () => {
    await write('dist/cli.js', NEW);

    await expect(ensureBuilt(root)).rejects.toThrow(/dist[\\/]runtime[\\/]index\.js/);
  });
});

describe('vitest config', () => {
  it('builds dist/ in a global setup, before any worker starts', () => {
    const globalSetup = config.test?.globalSetup;
    const files = Array.isArray(globalSetup) ? globalSetup : [globalSetup];
    expect(files).toContain('tests/global-setup.ts');
  });
});
