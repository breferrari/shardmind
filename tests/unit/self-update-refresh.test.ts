/**
 * The detached self-update refresh (#285, IMPLEMENTATION §4.19): a command
 * reads the npm cache only, and a stale cache starts one detached child that
 * writes it. Covers the cache-only read, the spawner's marker rules, and the
 * real child against a local npm stub, its hard cap included.
 */

import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  CACHE_FILENAME,
  REFRESH_HARD_CAP_MS,
  REFRESH_MARKER_FILENAME,
  REFRESH_MARKER_TTL_MS,
  readSelfUpdateCache,
  spawnSelfUpdateRefresh,
} from '../../source/core/self-update-check.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fsp.rm(d, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'self-update-refresh-'));
  dirs.push(d);
  return d;
}

async function seed(cacheDir: string, latest: string, checkedAt = new Date()): Promise<void> {
  await fsp.mkdir(cacheDir, { recursive: true });
  await fsp.writeFile(
    path.join(cacheDir, CACHE_FILENAME),
    JSON.stringify({ schema_version: 1, checked_at: checkedAt.toISOString(), latest_version: latest }),
  );
}

/** A spawn that records its calls and returns a child that never runs. */
function fakeSpawn() {
  const calls: Array<{ args: readonly string[]; options: Record<string, unknown> }> = [];
  const children: Array<EventEmitter & { unrefed: boolean }> = [];
  const spawn = ((_cmd: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ args, options });
    const child = Object.assign(new EventEmitter(), {
      unrefed: false,
      unref() {
        child.unrefed = true;
      },
    });
    children.push(child);
    return child as unknown as ChildProcess;
  }) as unknown as typeof nodeSpawn;
  return { spawn, calls, children };
}

const marker = (cacheDir: string) => path.join(cacheDir, REFRESH_MARKER_FILENAME);

describe('readSelfUpdateCache (#285)', () => {
  it('answers from a fresh cache, and never touches the network', async () => {
    const dir = await tempDir();
    await seed(dir, '99.0.0');
    expect(await readSelfUpdateCache({ currentVersion: '0.1.0', cacheDir: dir })).toEqual({
      fresh: true,
      outdated: true,
      latest: '99.0.0',
    });
    await seed(dir, '0.1.0');
    expect(await readSelfUpdateCache({ currentVersion: '0.1.0', cacheDir: dir })).toMatchObject({ fresh: true, outdated: false });
  });

  it('reports a missing or expired cache as not fresh, and an invalid version as null', async () => {
    const dir = await tempDir();
    expect(await readSelfUpdateCache({ currentVersion: '0.1.0', cacheDir: dir })).toEqual({ fresh: false });
    await seed(dir, '99.0.0', new Date(Date.now() - 25 * 60 * 60 * 1000));
    expect(await readSelfUpdateCache({ currentVersion: '0.1.0', cacheDir: dir })).toEqual({ fresh: false });
    expect(await readSelfUpdateCache({ currentVersion: 'not-semver', cacheDir: dir })).toBeNull();
  });
});

