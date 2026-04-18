import fsp from 'node:fs/promises';
import path from 'node:path';
import nunjucks from 'nunjucks';
import type { ShardSchema, ValueDefinition } from '../runtime/types.js';
import { ShardMindError } from '../runtime/types.js';
import { isComputedDefault } from './schema.js';

export interface Collision {
  outputPath: string;
  absolutePath: string;
  size: number;
  mtime: Date;
  kind: 'file' | 'directory';
}

export interface BackupRecord {
  originalPath: string;
  backupPath: string;
}

/**
 * Resolve values whose default is a computed expression (`{{ ... }}`).
 * Runs after non-computed values have been collected from the wizard or
 * a --values file.
 *
 * The expression is rendered through a standalone Nunjucks environment
 * (autoescape off) with the already-collected values as context.
 * The resulting string is coerced back into the value's declared type.
 */
export function resolveComputedDefaults(
  schema: ShardSchema,
  collected: Record<string, unknown>,
): Record<string, unknown> {
  const env = new nunjucks.Environment(null, { autoescape: false });
  const result: Record<string, unknown> = { ...collected };

  for (const [key, def] of Object.entries(schema.values)) {
    if (result[key] !== undefined) continue; // user already answered
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
  }
}

/**
 * Detect which planned output paths already exist on disk.
 * Returns one Collision per existing file with size + mtime so the user
 * can make an informed choice between backup / overwrite / cancel.
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
      // Flag both files and directories — a directory at a planned file
      // path would cause EISDIR during write. The UI shows both with
      // clear labels so the user sees the real blocker.
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
      const code = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
      if (code !== 'ENOENT') {
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

/**
 * Rename each colliding file to `<original>.shardmind-backup-<timestamp>`.
 * Timestamp is ISO-8601 compact (no colons) so the name is filesystem-safe.
 * If multiple collisions share the same timestamp suffix (same second,
 * or an earlier backup still on disk), we increment a counter to keep
 * backup names unique. Returns a record per backup so callers can
 * surface them in the summary and the rollback path can restore them.
 */
export async function backupCollisions(
  collisions: Collision[],
  timestamp: Date = new Date(),
): Promise<BackupRecord[]> {
  const stamp = timestamp.toISOString().replace(/:/g, '-').replace(/\..+$/, '');
  const records: BackupRecord[] = [];

  for (const collision of collisions) {
    const backupPath = await uniqueBackupPath(collision.absolutePath, stamp);
    try {
      await fsp.rename(collision.absolutePath, backupPath);
    } catch (err) {
      throw new ShardMindError(
        `Could not back up existing file: ${collision.absolutePath}`,
        'BACKUP_FAILED',
        err instanceof Error ? err.message : String(err),
      );
    }
    records.push({ originalPath: collision.absolutePath, backupPath });
  }

  return records;
}

async function uniqueBackupPath(absolutePath: string, stamp: string): Promise<string> {
  const base = `${absolutePath}.shardmind-backup-${stamp}`;
  if (!(await pathExists(base))) return base;
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base}.${i}`;
    if (!(await pathExists(candidate))) return candidate;
  }
  throw new ShardMindError(
    `Could not find a unique backup name for ${absolutePath}`,
    'BACKUP_FAILED',
    'Too many existing backups with the same timestamp — clean up old .shardmind-backup-* files and retry.',
  );
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Restore backups to their original paths. Used during rollback after
 * a failed install so the user's pre-install content comes back intact.
 * Best-effort per entry — individual failures are logged via the return
 * value but don't abort the rest of the restore.
 */
export async function restoreBackups(
  records: BackupRecord[],
): Promise<{ restored: BackupRecord[]; failed: Array<BackupRecord & { reason: string }> }> {
  const restored: BackupRecord[] = [];
  const failed: Array<BackupRecord & { reason: string }> = [];

  for (const record of records) {
    try {
      // Remove whatever the partial install wrote at the original path,
      // then move the backup back.
      await fsp.rm(record.originalPath, { recursive: true, force: true });
      await fsp.rename(record.backupPath, record.originalPath);
      restored.push(record);
    } catch (err) {
      failed.push({
        ...record,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { restored, failed };
}

/**
 * Merge default values from the schema with prefill values provided via
 * `--values file.yaml`. Prefill wins over schema defaults. Computed
 * defaults are left unresolved (caller runs `resolveComputedDefaults`
 * after all prompts complete).
 */
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

/**
 * Which schema value IDs still need prompting — not present in the
 * (prefill + static defaults) snapshot, not computed. Preserves schema
 * declaration order so the wizard walks values in the author's order.
 */
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

/**
 * Initial module selections: every module present in schema, with
 * `removable: false` locked to 'included' and `removable: true`
 * defaulting to 'included' (user unchecks to exclude).
 */
export function defaultModuleSelections(
  schema: ShardSchema,
): Record<string, 'included' | 'excluded'> {
  const selections: Record<string, 'included' | 'excluded'> = {};
  for (const id of Object.keys(schema.modules)) {
    selections[id] = 'included';
  }
  return selections;
}
