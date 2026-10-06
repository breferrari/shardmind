/**
 * The values a run installs with, when nothing prompts for them: install's
 * and adopt's shared path (#302). Spec: docs/IMPLEMENTATION.md §4.30 step 2.
 */

import type { ModuleSelections, ShardSchema } from '../../runtime/types.js';
import { ShardMindError } from '../../runtime/types.js';
import { buildValuesValidator } from '../schema.js';
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
  return { values: validateValues(schema, resolveComputedDefaults(schema, merged)), selections: defaultModuleSelections(schema) };
}

/** `values` checked against the schema's validator, with its defaults and coercions applied. */
export function validateValues(schema: ShardSchema, values: Record<string, unknown>): Record<string, unknown> {
  return buildValuesValidator(schema).parse(values) as Record<string, unknown>;
}
