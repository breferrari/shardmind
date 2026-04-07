import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { ShardSchema, ValidationResult } from './types.js';
import { ShardMindError } from './types.js';
import { resolveVaultRoot } from './state.js';

export async function loadValues(): Promise<Record<string, unknown>> {
  const vaultRoot = resolveVaultRoot();
  const filePath = path.join(vaultRoot, 'shard-values.yaml');

  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    const fsCode = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
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
