/**
 * The values validator: a zod schema built from a shard's value
 * definitions. One implementation, used by the engine (`core/schema.ts`
 * re-exports it) and by the runtime's `validateValues`, so a hook and the
 * engine always agree on what a valid value is (#358). It lives in the
 * runtime because the runtime may not import from core.
 */

import { z } from 'zod';
import type { ShardSchema } from './types.js';

/** A default written as a template (`{{ ... }}`), resolved at install time rather than by the validator. */
export function isComputedDefault(value: unknown): boolean {
  return typeof value === 'string' && value.trimStart().startsWith('{{');
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
