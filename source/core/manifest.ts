import fs from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import semver from 'semver';
import { z } from 'zod';
import type { ShardManifest } from '../runtime/types.js';
import { ShardMindError } from '../runtime/types.js';
import { errnoCode } from '../runtime/errno.js';

export const ShardManifestSchema = z.object({
  apiVersion: z.literal('v1'),
  name: z.string().regex(/^[a-z0-9-]+$/, 'Must be lowercase alphanumeric with hyphens'),
  namespace: z.string().regex(/^[a-z0-9-]+$/, 'Must be lowercase alphanumeric with hyphens'),
  version: z.string().refine(v => semver.valid(v) !== null, 'Must be valid semver'),
  description: z.string().optional(),
  persona: z.string().optional(),
  license: z.string().optional(),
  homepage: z.string().url().optional(),
  requires: z.object({
    obsidian: z.string().optional(),
    node: z.string().optional(),
  }).optional(),
  dependencies: z.array(z.object({
    name: z.string(),
    namespace: z.string(),
    version: z.string(),
  })).default([]),
  hooks: z.object({
    'post-install': z.string().optional(),
    'post-update': z.string().optional(),
    // Per-shard hook execution timeout in milliseconds. Default 30_000 when
    // absent. Clamped to 1_000..600_000 — below one second is almost always a
    // bug (even a trivial `git init` hits ~50ms with warm caches but 200ms
    // cold); above ten minutes exceeds any legitimate first-run setup we want
    // to block the install TUI on.
    timeout_ms: z.number().int().min(1_000).max(600_000).optional(),
  }).default({}),
});

/**
 * Default hook execution timeout when a manifest doesn't override
 * `hooks.timeout_ms`. See docs/ARCHITECTURE.md §9.3.
 */
export const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

export async function parseManifest(filePath: string): Promise<ShardManifest> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    const fsCode = errnoCode(err);
    if (fsCode === 'ENOENT') {
      throw new ShardMindError(
        `Cannot read shard.yaml: ${filePath}`,
        'MANIFEST_NOT_FOUND',
        'Check the file path and ensure shard.yaml exists.',
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new ShardMindError(
      `Cannot read shard.yaml: ${filePath} (${fsCode ?? 'unknown'})`,
      'MANIFEST_READ_FAILED',
      message,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ShardMindError(
      `shard.yaml is not valid YAML: ${message}`,
      'MANIFEST_INVALID_YAML',
      'Check shard.yaml for syntax errors.',
    );
  }

  const result = ShardManifestSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map(i => `${i.path.length === 0 ? '(root)' : i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new ShardMindError(
      `shard.yaml validation failed: ${details}`,
      'MANIFEST_VALIDATION_FAILED',
      'Check shard.yaml against the shard manifest spec.',
    );
  }

  return result.data as ShardManifest;
}
