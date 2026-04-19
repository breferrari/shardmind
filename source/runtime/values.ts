import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { ShardSchema, ValidationResult } from './types.js';
import { ShardMindError } from './types.js';
import { resolveVaultRoot } from './state.js';
import { VALUES_FILE } from './vault-paths.js';
import { errnoCode } from './errno.js';

/**
 * Load `shard-values.yaml` from the current vault.
 *
 * Resolves the vault root by walking up from `process.cwd()` looking for
 * a `.shardmind/` directory (see {@link resolveVaultRoot}). Reads the
 * values file, parses as YAML, and returns the flat map.
 *
 * @returns The user's answered values as a plain object.
 * @throws ShardMindError `VAULT_NOT_FOUND` if no vault is found in the ancestor chain.
 * @throws ShardMindError `VALUES_NOT_FOUND` if the vault has no values file (vault not installed).
 * @throws ShardMindError `VALUES_READ_FAILED` on I/O errors.
 * @throws ShardMindError `VALUES_INVALID` if the file isn't a YAML mapping.
 *
 * @example
 * ```ts
 * import { loadValues } from 'shardmind/runtime';
 *
 * const values = await loadValues();
 * console.log(`Hello, ${values.user_name}`);
 * ```
 */
export async function loadValues(): Promise<Record<string, unknown>> {
  const vaultRoot = resolveVaultRoot();
  const filePath = path.join(vaultRoot, VALUES_FILE);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    const fsCode = errnoCode(err);
    if (fsCode === 'ENOENT') {
      throw new ShardMindError(
        `Cannot read shard-values.yaml: ${filePath}`,
        'VALUES_NOT_FOUND',
        'Ensure this vault has been initialized with shardmind install.',
      );
    }
    throw new ShardMindError(
      `Cannot read shard-values.yaml: ${filePath} (${fsCode ?? 'unknown'})`,
      'VALUES_READ_FAILED',
      err instanceof Error ? err.message : String(err),
    );
  }

  const parsed = parseYaml(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ShardMindError(
      `shard-values.yaml must be a YAML mapping, got ${parsed === null ? 'null' : typeof parsed}`,
      'VALUES_INVALID',
      'Ensure shard-values.yaml contains key-value pairs.',
    );
  }

  return parsed as Record<string, unknown>;
}

function isComputedDefault(value: unknown): boolean {
  return typeof value === 'string' && value.trimStart().startsWith('{{');
}

// Duplicated from core/schema.ts — runtime can't import from core
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildValuesValidator(schema: ShardSchema): z.ZodObject<any> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, val] of Object.entries(schema.values)) {
    let field: z.ZodTypeAny;

    switch (val.type) {
      case 'string':
        field = z.string();
        break;
      case 'boolean':
        field = z.boolean();
        break;
      case 'number': {
        let num = z.number();
        if (val.min !== undefined) num = num.min(val.min);
        if (val.max !== undefined) num = num.max(val.max);
        field = num;
        break;
      }
      case 'select': {
        const values = val.options!.map(o => o.value) as [string, ...string[]];
        field = z.enum(values);
        break;
      }
      case 'multiselect': {
        const values = val.options!.map(o => o.value) as [string, ...string[]];
        field = z.array(z.enum(values));
        break;
      }
      case 'list':
        field = z.array(z.any());
        break;
    }

    if (!val.required) {
      field = field.optional();
    }

    if (val.default !== undefined && !isComputedDefault(val.default)) {
      field = field.default(val.default);
    }

    shape[key] = field;
  }

  return z.object(shape);
}

/**
 * Validate an object of user values against a shard schema.
 *
 * Builds a dynamic zod validator from the schema's declared value types
 * (string, number, boolean, select, multiselect, list) and checks the
 * supplied values. Returns a result object rather than throwing so hook
 * authors can branch on validity without a try/catch.
 *
 * @param values The values to validate (typically from {@link loadValues}).
 * @param schema The shard schema (typically from {@link loadSchema}).
 * @returns `{ valid: boolean, errors: Array<{ path, message }> }`.
 *
 * @example
 * ```ts
 * import { loadValues, loadSchema, validateValues } from 'shardmind/runtime';
 *
 * const [values, schema] = await Promise.all([loadValues(), loadSchema()]);
 * const result = validateValues(values, schema);
 * if (!result.valid) {
 *   for (const err of result.errors) console.error(`${err.path}: ${err.message}`);
 * }
 * ```
 */
export function validateValues(
  values: Record<string, unknown>,
  schema: ShardSchema,
): ValidationResult {
  const validator = buildValuesValidator(schema);
  const result = validator.safeParse(values);

  if (result.success) {
    return { valid: true, errors: [] };
  }

  return {
    valid: false,
    errors: result.error.issues.map(i => ({
      path: i.path.join('.'),
      message: i.message,
    })),
  };
}
