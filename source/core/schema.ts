/**
 * Engine-side schema parsing + validation. Reads `shard-schema.yaml`
 * from a downloaded shard's temp directory, validates via zod, enforces
 * cross-references (group/module IDs, reserved names), and normalizes
 * frontmatter shorthand. Also builds the dynamic zod validator for
 * user-supplied values.
 *
 * `source/runtime/schema.ts` is the thin read-only counterpart used by
 * hook scripts. That one loads the already-cached copy and skips most
 * validation — the engine validated it on install.
 */

import fs from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { ShardSchema, FrontmatterRule } from '../runtime/types.js';
import { ShardMindError } from '../runtime/types.js';

const OptionSchema = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
});

const ValueDefinitionSchema = z.object({
  type: z.enum(['string', 'boolean', 'number', 'select', 'multiselect', 'list']),
  required: z.boolean().optional(),
  message: z.string(),
  default: z.unknown().optional(),
  options: z.array(OptionSchema).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  group: z.string(),
  hint: z.string().optional(),
  placeholder: z.string().optional(),
}).check((ctx) => {
  const val = ctx.value;
  if ((val.type === 'select' || val.type === 'multiselect') && (!val.options || val.options.length === 0)) {
    ctx.issues.push({
      code: 'custom',
      path: ['options'],
      message: `"options" is required and must be non-empty for type "${val.type}"`,
      input: val,
    });
  }
  if (val.min !== undefined && val.max !== undefined && val.min > val.max) {
    ctx.issues.push({
      code: 'custom',
      path: ['min'],
      message: '`min` must be less than or equal to `max`',
      input: val,
    });
  }
});

const GroupDefinitionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
});

const ModuleDefinitionSchema = z.object({
  label: z.string(),
  paths: z.array(z.string()),
  partials: z.array(z.string()).optional(),
  commands: z.array(z.string()).optional(),
  agents: z.array(z.string()).optional(),
  bases: z.array(z.string()).optional(),
  removable: z.boolean(),
});

const SignalDefinitionSchema = z.object({
  id: z.string(),
  description: z.string(),
  routes_to: z.string(),
  core: z.boolean().optional(),
  module: z.string().optional(),
});

const FrontmatterRuleSchema = z.object({
  required: z.array(z.string()).optional(),
  path_match: z.string().optional(),
});

const MigrationChangeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('rename'), old: z.string(), new: z.string() }),
  z.object({ type: z.literal('added'), key: z.string(), default: z.unknown() }),
  z.object({ type: z.literal('removed'), key: z.string() }),
  z.object({ type: z.literal('type_changed'), key: z.string(), from: z.string(), to: z.string(), transform: z.string() }),
]);

const MigrationSchema = z.object({
  from_version: z.string(),
  changes: z.array(MigrationChangeSchema),
});

// Frontmatter accepts either a FrontmatterRule object or a shorthand string array
const FrontmatterEntrySchema = z.union([
  FrontmatterRuleSchema,
  z.array(z.string()),
]);

const ShardSchemaFileSchema = z.object({
  schema_version: z.number(),
  values: z.record(z.string(), ValueDefinitionSchema),
  groups: z.array(GroupDefinitionSchema),
  modules: z.record(z.string(), ModuleDefinitionSchema).default({}),
  signals: z.array(SignalDefinitionSchema).default([]),
  frontmatter: z.record(z.string(), FrontmatterEntrySchema).default({}),
  migrations: z.array(MigrationSchema).default([]),
});

export function isComputedDefault(value: unknown): boolean {
  return typeof value === 'string' && value.trimStart().startsWith('{{');
}

/**
 * Keys provided by the render context. Shard authors cannot declare
 * schema values with these names because they would silently shadow
 * the engine-provided context at render time.
 */
export const RESERVED_VALUE_KEYS = new Set([
  'shard',
  'install_date',
  'year',
  'included_modules',
  'values',
]);

export async function parseSchema(filePath: string): Promise<ShardSchema> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    const fsCode = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (fsCode === 'ENOENT') {
      throw new ShardMindError(
        `Cannot read shard-schema.yaml: ${filePath}`,
        'SCHEMA_NOT_FOUND',
        'Check the file path and ensure shard-schema.yaml exists.',
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new ShardMindError(
      `Cannot read shard-schema.yaml: ${filePath} (${fsCode ?? 'unknown'})`,
      'SCHEMA_READ_FAILED',
      message,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ShardMindError(
      `shard-schema.yaml is not valid YAML: ${message}`,
      'SCHEMA_INVALID_YAML',
      'Check shard-schema.yaml for syntax errors.',
    );
  }

  const result = ShardSchemaFileSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map(i => `${i.path.length === 0 ? '(root)' : i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new ShardMindError(
      `shard-schema.yaml validation failed: ${details}`,
      'SCHEMA_VALIDATION_FAILED',
      'Check shard-schema.yaml against the schema spec.',
    );
  }

  const data = result.data;

  // Reserved-name guard: reject schema values whose key collides with
  // a render-context field (shard, install_date, year, etc.).
  const reserved = Object.keys(data.values).filter(k => RESERVED_VALUE_KEYS.has(k));
  if (reserved.length > 0) {
    throw new ShardMindError(
      `shard-schema.yaml uses reserved value name${reserved.length === 1 ? '' : 's'}: ${reserved.join(', ')}`,
      'SCHEMA_RESERVED_NAME',
      `Rename to avoid collision with the render context. Reserved: ${[...RESERVED_VALUE_KEYS].join(', ')}`,
    );
  }

  // Cross-validate: every value's group must exist
  const groupIds = new Set(data.groups.map(g => g.id));
  for (const [key, val] of Object.entries(data.values)) {
    if (!groupIds.has(val.group)) {
      throw new ShardMindError(
        `shard-schema.yaml validation failed: values.${key}.group references non-existent group "${val.group}"`,
        'SCHEMA_VALIDATION_FAILED',
        `Add a group with id "${val.group}" to the groups array, or change the value's group.`,
      );
    }
  }

  // Normalize frontmatter: shorthand arrays → { required: [...] }
  const frontmatter: Record<string, FrontmatterRule> = {};
  for (const [key, entry] of Object.entries(data.frontmatter)) {
    if (Array.isArray(entry)) {
      frontmatter[key] = { required: entry };
    } else {
      frontmatter[key] = entry;
    }
  }

  return {
    schema_version: data.schema_version,
    values: data.values,
    groups: data.groups,
    modules: data.modules,
    signals: data.signals,
    frontmatter,
    migrations: data.migrations,
  } as ShardSchema;
}

// Note: `any` is used here per spec — zod dynamic generation requires it
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildValuesValidator(schema: ShardSchema): z.ZodObject<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

    // Apply .optional() if not required
    if (!val.required) {
      field = field.optional();
    }

    // Apply .default() if default is set and not computed
    if (val.default !== undefined && !isComputedDefault(val.default)) {
      field = field.default(val.default);
    }

    shape[key] = field;
  }

  return z.object(shape);
}
