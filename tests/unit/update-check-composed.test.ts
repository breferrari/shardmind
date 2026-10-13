/**
 * The update-check cache in a vault holding several shards (#406): each
 * shard keeps its own entry, in its own engine folder, so two shards never
 * evict each other's answer. Spec: IMPLEMENTATION §4.15.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { getLatestVersion, primeLatestVersion } from '../../source/core/update-check.js';

let vault: string;
const OVERLAY = path.join('.shardmind', 'shards', 'acme', 'research');

beforeEach(async () => {
  vault = path.join(os.tmpdir(), `shardmind-update-check-composed-${crypto.randomUUID()}`);
  await fsp.mkdir(path.join(vault, OVERLAY), { recursive: true });
  // A miss must not reach the real GitHub: a closed port answers no-network.
  vi.stubEnv('SHARDMIND_GITHUB_API_BASE', 'http://127.0.0.1:9');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fsp.rm(vault, { recursive: true, force: true });
});

describe('update-check cache per shard (#406)', () => {
  it("keeps the base's and an overlay's answers apart", async () => {
    const now = Date.parse('2026-10-13T12:00:00Z');
    await primeLatestVersion(vault, 'github:acme/base', '1.0.0', now);
    await primeLatestVersion(vault, 'github:acme/research', '2.0.0', now, OVERLAY);
    const base = await getLatestVersion(vault, 'github:acme/base', now);
    const overlay = await getLatestVersion(vault, 'github:acme/research', now, OVERLAY);
    expect(base).toMatchObject({ kind: 'fresh', latest_version: '1.0.0' });
    expect(overlay).toMatchObject({ kind: 'fresh', latest_version: '2.0.0' });
    // The overlay's entry sits in its own folder; the base's file is the base's alone.
    const baseFile = JSON.parse(await fsp.readFile(path.join(vault, '.shardmind', 'update-check.json'), 'utf-8')) as { source: string };
    expect(baseFile.source).toBe('github:acme/base');
  });
});
