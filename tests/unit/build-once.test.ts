/**
 * The E2E build guard (#176).
 *
 * `dist/` is built once per vitest run, in the main process, by the global
 * setup. Workers only check that it exists. Before #176 every E2E worker ran
 * its own `tsup` when `dist/` was stale, and tsup's `clean: true` emptied
 * `dist/` under any test that was spawning `dist/cli.js` at that moment.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';
import {
  DIST_ARTIFACTS,
  buildForRun,
  buildIfStale,
  ensureBuilt,
  type BuildRunner,
} from '../e2e/helpers/build-once.js';
import { createSetup, type SetupProject } from '../global-setup.js';
import { pathExists } from '../../source/core/fs-utils.js';
import config from '../../vitest.config.js';
import tsupConfig from '../../tsup.config.js';

const OLD = new Date('2026-01-01T00:00:00Z');
const NEW = new Date('2026-06-01T00:00:00Z');

let root: string;

async function write(rel: string, mtime: Date): Promise<void> {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, rel);
  await fs.utimes(full, mtime, mtime);
}

/** Writes every artifact the CLI loads, except `skip`. */
async function writeDist(mtime: Date, skip: string[] = []): Promise<void> {
  for (const rel of DIST_ARTIFACTS) if (!skip.includes(rel)) await write(rel, mtime);
}

function exists(rel: string): Promise<boolean> {
  return pathExists(path.join(root, rel));
}

function result(status: number | null, stderr = ''): SpawnSyncReturns<string> {
  return { pid: 0, output: [], stdout: '', stderr, status, signal: null };
}

/**
 * A runner that counts its calls and, on success, writes `dist/` the way tsup
 * would, minus any artifact in `omit`.
 */
