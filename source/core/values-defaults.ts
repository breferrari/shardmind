/**
 * `valuesAreDefaults` — deep-equal comparison of a user's values map
 * against the schema's would-be-default map.
 *
 * Used by the install / update orchestration to populate
 * `HookContext.valuesAreDefaults`. A `true` answer tells the shard's
 * post-install / post-update hook that the user accepted every default,
 * so any edits to managed files would silently overwrite content the
 * user didn't choose to customize. Per Invariant 2 (`docs/SHARD-LAYOUT.md`),
 * hooks that modify managed files must no-op when this flag is true;
 * unmanaged files are unaffected.
 *
 * The comparison is strict: `JSON.stringify`-style structural deep-equal,
 * preserving order in arrays. Multiselect order is therefore meaningful
 * here — schema-default `["a","b"]` vs user `["b","a"]` answers `false`.
 * In practice the wizard preserves schema-option order on `--defaults`
 * runs and on no-op multiselect submissions, so the strict rule fires
 * only when the user actually changed selection. Documented in
 * `docs/AUTHORING.md §6`.
 *
 * Computed defaults (`{{ … }}`) are resolved against the literal-default
 * map first, so a schema with `b.default: '{{ values.a }}'` and `a.default:
 * 'foo'` reports `valuesAreDefaults === true` when the user has
 * `{ a: 'foo', b: 'foo' }`. If the resolution itself throws (a malformed
 * computed default that nonetheless passed schema validation), we return
 * `false` rather than propagate — the hook context construction must not
 * fail the install or update.
 *
 * Schema keys without a `default` field are unreachable post-#74 (the
 * validator rejects them at parse time); the function still copes
 * defensively by returning `false` when a schema key has no default.
 */

import type { ShardSchema } from '../runtime/types.js';
import { isComputedDefault } from './schema.js';
import { resolveComputedDefaults } from './install-planner.js';

export function valuesAreDefaults(
  values: Record<string, unknown>,
  schema: ShardSchema,
): boolean {
  const literalDefaults: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(schema.values)) {
    if (def.default === undefined) return false;
    if (isComputedDefault(def.default)) continue;
    literalDefaults[key] = def.default;
  }

  let wouldBeDefaults: Record<string, unknown>;
  try {
    wouldBeDefaults = resolveComputedDefaults(schema, literalDefaults);
  } catch {
    return false;
  }

  for (const key of Object.keys(schema.values)) {
    if (!(key in wouldBeDefaults)) return false;
    if (!deepEqual(values[key], wouldBeDefaults[key])) return false;
  }

  return true;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;

  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false;
    }
  }
  return true;
}
