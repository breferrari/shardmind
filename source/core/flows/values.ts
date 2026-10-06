/**
 * The values a run installs with, when nothing prompts for them: install's
 * and adopt's shared path (#302). Spec: docs/IMPLEMENTATION.md §4.30 step 2.
 */

import type { ModuleSelections, ShardSchema } from '../../runtime/types.js';
import { ShardMindError } from '../../runtime/types.js';
import { buildValuesValidator } from '../schema.js';
import { describeZodIssues } from '../zod-issues.js';
import { loadValuesYaml } from '../values-io.js';
import { defaultModuleSelections, mergePrefill, missingValueKeys, resolveComputedDefaults } from '../install-planner.js';

/** A run's answers: the values and the module selections. */
export interface ValueAnswers {
  values: Record<string, unknown>;
  selections: ModuleSelections;
}

/** The `--values` file, filtered to the schema's keys. */
export function loadValuesFile(filePath: string, schema: ShardSchema): Promise<Record<string, unknown>> {
  return loadValuesYaml(filePath, {
    label: '--values file',
    schemaFilter: schema,
    errors: { readFailed: 'VALUES_FILE_READ_FAILED', invalid: 'VALUES_FILE_INVALID' },
  });
}

/**
 * The answers without a prompt: the prefill over the schema's defaults,
 * validated, with the default module selections. `yes` says how the run got
 * here (`--yes`, or `--values` without a terminal), which the hint for a
 * missing required value must match: telling a `--values` run to "drop
 * --yes" is advice it cannot follow.
 */
export function answersWithoutPrompting(schema: ShardSchema, prefill: Record<string, unknown>, yes: boolean): ValueAnswers {
  const merged = mergePrefill(schema, prefill);
  const missing = missingValueKeys(schema, merged);
  if (missing.length > 0) {
    throw new ShardMindError(
      `Missing required values: ${missing.join(', ')}`,
      'VALUES_MISSING',
      yes
        ? 'Provide them via --values <file> or drop --yes to prompt interactively.'
        : 'Add them to your --values file, or run in an interactive terminal to be prompted.',
    );
  }
  return {
    values: validateValues(schema, resolveComputedDefaults(schema, merged), 'answers'),
    selections: defaultModuleSelections(schema),
  };
}

/**
 * Where the values came from, which decides the hint. `answers`: an install's
 * or adopt's, from the wizard or a `--values` file. `vault`: an update's, from
 * `shard-values.yaml` after the shard's migrations, plus any new values the
 * update just asked for, checked against the new schema.
 */
export type ValuesSource = 'answers' | 'vault';

const VALUES_HINTS: Record<ValuesSource, string> = {
  answers: 'Fix the named values: in your --values file if you gave one, or answer the prompts again.',
  vault:
    "Fix the named values in shard-values.yaml, or answer again if you just entered them. If you never set one, this update's migrations or new schema made it invalid: report it to the shard's author.",
};

/**
 * `values` checked against the schema's validator, with its defaults and
 * coercions applied. A value that doesn't fit is `VALUES_INVALID` naming each
 * key and what it expected (#346): the user's or the shard author's to fix,
 * never a raw zod error, which the error view would report as a shardmind bug.
 */
export function validateValues(schema: ShardSchema, values: Record<string, unknown>, source: ValuesSource): Record<string, unknown> {
  const result = buildValuesValidator(schema).safeParse(values);
  if (result.success) return result.data as Record<string, unknown>;
  throw new ShardMindError(`Invalid values: ${describeZodIssues(result.error)}`, 'VALUES_INVALID', VALUES_HINTS[source]);
}