function fakeRunner(
  statuses: number[],
  omit: string[] = [],
): { run: BuildRunner; calls: () => number } {
  let calls = 0;
  const run: BuildRunner = () => {
    const status = statuses[calls] ?? 0;
    calls += 1;
    if (status !== 0) return result(status, 'boom: tsup failed');
    // spawnSync is synchronous, so the fake writes synchronously too.
    for (const rel of DIST_ARTIFACTS) {
      if (omit.includes(rel)) continue;
      const full = path.join(root, rel);
      fsSync.mkdirSync(path.dirname(full), { recursive: true });
      fsSync.writeFileSync(full, 'built');
    }
    return result(0);
  };
  return { run, calls: () => calls };
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

describe('DIST_ARTIFACTS', () => {
  it('names one artifact per entry in tsup.config.ts', () => {
    // Drift guard: a command added to tsup.config.ts must be checked too.
    // tsup.config.ts exports an array of plain option objects with object entries.
    const configs = [tsupConfig].flat() as Array<{ entry: Record<string, string> }>;
    const fromConfig = configs.flatMap((c) => Object.keys(c.entry).map((name) => `dist/${name}.js`));
    expect([...DIST_ARTIFACTS].sort()).toEqual(fromConfig.sort());
  });

  it('lists every file the spawned CLI loads', () => {
    expect(DIST_ARTIFACTS).toEqual(
      expect.arrayContaining([
        'dist/cli.js',
        'dist/runtime/index.js',
        'dist/commands/index.js',
        'dist/commands/install.js',
        'dist/commands/update.js',
        'dist/commands/adopt.js',
        'dist/internal/hook-runner.js',
      ]),
    );
  });
});

describe('buildIfStale (global setup)', () => {
  it('builds once when a source file is newer than dist/', async () => {
    await writeDist(OLD);
    await write('source/core/state.ts', NEW);
    const { run, calls } = fakeRunner([0]);

    await buildIfStale(root, run);

    expect(calls()).toBe(1);
  });

  it('does not build when dist/ is newer than every input', async () => {
    await writeDist(NEW);
    const { run, calls } = fakeRunner([0]);

    await buildIfStale(root, run);

    expect(calls()).toBe(0);
  });

  it.each(['dist/cli.js', 'dist/runtime/index.js', 'dist/commands/install.js'])(
    'builds when %s is missing even if the rest of dist/ is fresh',
    async (missing) => {
      await writeDist(NEW, [missing]);
      const { run, calls } = fakeRunner([0]);

      await buildIfStale(root, run);

      expect(calls()).toBe(1);
      expect(await exists(missing)).toBe(true);
    },
  );

  it('builds when one artifact is older than the sources, even if another is newer', async () => {
    // The oldest artifact decides: an interrupted build can leave a fresh
    // cli.js beside a stale command file.
    await writeDist(NEW);
    await write('dist/commands/install.js', OLD);
    await write('source/core/state.ts', new Date('2026-03-01T00:00:00Z'));
    const { run, calls } = fakeRunner([0]);

    await buildIfStale(root, run);

    expect(calls()).toBe(1);
  });

  it('builds when a build-config file is newer than dist/', async () => {
    await writeDist(OLD);
    await write('tsup.config.ts', NEW);
    const { run, calls } = fakeRunner([0]);

    await buildIfStale(root, run);

    expect(calls()).toBe(1);
  });

  it('retries a failed build once and succeeds', async () => {
    const { run, calls } = fakeRunner([1, 0]);

    await buildIfStale(root, run);

    expect(calls()).toBe(2);
  });

  it('throws with the failure reason when both attempts fail', async () => {
    const { run, calls } = fakeRunner([1, 1]);

    await expect(buildIfStale(root, run)).rejects.toThrow(/exit code 1 \(retried once\)[\s\S]*boom/);
    expect(calls()).toBe(2);
  });

  it('throws, naming the file, when a successful build leaves an artifact missing', async () => {
    const { run } = fakeRunner([0], ['dist/runtime/index.js']);

    await expect(buildIfStale(root, run)).rejects.toThrow(/dist[\\/]runtime[\\/]index\.js/);
  });
});

describe('buildForRun', () => {
  it('returns null when the build succeeds', async () => {
    const { run } = fakeRunner([0]);

    expect(await buildForRun(root, run)).toBeNull();
  });

  it('keeps the stack of an unexpected error', async () => {
    const run: BuildRunner = () => {
      throw new TypeError('setup bug');
    };

    expect(await buildForRun(root, run)).toMatch(/TypeError: setup bug\n\s+at /);
  });

  it('returns the failure instead of throwing, so unit-only runs still start', async () => {
    const { run } = fakeRunner([1, 1]);

    expect(await buildForRun(root, run)).toMatch(/exit code 1 \(retried once\)[\s\S]*boom/);
  });
});

describe('ensureBuilt (workers)', () => {
  it('never writes dist/ when it is stale', async () => {
    await writeDist(OLD);
    await write('source/core/state.ts', NEW);
    const before = (await fs.stat(path.join(root, 'dist/cli.js'))).mtimeMs;

    await ensureBuilt(root, null);

    // Still the stale file: a worker leaves dist/ to the global setup.
    expect((await fs.stat(path.join(root, 'dist/cli.js'))).mtimeMs).toBe(before);
    expect(await fs.readFile(path.join(root, 'dist/cli.js'), 'utf-8')).toBe('dist/cli.js');
  });

  it('rejects, naming the global setup, when dist/cli.js is missing', async () => {
    await writeDist(NEW, ['dist/cli.js']);

    await expect(ensureBuilt(root, null)).rejects.toThrow(/global setup/);
    expect(await exists('dist/cli.js')).toBe(false);
  });

  it('rejects when a command file is missing', async () => {
    await writeDist(NEW, ['dist/commands/update.js']);

    await expect(ensureBuilt(root, null)).rejects.toThrow(/dist[\\/]commands[\\/]update\.js/);
  });

  it("rejects with the global setup's build failure when it has one", async () => {
    await writeDist(NEW);

    await expect(ensureBuilt(root, 'tsup build failed with exit code 2')).rejects.toThrow(
      /could not build dist\/[\s\S]*exit code 2/,
    );
  });
});

describe('global setup', () => {
  function fakeProject(): SetupProject & {
    provided: Map<string, unknown>;
    rerun: () => Promise<void>;
  } {
    const provided = new Map<string, unknown>();
    let onRerun: Parameters<SetupProject['onTestsRerun']>[0] | undefined;
    return {
      provided,
      provide: (key, value) => {
        provided.set(key, value);
      },
      onTestsRerun: (cb) => {
        onRerun = cb;
      },
      rerun: async () => {
        await onRerun?.([]);
      },
    };
  }

  // A stand-in for the PTY probe: these cases never spawn a terminal.
  const CAPS = { works: true, verbatim: false, signals: false };
  const probe = async () => CAPS;

  it('provides null to the workers when the build succeeds', async () => {
    const project = fakeProject();

    await createSetup(async () => null, probe)(project);

    expect(project.provided.get('distBuildError')).toBeNull();
  });

  it('provides the probed PTY capabilities, for the Layer 2 gates (#174)', async () => {
    const project = fakeProject();

    await createSetup(async () => null, probe)(project);

    expect(project.provided.get('ptyCapabilities')).toEqual(CAPS);
  });

  it('provides the failure instead of throwing when the build fails, and warns', async () => {
    const project = fakeProject();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await createSetup(async () => 'boom', probe)(project);

      expect(project.provided.get('distBuildError')).toBe('boom');
      // A run that spawns nothing still says dist/ is broken.
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not build dist\/[\s\S]*boom/));
    } finally {
      warn.mockRestore();
    }
  });

  it('rebuilds before a watch-mode rerun and provides the new result', async () => {
    const project = fakeProject();
    const results = [null, 'type error after an edit'];
    let builds = 0;

    await createSetup(async () => results[builds++] ?? null, probe)(project);
    await project.rerun();

    expect(builds).toBe(2);
    expect(project.provided.get('distBuildError')).toBe('type error after an edit');
  });

  it('is registered in vitest.config.ts, so it runs before any worker starts', () => {
    expect(config.test?.globalSetup).toContain('tests/global-setup.ts');
  });
});
