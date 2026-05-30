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
    // `bootstrap` accepts the bare-string form (`bootstrap: path`) or the
    // object form (`bootstrap: { script, fingerprint? }`). The string arm is
    // normalized into the object shape so every downstream consumer sees one
    // shape (`{ script, fingerprint? }`). See SHARD-LAYOUT.md §Hook lifecycle.
    bootstrap: z
      .union([
        z.string().transform((script) => ({ script })),
        z.object({ script: z.string(), fingerprint: z.string().optional() }),
      ])
      .optional(),
    personalize: z.string().optional(),
    'post-update': z.string().optional(),
    // Deprecated combined hook. Mutually exclusive with bootstrap/personalize;
    // the conflict is rejected post-parse as HOOK_SLOT_CONFLICT (a superRefine
    // would surface only as the generic MANIFEST_VALIDATION_FAILED).
    'post-install': z.string().optional(),
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

  // The deprecated `post-install` slot cannot coexist with the new
  // `bootstrap` / `personalize` slots — a half-migrated manifest is a
  // mistake, not a merge. Reject post-parse so the hint is precise (a zod
  // superRefine would collapse into the generic MANIFEST_VALIDATION_FAILED).
  const hooks = result.data.hooks;
  if (hooks['post-install'] && (hooks.bootstrap || hooks.personalize)) {
    throw new ShardMindError(
      'shard.yaml declares the deprecated hooks.post-install alongside hooks.bootstrap/personalize.',
      'HOOK_SLOT_CONFLICT',
      'Remove hooks.post-install once you have split it into bootstrap + personalize. See docs/AUTHORING.md §6.',
    );
  }

  return result.data as ShardManifest;
}
