/**
 * `shardmind update --json`, run without Ink (#302). Spec:
 * docs/IMPLEMENTATION.md §4.29, §4.30 step 7. `cli.ts` calls it before
 * Pastel loads. The flow never prompts here: under --json it refuses a
 * question it would ask (`UPDATE_JSON_NEEDS_ANSWERS`), keeps the user's
 * version of each conflict, and answers with the plan (`--dry-run`) or with
 * what the run did (#348). A vault holding several shards (#407) answers
 * each shard's document in `shards` (ARCHITECTURE §10.3b).
 */

import {
  updatePlanResult,
  updateRunResult,
  upToDatePlanResult,
  upToDateRunResult,
  toJsonError,
  ShardRunsFailed,
  type UpdateShardEntry,
} from '../../core/json-output.js';
import { runUpdateFlow, type ShardUpdateResult } from '../../core/flows/update.js';
import type zod from 'zod';
import { args as argsSchema, options as optionsSchema } from '../options/update.js';
import { parseArgsOrThrow, runFlowJson, writeStdout, type Write } from './shared.js';

/** The exit code: 0 with a plan or a result, 1 with a failure document, 130 after a Ctrl+C. */
export async function runUpdateJson(
  argv: readonly string[],
  engineVersion: string | undefined,
  write: Write = writeStdout,
): Promise<number> {
  return runFlowJson('update', write, async (io) => {
    const { args, options } = parseArgsOrThrow<zod.infer<typeof argsSchema>, zod.infer<typeof optionsSchema>>(
      argv,
      { args: argsSchema, options: optionsSchema },
      'Run `shardmind update --help` for the options update takes.',
    );
    const result = await runUpdateFlow(
      {
        vaultRoot: process.cwd(),
        shard: args[0],
        yes: options.yes,
        dryRun: options.dryRun,
        json: true,
        release: options.release,
        includePrerelease: options.includePrerelease,
        adoptPreexisting: options.adoptPreexisting,
        skipHooks: options.skipHooks,
        engineVersion,
      },
      // Under --json the flow refuses a question it would ask, or answers it
      // as --yes does (a conflict keeps the user's version, #348).
      { ...io, ask: () => Promise.reject(new Error('update --json never prompts')) },
    );
    if (result.kind !== 'shards') return documentOf(result, options.dryRun);
    // Several shards (#407): each one's document; the first's at the top
    // when all succeeded, else the failure with every entry in details.
    const shards: UpdateShardEntry[] = [];
    let first: object | undefined;
    let failed: { shard: string; error: unknown } | undefined;
    for (const run of result.runs) {
      if ('result' in run) {
        const document = documentOf(run.result, options.dryRun);
        first ??= document;
        shards.push({ shard: run.shard, result: document });
      } else if ('error' in run) {
        failed = run;
        shards.push({ shard: run.shard, error: toJsonError(run.error) });
      } else {
        shards.push(run);
      }
    }
    if (failed) throw new ShardRunsFailed(failed, shards);
    return { ...first, shards };
  });
}

/** One shard's document: what a real run did (#348), or a dry run's plan. */
function documentOf(result: ShardUpdateResult, dryRun: boolean): object {
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
    return dryRun
      ? upToDatePlanResult({ dryRun: true, version: result.state.version })
      : upToDateRunResult(result.state.version, result);
  }
  return updatePlanResult(result.plan, { dryRun: true });
}
