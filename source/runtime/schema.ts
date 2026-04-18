/**
 * Read-only schema access for hook scripts. Loads the cached
 * `shard-schema.yaml` that `core/state.cacheManifest` wrote at install
 * time. Hook authors use this to validate values, drive conditional
 * logic, or introspect modules.
 *
 * The parsing + validation path lives in `source/core/schema.ts`.
 * Runtime trusts the cached file because the engine validated it on
 * install; no zod here keeps the runtime bundle small.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ShardSchema, FrontmatterRule } from './types.js';
import { ShardMindError } from './types.js';
import { resolveVaultRoot } from './state.js';
import { CACHED_SCHEMA } from './vault-paths.js';

/**
 * Load the cached `shard-schema.yaml` from the current vault.
 *
 * Reads the copy that `shardmind install` wrote to `.shardmind/`.
 * Normalizes frontmatter shorthand (`key: [a, b]` → `key: { required: [a, b] }`).
 * Runtime trusts the cached file because the engine validated it on
 * install; this function is lean intentionally.
 *
 * @returns The parsed and normalized `ShardSchema`.
 * @throws ShardMindError `VAULT_NOT_FOUND` if no vault in the ancestor chain.
 * @throws ShardMindError `SCHEMA_NOT_FOUND` if the cached file is missing.
 *
 * @example
 * ```ts
 * import { loadSchema, loadValues, validateValues } from 'shardmind/runtime';
 *
 * const [schema, values] = await Promise.all([loadSchema(), loadValues()]);
 * const result = validateValues(values, schema);
 * ```
 */
export async function loadSchema(): Promise<ShardSchema> {
  const vaultRoot = resolveVaultRoot();
  const filePath = path.join(vaultRoot, CACHED_SCHEMA);

  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf-8');
  } catch {
    throw new ShardMindError(
      `Cannot read shard-schema.yaml: ${filePath}`,
      'SCHEMA_NOT_FOUND',
      'Ensure this vault has been initialized with shardmind install.',
    );
  }

  const data = parseYaml(raw) as ShardSchema;

  // Normalize frontmatter shorthand: array → { required: [...] }
  if (data.frontmatter) {
    const normalized: Record<string, FrontmatterRule> = {};
    for (const [key, entry] of Object.entries(data.frontmatter)) {
      if (Array.isArray(entry)) {
        normalized[key] = { required: entry as string[] };
      } else {
        normalized[key] = entry as FrontmatterRule;
      }
    }
    data.frontmatter = normalized;
  }

  return data;
}
