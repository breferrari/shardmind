/**
 * `shardmind validate` (#34), spawned as the CLI: a shard directory or a
 * reference through the local GitHub stub. It never runs shard code, its
 * --json carries no terminal control codes even in a terminal (it never
 * mounts Ink), and a downloaded copy leaves no temp dir behind.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIST_CLI, ensureBuilt } from './helpers/build-once.js';
import { createGitHubStub, type GitHubStub } from './helpers/github-stub.js';
import { buildTarballFixtures, cleanupTarballFixtures } from './helpers/tarball.js';
import { FAKE_TTY_IMPORT as FAKE_TTY } from '../helpers/fake-tty.js';
import * as tar from 'tar';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MINIMAL_SHARD = path.resolve(__dirname, '../../examples/minimal-shard');
const SLUG = 'acme/validate-demo';
const BIG_SLUG = 'acme/validate-big';

let work: string;
let stub: GitHubStub;

beforeAll(async () => {
  await ensureBuilt();
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'shardmind-e2e-validate-'));
  const fixtures = await buildTarballFixtures();
  // A shard whose archive inflates past a small cap: 64 KiB of zeros.
  const bigSrc = path.join(work, 'big-src', 'shard');
  await fs.cp(MINIMAL_SHARD, bigSrc, { recursive: true });
  await fs.writeFile(path.join(bigSrc, 'big.bin'), Buffer.alloc(64 * 1024));
  const bigTarball = path.join(work, 'big.tar.gz');
  await tar.c({ gzip: true, file: bigTarball, cwd: path.dirname(bigSrc) }, ['shard']);
  stub = await createGitHubStub({
    shards: {
      [SLUG]: { versions: { '0.1.0': fixtures.byVersion['0.1.0'] }, latest: '0.1.0' },
      [BIG_SLUG]: { versions: { '0.1.0': bigTarball }, latest: '0.1.0' },
    },
  });
}, 90_000);

afterAll(async () => {
  await stub?.close();
  await cleanupTarballFixtures();
  await fs.rm(work, { recursive: true, force: true, maxRetries: 5 });
});

interface Run {
  stdout: string;
  /** stdout with whitespace collapsed, for matching the human view's lines. */
  text: string;
  status: number | null;
}

/** Runs the CLI in `work`, with its own temp dir so leftovers can be checked. */
async function run(args: string[], opts: { tty?: boolean; tmp?: string; env?: Record<string, string> } = {}): Promise<Run> {
  const env: NodeJS.ProcessEnv = { ...process.env, SHARDMIND_NO_UPDATE_CHECK: '1', SHARDMIND_GITHUB_API_BASE: stub.url };
  if (opts.tmp) Object.assign(env, { TMPDIR: opts.tmp, TEMP: opts.tmp, TMP: opts.tmp });
  if (opts.env) Object.assign(env, opts.env);
  const nodeArgs = opts.tty ? ['--import', FAKE_TTY] : [];
  // Async spawn: the stub runs in this process, so a sync spawn would block it.
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, DIST_CLI, ...args], { cwd: work, env });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf-8')));
    child.on('error', reject);
    // A long path wraps the human summary at the pipe's width: read it as text.
    child.on('close', (status) => resolve({ stdout, text: stdout.replace(/\s+/g, ' '), status }));
  });
}

async function copyShard(name: string): Promise<string> {
  const dir = path.join(work, name);
  await fs.cp(MINIMAL_SHARD, dir, { recursive: true });
  return dir;
}

describe('shardmind validate (#34)', () => {
  it('finds nothing in the minimal shard and exits 0', async () => {
    const result = await run(['validate', MINIMAL_SHARD]);
    expect(result.status).toBe(0);
    expect(result.text).toMatch(/0 errors, 0 warnings/);
  });

  it('reports every broken template with its code and path, and exits 1', async () => {
    const dir = await copyShard('broken');
    await fs.writeFile(path.join(dir, 'brain', 'Broken.md.njk'), '{% if %}\n');
    const result = await run(['validate', dir]);
    expect(result.status).toBe(1);
    expect(result.text).toMatch(/brain\/Broken\.md/);
    expect(result.text).toMatch(/RENDER_/);
  });

  it('writes --json with no terminal control codes even in a terminal', async () => {
    const dir = await copyShard('json-broken');
    await fs.writeFile(path.join(dir, 'brain', 'Broken.md.njk'), '{% if %}\n');
    const clean = await run(['validate', MINIMAL_SHARD, '--json'], { tty: true });
    expect(clean.stdout).not.toContain('\x1b');
    expect(clean.status).toBe(0);
    expect(JSON.parse(clean.stdout)).toMatchObject({ command: 'validate', ok: true, result: { errors: 0 } });
    const broken = await run(['validate', dir, '--json'], { tty: true });
    expect(broken.stdout).not.toContain('\x1b');
    expect(broken.status).toBe(1);
    expect(JSON.parse(broken.stdout).result.errors).toBeGreaterThan(0);
  });

  it('never runs shard code: a hook that would write a marker does not run', async () => {
    const dir = await copyShard('hooked');
    const marker = path.join(work, 'hook-ran');
    const hook = `import { writeFileSync } from 'node:fs';\nexport default async function () { writeFileSync(${JSON.stringify(marker)}, 'x'); }\n`;
    await fs.writeFile(path.join(dir, '.shardmind', 'hooks', 'marker.ts'), hook).catch(async () => {
      await fs.mkdir(path.join(dir, '.shardmind', 'hooks'), { recursive: true });
      await fs.writeFile(path.join(dir, '.shardmind', 'hooks', 'marker.ts'), hook);
    });
    const manifest = path.join(dir, '.shardmind', 'shard.yaml');
    const yaml = (await fs.readFile(manifest, 'utf-8')).replace(
      /hooks:[\s\S]*$/,
      'hooks:\n  bootstrap:\n    script: .shardmind/hooks/marker.ts\n  personalize: .shardmind/hooks/marker.ts\n',
    );
    await fs.writeFile(manifest, yaml);
    await run(['validate', dir]);
    await run(['validate', dir, '--json']);
    await expect(fs.access(marker)).rejects.toBeTruthy();
  });

  it('checks a shard reference through the download path and leaves no temp dir', async () => {
    const tmp = await fs.mkdtemp(path.join(work, 'tmp-'));
    const result = await run(['validate', `github:${SLUG}`, '--json'], { tmp });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, result: { target: `github:${SLUG}`, errors: 0 } });
    expect((await fs.readdir(tmp)).filter((n) => n.startsWith('shardmind-'))).toEqual([]);
  });

  it('stops a reference that extracts past the size limit, and leaves no temp dir (#32)', async () => {
    const tmp = await fs.mkdtemp(path.join(work, 'tmp-big-'));
    const result = await run(['validate', `github:${BIG_SLUG}`, '--json'], { tmp, env: { SHARDMIND_MAX_SHARD_SIZE: '4K' } });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: 'SHARD_TOO_LARGE' } });
    expect((await fs.readdir(tmp)).filter((n) => n.startsWith('shardmind-'))).toEqual([]);
  });

  it('prints help for --help even with --json', async () => {
    const result = await run(['validate', '--help', '--json']);
    expect(result.status).toBe(0);
    expect(result.text).toMatch(/Usage: shardmind validate/);
  });

  it('reports a reference it cannot fetch as ok: false and exits 1', async () => {
    const result = await run(['validate', 'github:acme/no-such-shard', '--json']);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: expect.any(String) } });
  });
});
