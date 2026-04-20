/**
 * Read + parse a shard-values YAML document.
 *
 * Two call sites — install's optional `--values` prefill file and
 * update's canonical `shard-values.yaml` in the vault — used to each
 * own a copy of this logic with subtly different error codes. Keeping
 * one function makes the YAML-parse + mapping-validation story
 * identical for both paths.
 *
 * The `schemaFilter` option controls whether unknown keys survive. The
 * install prefill filters them out (values files get reused across
 * shard versions, so extra keys are expected and harmless); update
 * keeps everything (we're reading values we wrote, and migrations run
 * after the load to handle any shape changes).
 */

import fsp from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type { ShardSchema, ErrorCode } from '../runtime/types.js';
import { ShardMindError } from '../runtime/types.js';

export interface LoadValuesOptions {
  /** If set, drop keys not listed in `schema.values`. */
  schemaFilter?: ShardSchema;
  /** Error codes override per call site so user hints stay contextual. */
  errors: {
    readFailed: ErrorCode;
    invalid: ErrorCode;
  };
  /** Human label for the file; embedded in error messages. */
  label: string;
}

export async function loadValuesYaml(
  filePath: string,
  opts: LoadValuesOptions,
): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf-8');
  } catch (err) {
    throw new ShardMindError(
      `Could not read ${opts.label}: ${filePath}`,
      opts.errors.readFailed,
      err instanceof Error ? err.message : String(err),
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new ShardMindError(
      `${opts.label} is not valid YAML: ${filePath}`,
      opts.errors.invalid,
      err instanceof Error ? err.message : String(err),
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ShardMindError(
      `${opts.label} must be a YAML mapping: ${filePath}`,
      opts.errors.invalid,
      'Top level must be key/value entries.',
    );
  }

  const asObject = parsed as Record<string, unknown>;
  if (!opts.schemaFilter) return asObject;

  const filtered: Record<string, unknown> = {};
  for (const key of Object.keys(opts.schemaFilter.values)) {
    if (key in asObject) filtered[key] = asObject[key];
  }
  return filtered;
}
