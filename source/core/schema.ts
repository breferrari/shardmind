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
import { errnoCode } from '../runtime/errno.js';

const OptionSchema = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
  // Per-option default flag. Authoring sugar for `type: multiselect` only:
  // options marked `default: true` seed the value's default selection.
  // `parseSchema` normalizes these into the value's canonical top-level
  // `default` array and strips the booleans, so this never reaches the
  // cached schema. Rejected on non-multiselect values.
  default: z.boolean().optional(),
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
  // `default` type-match. Skipped only for `{{ … }}` computed
  // expressions (resolved at install time against the user's other
  // answers). Every other literal — including `null` — must match
  // the declared `type`. Authors who want an empty default use a
  // type-matching literal: `""` for string, `0` for number, `false`
  // for boolean, `[]` for list/multiselect, the first option for
  // select. Allowing `null` past this check would propagate to
  // `mergePrefill` and `buildValuesValidator`, surfacing as a
  // confusing zod runtime error far from the offending schema line.
  if (val.default !== undefined && !isComputedDefault(val.default)) {
    const d = val.default;
    let typeMismatch: string | null = null;
    switch (val.type) {
      case 'string':
        if (typeof d !== 'string') typeMismatch = `expected string, got ${typeof d}`;
        break;
      case 'boolean':
        if (typeof d !== 'boolean') typeMismatch = `expected boolean, got ${typeof d}`;
        break;
      case 'number':
        if (typeof d !== 'number' || !Number.isFinite(d)) typeMismatch = `expected finite number, got ${typeof d === 'number' ? String(d) : typeof d}`;
        break;
      case 'list':
      case 'multiselect':
        if (!Array.isArray(d)) typeMismatch = `expected array, got ${typeof d}`;
        break;
      case 'select':
        if (typeof d !== 'string') typeMismatch = `expected string (one of options), got ${typeof d}`;
        break;
    }
    if (typeMismatch !== null) {
      ctx.issues.push({
        code: 'custom',
        path: ['default'],
        message: `\`default\` does not match \`type: ${val.type}\` — ${typeMismatch}`,
        input: val,
      });
    } else if (val.type === 'select' && val.options && typeof d === 'string') {
      const allowed = val.options.map(o => o.value);
      if (!allowed.includes(d)) {
        ctx.issues.push({
          code: 'custom',
          path: ['default'],
          message: `\`default: ${JSON.stringify(d)}\` is not one of \`options[].value\`: ${JSON.stringify(allowed)}`,
          input: val,
        });
      }
    } else if (val.type === 'multiselect' && val.options && Array.isArray(d)) {
      const allowed = new Set(val.options.map(o => o.value));
      const bad = d.filter(item => typeof item !== 'string' || !allowed.has(item));
      if (bad.length > 0) {
        ctx.issues.push({
          code: 'custom',
          path: ['default'],
          message: `\`default\` contains values not in \`options[].value\`: ${JSON.stringify(bad)}`,
          input: val,
        });
      }
    }
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
    const fsCode = errnoCode(err);
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

  const rawValues = (parsed as { values?: Record<string, unknown> }).values ?? {};
  const hasOwnDefault = (key: string): boolean => {
    const raw = rawValues[key];
    return !!raw && typeof raw === 'object' && !Array.isArray(raw) && 'default' in raw;
  };

  // Multiselect default normalization. The author-facing API marks default
  // selections per-option (`options: [{ value, default: true }]`); the engine
  // normalizes that into the value's canonical top-level `default` array and
  // strips the per-option booleans. Doing it here means every downstream
  // consumer (zod validator, valuesAreDefaults, install-planner, the cached
  // schema the runtime + update re-parse read) only ever sees the array form,
  // and re-parsing the normalized output never re-triggers the both-sources
  // guard below.
  for (const [key, val] of Object.entries(data.values)) {
    // Single pass over the options: which ones declare a `default` flag at all
    // (`perOption`) and which are `default: true` (the synthesized selection).
    const defaultedValues: string[] = [];
    let perOption = false;
    for (const opt of val.options ?? []) {
      if (opt.default !== undefined) {
        perOption = true;
        if (opt.default === true) defaultedValues.push(opt.value);
      }
    }

    // Per-option `default` is multiselect-only; on any other type it would be
    // silently ignored, so reject it loudly.
    if (perOption && val.type !== 'multiselect') {
      throw new ShardMindError(
        `shard-schema.yaml validation failed: values.${key} uses per-option \`default\` on \`type: ${val.type}\``,
        'SCHEMA_VALIDATION_FAILED',
        'Per-option `default: true` is only valid for `type: multiselect`. For select, declare the value\'s top-level `default` (a single `options[].value`).',
      );
    }

    if (val.type !== 'multiselect') continue;

    if (perOption && hasOwnDefault(key)) {
      throw new ShardMindError(
        `shard-schema.yaml validation failed: values.${key} declares both a per-option \`default\` and a top-level \`default\``,
        'SCHEMA_VALIDATION_FAILED',
        'A multiselect declares its default EITHER via per-option `default: true` OR a top-level `default` array, never both.',
      );
    }

    if (perOption) {
      val.default = defaultedValues;
      for (const opt of val.options ?? []) delete opt.default;
    } else if (!hasOwnDefault(key)) {
      // No per-option flags and no top-level default → empty selection.
      val.default = [];
    }
    // top-level default present → leave as-is (literal array or computed
    // `{{ … }}`; membership already checked in ValueDefinitionSchema.check()).

    // `min`/`max` are selected-count bounds here, so unlike the `number` type
    // they must be non-negative integers — a fractional bound yields nonsense
    // like "Select at least 1.5 options".
    for (const bound of ['min', 'max'] as const) {
      const n = val[bound];
      if (n !== undefined && (!Number.isInteger(n) || n < 0)) {
        throw new ShardMindError(
          `shard-schema.yaml validation failed: values.${key} ${bound} must be a non-negative integer (got ${n})`,
          'SCHEMA_VALIDATION_FAILED',
          'A multiselect `min`/`max` bound the selected count, so they must be whole, non-negative numbers.',
        );
      }
    }

    // `min` cannot exceed the number of options — no selection could ever
    // satisfy it. Caught here (not in .check()) so the message can name the
    // count.
    const optionCount = (val.options ?? []).length;
    if (val.min !== undefined && val.min > optionCount) {
      throw new ShardMindError(
        `shard-schema.yaml validation failed: values.${key} has min ${val.min} but only ${optionCount} option${optionCount === 1 ? '' : 's'}`,
        'SCHEMA_VALIDATION_FAILED',
        'A multiselect `min` cannot exceed the number of options — no selection could satisfy it.',
      );
    }

    // The default selection must itself satisfy min/max. zod's `.default()`
    // short-circuits validation (a `--defaults` install returns the default
    // WITHOUT re-checking `.min()`), so an out-of-range default would write a
    // schema-invalid value silently — and break Invariant 1 (a `--defaults`
    // install must produce a valid vault). Reject at parse instead. Computed
    // `{{ … }}` defaults resolve at install time against the user's answers,
    // so their length is unknowable here — skip them.
    if (Array.isArray(val.default)) {
      const len = val.default.length;
      if (val.min !== undefined && len < val.min) {
        throw new ShardMindError(
          `shard-schema.yaml validation failed: values.${key} default selects ${len} but min is ${val.min}`,
          'SCHEMA_VALIDATION_FAILED',
          'A multiselect with `min` must declare a default that selects at least that many options (via per-option `default: true` or a top-level `default` array).',
        );
      }
      if (val.max !== undefined && len > val.max) {
        throw new ShardMindError(
          `shard-schema.yaml validation failed: values.${key} default selects ${len} but max is ${val.max}`,
          'SCHEMA_VALIDATION_FAILED',
          'A multiselect default cannot select more options than `max`.',
        );
      }
    }
  }

  // Every value MUST declare a `default` field. The check reads the raw
  // YAML because zod's `default: z.unknown().optional()` strips the key
  // when missing, so post-parse `'default' in val` can't distinguish
  // missing from explicit-undefined. Empty/falsey values like `""`,
  // `false`, `0`, `[]` are accepted — the rule is presence, not
  // non-emptiness. (Type-match for the literal happens in the
  // `ValueDefinitionSchema.check()` rule above; `null` is rejected
  // there because it doesn't match any of the six value types.)
  // Multiselect is exempt: its default is derived above (per-option or []).
  const missingDefault: string[] = [];
  for (const key of Object.keys(data.values)) {
    if (data.values[key]!.type === 'multiselect') continue;
    if (!hasOwnDefault(key)) {
      missingDefault.push(key);
    }
  }
  if (missingDefault.length > 0) {
    throw new ShardMindError(
      `shard-schema.yaml: values missing required \`default\` field: ${missingDefault.join(', ')}`,
      'SCHEMA_VALIDATION_FAILED',
      'Every value must declare a `default` whose type matches the value\'s `type`: "" for string, false for boolean, 0 for number, [] for list, one of `options[].value` for select. (Multiselect uses per-option `default: true`.)',
    );
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
        let arr = z.array(z.enum(values));
        if (val.min !== undefined) arr = arr.min(val.min);
        if (val.max !== undefined) arr = arr.max(val.max);
        field = arr;
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
