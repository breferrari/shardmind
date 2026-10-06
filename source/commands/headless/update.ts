/**
 * `shardmind update --json`, run without Ink (#302). Spec:
 * docs/IMPLEMENTATION.md §4.29, §4.30 step 7. `cli.ts` calls it before
 * Pastel loads. The flow never prompts here: under --json it refuses a
 * question it would ask (`UPDATE_JSON_NEEDS_ANSWERS`) or stops at the plan.
 */

import { parseCommandArgv } from '../../cli-kit/parse.js';
import { emitJson, jsonFailure, jsonSuccess, updatePlanResult, upToDatePlanResult } from '../../core/json-output.js';
import { runUpdateFlow } from '../../core/flows/update.js';
import { DownloadCancelledError } from '../../core/download.js';
import { ShardMindError } from '../../runtime/types.js';
import type zod from 'zod';
import { options as optionsSchema } from '../options/update.js';

/** The exit code: 0 for a plan or an up-to-date vault, 1 for a failure document. */
export async function runUpdateJson(
  argv: readonly string[],
  engineVersion: string | undefined,
  write: (chunk: string) => void = (chunk) => void process.stdout.write(chunk),
): Promise<number> {
  let cleanup: (() => Promise<void>) | undefined;
  // Ctrl+C mid-download: remove the temp dir before exiting 130 (#57).
  const onSigint = (): void => {
    void (cleanup?.() ?? Promise.resolve()).finally(() => process.exit(130));
  };
  process.once('SIGINT', onSigint);
  try {
    const options = parseOptions(argv);
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
      {
        // Under --json the flow refuses or stops at the plan before any question.
        ask: () => Promise.reject(new Error('update --json never prompts')),
        phase: () => {},
        progress: () => {},
        hooks: { setPhase: () => {}, onStdout: () => {}, onStderr: () => {} },
        // --json runs only with --dry-run, which takes no lock.
        takeLock: () => {},
        onCleanup: (c) => {
          cleanup = c;
        },
        newRunAbort: () => new AbortController(),
        onRun: () => {},
        onCommitted: () => {},
        onHookAbort: () => {},
      },
    );
    if (result.kind === 'done') throw new Error('update --json returned no plan');
    // A --json run always answers with a document (#230): nothing to do is
    // an empty plan, in the same shape as any other.
    const document =
      result.kind === 'up-to-date'
        ? upToDatePlanResult({ dryRun: true, version: result.state.version })
        : updatePlanResult(result.plan, { dryRun: true });
    emitJson(jsonSuccess('update', document), write);
    return 0;
  } catch (err) {
    // A Ctrl+C stopped the download: the SIGINT handler exits 130, and the
    // caller gets no document for a run it cancelled.
    if (err instanceof DownloadCancelledError) return 130;
    emitJson(jsonFailure('update', err), write);
    return 1;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

function parseOptions(argv: readonly string[]) {
  try {
    return parseCommandArgv<[], zod.infer<typeof optionsSchema>>(argv, { options: optionsSchema }).options;
  } catch (err) {
    throw new ShardMindError(
      err instanceof Error ? err.message : String(err),
      'ARGS_INVALID',
      'Run `shardmind update --help` for the options update takes.',
    );
  }
}