describe('spawnSelfUpdateRefresh (#285)', () => {
  it('spawns one detached, unref’d child with no stdio, and takes the marker', async () => {
    const dir = path.join(await tempDir(), 'cache'); // not there yet: the spawner creates it
    const fake = fakeSpawn();
    expect(spawnSelfUpdateRefresh({ currentVersion: '0.1.0', cacheDir: dir, spawn: fake.spawn })).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.options).toMatchObject({ detached: true, stdio: 'ignore', windowsHide: true });
    expect(fake.calls[0]!.args.slice(-2)).toEqual(['0.1.0', dir]);
    expect(fake.children[0]!.unrefed).toBe(true);
    expect(fs.existsSync(marker(dir))).toBe(true);
  });

  it('spawns no second child while the marker is live, and replaces one older than its TTL', async () => {
    const dir = await tempDir();
    const fake = fakeSpawn();
    expect(spawnSelfUpdateRefresh({ currentVersion: '0.1.0', cacheDir: dir, spawn: fake.spawn })).toBe(true);
    expect(spawnSelfUpdateRefresh({ currentVersion: '0.1.0', cacheDir: dir, spawn: fake.spawn })).toBe(false);
    expect(fake.calls).toHaveLength(1);

    // A marker that reads slightly in the future (timestamp granularity) is still live.
    const mtime = fs.statSync(marker(dir)).mtimeMs;
    expect(spawnSelfUpdateRefresh({ currentVersion: '0.1.0', cacheDir: dir, spawn: fake.spawn, now: mtime - 5 })).toBe(false);
    expect(fake.calls).toHaveLength(1);

    // The same marker, seen past its TTL: a killed child's, so it is replaced.
    const later = fs.statSync(marker(dir)).mtimeMs + REFRESH_MARKER_TTL_MS + 1;
    expect(spawnSelfUpdateRefresh({ currentVersion: '0.1.0', cacheDir: dir, spawn: fake.spawn, now: later })).toBe(true);
    expect(fake.calls).toHaveLength(2);
  });

  it('releases the marker when the spawn throws or the child fails to start', async () => {
    const dir = await tempDir();
    const throwing = (() => {
      throw new Error('EAGAIN');
    }) as unknown as typeof nodeSpawn;
    expect(spawnSelfUpdateRefresh({ currentVersion: '0.1.0', cacheDir: dir, spawn: throwing })).toBe(false);
    expect(fs.existsSync(marker(dir))).toBe(false);

    const fake = fakeSpawn();
    expect(spawnSelfUpdateRefresh({ currentVersion: '0.1.0', cacheDir: dir, spawn: fake.spawn })).toBe(true);
    fake.children[0]!.emit('error', new Error('ENOENT'));
    expect(fs.existsSync(marker(dir))).toBe(false);
  });
});

describe('the refresh child (#285)', () => {
  let server: http.Server;
  let url = '';
  let mode: 'answer' | 'hang' = 'answer';
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      if (mode === 'hang') return; // never answers
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: '99.0.0' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/shardmind/latest`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  /** Spawn the real child, keeping a handle to wait for its exit. */
  function spawnReal(cacheDir: string): { started: boolean; exited: Promise<number> } {
    let child: ChildProcess | undefined;
    const capture = ((cmd: string, args: readonly string[], options: Parameters<typeof nodeSpawn>[2]) => {
      child = nodeSpawn(cmd, args, options);
      return child;
    }) as unknown as typeof nodeSpawn;
    const started = spawnSelfUpdateRefresh({ currentVersion: '0.1.0', cacheDir, spawn: capture });
    const exited = new Promise<number>((resolve) => {
      const t0 = Date.now();
      child!.on('exit', () => resolve(Date.now() - t0));
    });
    return { started, exited };
  }

  it('writes the cache atomically and removes its marker', async () => {
    mode = 'answer';
    process.env['SHARDMIND_SELF_UPDATE_REGISTRY_URL'] = url;
    const dir = await tempDir();
    const { started, exited } = spawnReal(dir);
    expect(started).toBe(true);
    await exited;
    const cached = JSON.parse(await fsp.readFile(path.join(dir, CACHE_FILENAME), 'utf-8')) as { latest_version: string };
    expect(cached.latest_version).toBe('99.0.0');
    expect(fs.existsSync(marker(dir))).toBe(false);
    // Only the cache and nothing half-written beside it.
    expect(await fsp.readdir(dir)).toEqual([CACHE_FILENAME]);
  }, 20_000);

  it('exits by its hard cap when npm never answers, even with a long fetch timeout, and writes nothing', async () => {
    mode = 'hang';
    process.env['SHARDMIND_SELF_UPDATE_REGISTRY_URL'] = url;
    process.env['SHARDMIND_SELF_UPDATE_FETCH_TIMEOUT_MS'] = '45000';
    const dir = await tempDir();
    const { started, exited } = spawnReal(dir);
    expect(started).toBe(true);
    const ms = await exited;
    // The fetch gives up 500 ms before the cap; process start-up rides on top.
    expect(ms).toBeLessThan(REFRESH_HARD_CAP_MS + 3_000);
    expect(fs.existsSync(path.join(dir, CACHE_FILENAME))).toBe(false);
    expect(fs.existsSync(marker(dir))).toBe(false);
  }, 20_000);
});
