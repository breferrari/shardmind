/**
 * `shardmind update --json`, run without Ink (#302). Spec:
 * docs/IMPLEMENTATION.md §4.29, §4.30 step 7. `cli.ts` calls it before
 * Pastel loads. The flow never prompts here: under --json it refuses a
 * question it would ask (`UPDATE_JSON_NEEDS_ANSWERS`), keeps the user's
 * version of each conflict, and answers with the plan (`--dry-run`) or with
 * what the run did (#348).
 */

import { updatePlanResult, updateRunResult, upToDatePlanResult, upToDateRunResult } from '../../core/json-output.js';
import { runUpdateFlow } from '../../core/flows/update.js';
import type zod from 'zod';
import { options as optionsSchema } from '../options/update.js';
import { parseArgsOrThrow, runFlowJson, writeStdout, type Write } from './shared.js';

/** The exit code: 0 with a plan or a result, 1 with a failure document, 130 after a Ctrl+C. */
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
      // Under --json the flow refuses a question it would ask, or answers it
      // as --yes does (a conflict keeps the user's version, #348).
      { ...io, ask: () => Promise.reject(new Error('update --json never prompts')) },
    );
    // A real run answers with what it did (#348); a dry run with its plan.
    if (result.kind === 'done') {
      return updateRunResult({
        plan: result.plan,
        resolutions: result.resolutions,
        summary: result.summary,
        hooks: result.hooks,
        backupDir: result.backupDir,
        migrationWarnings: result.migrationWarnings,
        externalTools: result.externalTools,
        durationMs: result.durationMs,
      });
    }
    // A --json run always answers with a document (#230): nothing to do is
    // marked, in the same shape as any other.
    if (result.kind === 'up-to-date') {
      return options.dryRun
        ? upToDatePlanResult({ dryRun: true, version: result.state.version })
        : upToDateRunResult(result.state.version);
    }
    return updatePlanResult(result.plan, { dryRun: true });
  });
}
