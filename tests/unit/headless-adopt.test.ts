/**
 * `shardmind adopt --json` runs headless (#302): its failure documents,
 * which need no shard. The plan document is covered end to end by the
 * json e2e suites.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// A download a Ctrl+C cancelled (#57): the fetch rejects as `download.ts`'s does.
vi.mock('../../source/core/registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../source/core/registry.js')>()),
  resolve: vi.fn(async () => ({ namespace: 'a', name: 'b', version: '1.0.0', source: 'github:a/b', tarballUrl: 'https://example.invalid/t.tgz' })),
}));
vi.mock('../../source/core/download.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../source/core/download.js')>();
  return { ...actual, downloadShard: vi.fn(async () => Promise.reject(new actual.DownloadCancelledError())) };
});

const { runAdoptJson } = await import('../../source/commands/headless/adopt.js');

async function run(argv: string[]) {
  let out = '';
  const code = await runAdoptJson(argv, '0.0.0-test', (chunk) => {
    out += chunk;
  });
  return { code, doc: JSON.parse(out) as Record<string, unknown> };
}

let dir: string;
let cwd: string;
beforeEach(async () => {
  dir = path.join(os.tmpdir(), `shardmind-headless-adopt-${crypto.randomUUID()}`);
  await fsp.mkdir(dir, { recursive: true });
  cwd = process.cwd();
  process.chdir(dir);
});
afterEach(async () => {
  process.chdir(cwd);
  await fsp.rm(dir, { recursive: true, force: true });
});

/** A lock file held by a live run on this host: the parent test runner's own PID. */
async function holdLock(root: string): Promise<void> {
  await fsp.writeFile(
    path.join(root, '.shardmind.lock'),
    JSON.stringify({ command: 'update', pid: process.ppid, startedAt: new Date(0).toISOString(), hostname: os.hostname() }),
  );
}

describe('runAdoptJson (#302)', () => {
  it('a flag adopt does not take is ARGS_INVALID, exit 1', async () => {
    const { code, doc } = await run(['github:a/b', '--json', '--dry-run', '--nope']);
    expect(code).toBe(1);
    // Commander's own message, suggestion included, as the run without --json prints.
    expect(doc).toMatchObject({ ok: false, command: 'adopt', error: { code: 'ARGS_INVALID', message: expect.stringMatching(/^error: unknown option '--nope'/) } });
  });

  it('a value outside --mode’s choices is ARGS_INVALID, as without --json', async () => {
    const { doc } = await run(['github:a/b', '--json', '--dry-run', '--mode', 'sideways']);
    expect(doc).toMatchObject({ ok: false, error: { code: 'ARGS_INVALID' } });
  });

  it('--json without --dry-run is a real run: it takes the vault lock first, so a held lock is VAULT_LOCKED (#348)', async () => {
    await holdLock(dir);
    const { code, doc } = await run(['github:a/b', '--json', '--yes']);
    expect(code).toBe(1);
    expect(doc).toMatchObject({ ok: false, command: 'adopt', error: { code: 'VAULT_LOCKED' } });
  });

  it('a download cancelled by Ctrl+C answers CANCELLED and returns 130 (#57, #348)', async () => {
    const { code, doc } = await run(['github:a/b', '--json', '--dry-run', '--yes']);
    expect(code).toBe(130);
    expect(doc).toMatchObject({ ok: false, command: 'adopt', error: { code: 'CANCELLED' } });
  });
});
