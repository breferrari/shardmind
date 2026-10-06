/**
 * `shardmind adopt --json`, run without Ink (#302). Spec:
 * docs/IMPLEMENTATION.md §4.29, §4.30 step 5. `cli.ts` calls it before
 * Pastel loads. The flow never prompts here: a dry run stops at the plan,
 * and without a terminal the values come from `--values` or `--yes`.
 */

import { adoptPlanResult } from '../../core/json-output.js';
import { runAdoptFlow } from '../../core/flows/adopt.js';
import type zod from 'zod';
import { args as argsSchema, options as optionsSchema } from '../options/adopt.js';
import { parseArgsOrThrow, runFlowJson, writeStdout, type Write } from './shared.js';

/** The exit code: 0 for a plan, 1 for a failure document. */
export async function runAdoptJson(
  argv: readonly string[],
  engineVersion: string | undefined,
  write: Write = writeStdout,
): Promise<number> {
  return runFlowJson('adopt', write, async (io) => {
    const { args, options } = parseArgsOrThrow<zod.infer<typeof argsSchema>, zod.infer<typeof optionsSchema>>(
      argv,
      { args: argsSchema, options: optionsSchema },
      'Run `shardmind adopt --help` for the arguments and options adopt takes.',
    );
    const result = await runAdoptFlow(
      {
        shardRef: args[0],
        valuesFile: options.values,
        yes: options.yes,
        mode: options.mode,
        fromVersion: options.fromVersion,
        dryRun: options.dryRun,
        json: true,
        interactive: false,
        vaultRoot: process.cwd(),
        engineVersion,
      },
      // A --json run stops at the plan, before any question.
      { ...io, ask: () => Promise.reject(new Error('adopt --json never prompts')) },
    );
    if (result.kind !== 'plan') throw new Error('adopt --json returned no plan');
    return adoptPlanResult(result.plan, { dryRun: true, mode: result.mode });
  });
}
