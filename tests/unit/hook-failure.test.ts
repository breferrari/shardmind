/**
 * Why a hook failed, as a field (#348, IMPLEMENTATION §4.16): every failed
 * hook carries exactly one `failure` value, set by the engine where it
 * creates the failure, or by the runner over `<ctxPath>.failure`, so a
 * script never parses message text. Exit codes are unchanged.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeHook, summarizeHook, type HookResult } from '../../source/core/hook.js';
import type { PostUpdateContext } from '../../source/runtime/types.js';

let scratchDir: string;
let vaultDir: string;

const ctx = (): PostUpdateContext => ({
  slot: 'post-update',
  vaultRoot: vaultDir,
  values: { user_name: 'alice' },
  modules: {},
  shard: { name: 'test-shard', version: '1.0.0' },
  newFiles: [],
  removedFiles: [],
});

beforeEach(async () => {
  scratchDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hook-failure-'));
  vaultDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hook-failure-vault-'));
});

afterEach(async () => {
  const rmOpts = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };
  await fsp.rm(scratchDir, rmOpts);
  await fsp.rm(vaultDir, rmOpts);
});

async function hook(source: string): Promise<string> {
  const file = path.join(scratchDir, 'hook.ts');
  await fsp.writeFile(file, source, 'utf-8');
  return file;
}

const failureOf = (result: HookResult) => (result.kind === 'ran' || result.kind === 'failed' ? result.failure : undefined);

describe('a failed hook says why, as a field (#348)', () => {
  it('a hook that exits non-zero by itself is `exit`, with its exit code unchanged', async () => {
    const result = await executeHook(await hook('export default async function () { process.exit(2); }'), ctx());
    expect(result).toMatchObject({ kind: 'ran', exitCode: 2, failure: 'exit' });
  }, 30_000);

  it('a hook that throws is `threw`, still exit 1', async () => {
    const result = await executeHook(await hook("export default async function () { throw new Error('boom'); }"), ctx());
    expect(result).toMatchObject({ kind: 'ran', exitCode: 1, failure: 'threw' });
  }, 30_000);

  it('a hook module that cannot be loaded is `import`', async () => {
    const result = await executeHook(await hook('export default async function () { this is not valid typescript'), ctx());
    expect(result).toMatchObject({ kind: 'ran', exitCode: 1, failure: 'import' });
  }, 30_000);

  it('a missing hook file is `import`', async () => {
    const result = await executeHook(path.join(scratchDir, 'gone.ts'), ctx());
    expect(failureOf(result)).toBe('import');
  }, 30_000);

  it('a module with no default function is `no-default-export`', async () => {
    const result = await executeHook(await hook('export const notAFunction = 1;'), ctx());
    expect(result).toMatchObject({ kind: 'ran', exitCode: 1, failure: 'no-default-export' });
  }, 30_000);

  it('a hook past its budget is `timeout`', async () => {
    const result = await executeHook(
      await hook('export default async function () { await new Promise((r) => setTimeout(r, 10_000)); }'),
      ctx(),
      { timeoutMs: 500 },
    );
    expect(result).toMatchObject({ kind: 'failed', failure: 'timeout' });
  }, 15_000);

  it('a hook stopped by the caller’s abort is `cancelled`', async () => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 1_500);
    const result = await executeHook(
      await hook('export default async function () { await new Promise((r) => setTimeout(r, 10_000)); }'),
      ctx(),
      { timeoutMs: 30_000, signal: abort.signal },
    );
    expect(result).toMatchObject({ kind: 'failed', failure: 'cancelled' });
  }, 15_000);

  it('a hook that succeeds has no failure', async () => {
    const result = await executeHook(await hook('export default async function () {}'), ctx());
    expect(result.kind).toBe('ran');
    expect(failureOf(result)).toBeUndefined();
  }, 30_000);

  it('leaves no side file behind after a failure', async () => {
    const scoped = await fsp.mkdtemp(path.join(os.tmpdir(), 'hook-failure-scope-'));
    const saved = { TMPDIR: process.env['TMPDIR'], TEMP: process.env['TEMP'], TMP: process.env['TMP'] };
    process.env['TMPDIR'] = scoped;
    process.env['TEMP'] = scoped;
    process.env['TMP'] = scoped;
    try {
      const result = await executeHook(await hook("export default async function () { throw new Error('x'); }"), ctx());
      expect(failureOf(result)).toBe('threw');
      expect((await fsp.readdir(scoped)).filter((n) => n.startsWith('shardmind-hook-'))).toEqual([]);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await fsp.rm(scoped, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('summarizeHook carries the failure (#348)', () => {
  it('passes a failed result’s reason through', () => {
    expect(summarizeHook({ kind: 'failed', message: 'timed out after 1s', stdout: '', stderr: '', failure: 'timeout' })).toMatchObject({
      exitCode: 1,
      failure: 'timeout',
    });
  });

  it('a run with a non-zero exit and no runner report is `exit`, or `killed` for exit code -1', () => {
    expect(summarizeHook({ kind: 'ran', stdout: '', stderr: '', exitCode: 3 })).toMatchObject({ failure: 'exit' });
    expect(summarizeHook({ kind: 'ran', stdout: '', stderr: '', exitCode: -1 })).toMatchObject({ failure: 'killed' });
  });

  it('a successful run has no failure', () => {
    expect(summarizeHook({ kind: 'ran', stdout: '', stderr: '', exitCode: 0 })).not.toHaveProperty('failure');
  });
});
