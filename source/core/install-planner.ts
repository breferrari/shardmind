/**
 * Install planner — pure + read-only operations.
 *
 * Everything here answers "what would the install do?" without touching
 * disk beyond reading the downloaded shard's temp directory. Disk
 * mutations (backup, write, rollback) live in `install-executor.ts`.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import nunjucks from 'nunjucks';
import type {
  ShardSchema,
  ValueDefinition,
  ModuleSelections,
} from '../runtime/types.js';
import { ShardMindError, assertNever } from '../runtime/types.js';
import { isEnoent } from '../runtime/errno.js';
import { isComputedDefault } from './schema.js';
import { resolveModules } from './modules.js';
import { sha256 } from './fs-utils.js';

export interface Collision {
  outputPath: string;
  absolutePath: string;
  size: number;
  mtime: Date;
  kind: 'file' | 'directory';
}

export interface PlannedOutput {
  outputPath: string;
  source: 'render' | 'copy';
}

export function resolveComputedDefaults(
  schema: ShardSchema,
  collected: Record<string, unknown>,
): Record<string, unknown> {
  const env = new nunjucks.Environment(null, { autoescape: false });
  const result: Record<string, unknown> = { ...collected };

  for (const [key, def] of Object.entries(schema.values)) {
    if (result[key] !== undefined) continue;
    if (def.default === undefined) continue;
    if (!isComputedDefault(def.default)) continue;

    const expression = def.default as string;
    let rendered: string;
    try {
      rendered = env.renderString(expression, result).trim();
    } catch (err) {
      throw new ShardMindError(
        `Failed to evaluate computed default for '${key}'`,
        'COMPUTED_DEFAULT_FAILED',
        err instanceof Error ? err.message : String(err),
      );
    }

    result[key] = coerceToType(rendered, def, key);
  }

  return result;
}

function coerceToType(raw: string, def: ValueDefinition, key: string): unknown {
  switch (def.type) {
    case 'string':
      return raw;
    case 'boolean':
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      throw new ShardMindError(
        `Computed default for '${key}' returned '${raw}', expected boolean`,
        'COMPUTED_DEFAULT_INVALID',
        'Nunjucks expressions for boolean values must evaluate to "true" or "false".',
      );
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        throw new ShardMindError(
          `Computed default for '${key}' returned '${raw}', expected number`,
          'COMPUTED_DEFAULT_INVALID',
          'Nunjucks expressions for number values must evaluate to a finite number.',
        );
      }
      return n;
    }
    case 'select':
      return raw;
    case 'multiselect':
    case 'list':
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error('not an array');
        return parsed;
      } catch {
        throw new ShardMindError(
          `Computed default for '${key}' returned '${raw}', expected JSON array`,
          'COMPUTED_DEFAULT_INVALID',
          'Nunjucks expressions for list/multiselect values must evaluate to a JSON array.',
        );
      }
    default:
      return assertNever(def.type);
  }
}

/**
 * Detect which planned output paths already exist on disk.
 * Flags files AND directories — a directory at a planned file path
 * would cause EISDIR during write; the UI labels each entry so the
 * user sees what's actually in the way.
 */
export async function detectCollisions(
  vaultRoot: string,
  plannedOutputs: string[],
): Promise<Collision[]> {
  const collisions: Collision[] = [];

  for (const outputPath of plannedOutputs) {
    const absolutePath = path.join(vaultRoot, outputPath);
    try {
      const stat = await fsp.stat(absolutePath);
      if (stat.isFile() || stat.isDirectory()) {
        collisions.push({
          outputPath,
          absolutePath,
          size: stat.size,
          mtime: stat.mtime,
          kind: stat.isDirectory() ? 'directory' : 'file',
        });
      }
    } catch (err) {
      if (!isEnoent(err)) {
        throw new ShardMindError(
          `Could not check existing file: ${absolutePath}`,
          'COLLISION_CHECK_FAILED',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  return collisions;
}

export function mergePrefill(
  schema: ShardSchema,
  prefill: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};

  for (const [key, def] of Object.entries(schema.values)) {
    if (prefill[key] !== undefined) {
      merged[key] = prefill[key];
      continue;
    }
    if (def.default !== undefined && !isComputedDefault(def.default)) {
      merged[key] = def.default;
    }
  }

  return merged;
}

export function missingValueKeys(
  schema: ShardSchema,
  snapshot: Record<string, unknown>,
): string[] {
  const missing: string[] = [];
  for (const [key, def] of Object.entries(schema.values)) {
    if (snapshot[key] !== undefined) continue;
    if (def.default !== undefined && isComputedDefault(def.default)) continue;
    missing.push(key);
  }
  return missing;
}

export function defaultModuleSelections(schema: ShardSchema): ModuleSelections {
  const selections: ModuleSelections = {};
  for (const id of Object.keys(schema.modules)) {
    selections[id] = 'included';
  }
  return selections;
}

/**
 * Enumerate every file that would be written given the selected modules.
 * Reads the temp directory; does not touch the vault.
 */
export async function planOutputs(
  schema: ShardSchema,
  tempDir: string,
  selections: ModuleSelections,
): Promise<{
  outputs: PlannedOutput[];
  moduleFileCounts: Record<string, number>;
  alwaysIncludedFileCount: number;
}> {
  const resolution = await resolveModules(schema, selections, tempDir);
  const outputs: PlannedOutput[] = [];
  const moduleFileCounts: Record<string, number> = {};
  let alwaysIncludedFileCount = 0;

  for (const id of Object.keys(schema.modules)) {
    moduleFileCounts[id] = 0;
  }

  const tally = (entry: { outputPath: string; module: string | null }, source: 'render' | 'copy') => {
    outputs.push({ outputPath: entry.outputPath, source });
    if (entry.module && entry.module in moduleFileCounts) {
      moduleFileCounts[entry.module]!++;
    } else if (!entry.module) {
      alwaysIncludedFileCount++;
    }
  };
  for (const entry of resolution.render) tally(entry, 'render');
  for (const entry of resolution.copy) tally(entry, 'copy');

  return { outputs, moduleFileCounts, alwaysIncludedFileCount };
}

export function hashValues(values: Record<string, unknown>): string {
  return sha256(JSON.stringify(stableJson(values)));
}

/**
 * Recursively reorder object keys alphabetically so JSON.stringify produces
 * a deterministic byte sequence. Arrays keep their order; primitives pass
 * through. Unlike the `replacer` array overload of JSON.stringify, this
 * does NOT drop nested object keys.
 */
function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = stableJson((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
