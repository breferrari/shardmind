/**
 * Hook lookup tests.
 *
 * The lookup surface is security-sensitive regardless of when hooks
 * execute: a shard manifest with `hooks.post-update: "../.."` must not
 * be able to probe arbitrary filesystem paths via existence detection.
 * These tests lock the sandbox invariant — the resolved hook path is
 * always inside the shard's temp directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runPostInstallHook, runPostUpdateHook } from '../../source/core/hook.js';
import type { ShardManifest } from '../../source/runtime/types.js';

function makeManifest(hooks: ShardManifest['hooks']): ShardManifest {
  return {
    apiVersion: 'v1',
    name: 'test',
    namespace: 'ns',
    version: '1.0.0',
    dependencies: [],
    hooks,
  };
}

describe('lookupHook — path traversal guards', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hook-test-'));
    // Stage a legit hook + a sibling file outside the shard.
    await fsp.mkdir(path.join(tempDir, 'hooks'), { recursive: true });
    await fsp.writeFile(path.join(tempDir, 'hooks', 'post-install.ts'), '// hook\n');
    await fsp.writeFile(path.join(tempDir, 'hooks', 'post-update.ts'), '// hook\n');
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('resolves a legitimate relative hook path to "deferred"', async () => {
    const manifest = makeManifest({ 'post-install': 'hooks/post-install.ts' });
    const result = await runPostInstallHook(tempDir, manifest);
    expect(result.kind).toBe('deferred');
    if (result.kind !== 'deferred') throw new Error('narrowing');
    expect(result.hookPath).toContain('hooks');
  });

  it('refuses a parent-directory traversal (../../etc/shadow)', async () => {
    const manifest = makeManifest({ 'post-update': '../../../../etc/shadow' });
    const result = await runPostUpdateHook(tempDir, manifest);
    expect(result.kind).toBe('absent');
  });

  it('refuses an absolute path (Unix)', async () => {
    const manifest = makeManifest({ 'post-update': '/etc/shadow' });
    const result = await runPostUpdateHook(tempDir, manifest);
    expect(result.kind).toBe('absent');
  });

  it('refuses a path containing ".." segments in the middle', async () => {
    // `hooks/../../etc/shadow` would escape via the middle `..`. The
    // normalize-based guard catches this class.
    const manifest = makeManifest({ 'post-update': 'hooks/../../etc/shadow' });
    const result = await runPostUpdateHook(tempDir, manifest);
    expect(result.kind).toBe('absent');
  });

  it('returns absent when the hook file does not exist under the shard', async () => {
    const manifest = makeManifest({ 'post-install': 'hooks/does-not-exist.ts' });
    const result = await runPostInstallHook(tempDir, manifest);
    expect(result.kind).toBe('absent');
  });

  it('returns absent when no hook is declared', async () => {
    const manifest = makeManifest({});
    const result = await runPostInstallHook(tempDir, manifest);
    expect(result.kind).toBe('absent');
  });
});
