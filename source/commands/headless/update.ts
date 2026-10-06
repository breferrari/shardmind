/**
 * `shardmind update --json`, run without Ink (#302). Spec:
 * docs/IMPLEMENTATION.md §4.29, §4.30 step 7. `cli.ts` calls it before
 * Pastel loads. The flow never prompts here: under --json it refuses a
 * question it would ask (`UPDATE_JSON_NEEDS_ANSWERS`) or stops at the plan.
 */

import { updatePlanResult, upToDatePlanResult } from '../../core/json-output.js';
import { runUpdateFlow } from '../../core/flows/update.js';
import type zod from 'zod';
import { options as optionsSchema } from '../options/update.js';
import { parseArgsOrThrow, runFlowJson, writeStdout, type Write } from './shared.js';

/** The exit code: 0 for a plan or an up-to-date vault, 1 for a failure document. */
export async function runUpdateJson(
  argv: readonly string[],
  engineVersion: string | undefined,
  write: Write = writeStdout,
): Promise<number> {
  return runFlowJson('update', write, async (io) => {
    const { options } = parseArgsOrThrow<[], zod.infer<typeof optionsSchema>>(
      argv,
      { options: optionsSchema },
      'Run `shardmind update --help` for the options update takes.',
    );
    const result = await runUpdateFlow(
      {
        vaultRoot: process.cwd(),
        yes: options.yes,
        dryRun: options.dryRun,
        json: true,
        release: options.release,
        includePrerelease: options.includePrerelease,
        adoptPreexisting: options.adoptPreexisting,
        engineVersion,
      },
      // Under --json the flow refuses or stops at the plan before any question.
      { ...io, ask: () => Promise.reject(new Error('update --json never prompts')) },
    );
    if (result.kind === 'done') throw new Error('update --json returned no plan');
    // A --json run always answers with a document (#230): nothing to do is
    // an empty plan, in the same shape as any other.
    return result.kind === 'up-to-date'
      ? upToDatePlanResult({ dryRun: true, version: result.state.version })
      : updatePlanResult(result.plan, { dryRun: true });
  });
}
