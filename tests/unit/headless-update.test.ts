/**
 * `shardmind update --json` runs headless (#302): its failure documents and
 * a cancelled download, which need no shard. The plan document is covered end
 * to end by the json e2e suites and Layer 1's 17g.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_FILE } from '../../source/runtime/vault-paths.js';
import { makeShardState } from '../helpers/shard-state.js';

// A download a Ctrl+C cancelled (#57): the fetch rejects as `download.ts`'s does.
vi.mock('../../source/core/registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../source/core/registry.js')>()),
  resolve: vi.fn(async () => ({ namespace: 'a', name: 'b', version: '2.0.0', source: 'github:a/b', tarballUrl: 'https://example.invalid/t.tgz' })),
}));
vi.mock('../../source/core/download.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../source/core/download.js')>();
  return { ...actual, downloadShard: vi.fn(async () => Promise.reject(new actual.DownloadCancelledError())) };
});

const { runUpdateJson } = await import('../../source/commands/headless/update.js');

async function run(argv: string[]) {
  let out = '';
  const code = await runUpdateJson(argv, '0.0.0-test', (chunk) => {
    out += chunk;
  });
  return { code, out, doc: out === '' ? undefined : (JSON.parse(out) as Record<string, unknown>) };
}

async function writeInstall(): Promise<void> {
  await fsp.mkdir(path.dirname(path.join(dir, STATE_FILE)), { recursive: true });
  await fsp.writeFile(path.join(dir, STATE_FILE), JSON.stringify(makeShardState({ source: 'github:a/b', version: '1.0.0' })));
}

let dir: string;
let cwd: string;
beforeEach(async () => {
  dir = path.join(os.tmpdir(), `shardmind-headless-update-${crypto.randomUUID()}`);
  await fsp.mkdir(dir, { recursive: true });
  cwd = process.cwd();
  process.chdir(dir);
});
afterEach(async () => {
  process.chdir(cwd);
  // The flow primes the update-check cache in the vault without waiting on
  // it, so that write can still be under way here (Windows: ENOTEMPTY).
  await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('runUpdateJson (#302)', () => {
  it('a flag update does not take is ARGS_INVALID, exit 1', async () => {
    const { code, doc } = await run(['--json', '--dry-run', '--nope']);
    expect(code).toBe(1);
    // Commander's own message, as the run without --json prints.
    expect(doc).toMatchObject({ ok: false, command: 'update', error: { code: 'ARGS_INVALID', message: expect.stringMatching(/^error: unknown option '--nope'/) } });
  });

  it('--json without --dry-run is JSON_REQUIRES_DRY_RUN, before reading the vault', async () => {
    const { code, doc } = await run(['--json']);
    expect(code).toBe(1);
    expect(doc).toMatchObject({ ok: false, command: 'update', error: { code: 'JSON_REQUIRES_DRY_RUN' } });
  });

  it('a directory with no install is UPDATE_NO_INSTALL', async () => {
    const { code, doc } = await run(['--json', '--dry-run']);
    expect(code).toBe(1);
    expect(doc).toMatchObject({ ok: false, command: 'update', error: { code: 'UPDATE_NO_INSTALL' } });
  });

  it('--release with --include-prerelease is UPDATE_FLAG_CONFLICT', async () => {
    await writeInstall();
    const { doc } = await run(['--json', '--dry-run', '--release', '2.0.0', '--include-prerelease']);
    expect(doc).toMatchObject({ ok: false, command: 'update', error: { code: 'UPDATE_FLAG_CONFLICT' } });
  });

  it('a download cancelled by Ctrl+C writes no document and returns 130 (#57)', async () => {
    await writeInstall();
    const { code, out } = await run(['--json', '--dry-run']);
    expect(code).toBe(130);
    expect(out).toBe('');
  });
});
