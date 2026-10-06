/**
 * `shardmind adopt --json`, run without Ink (#302). Spec:
 * docs/IMPLEMENTATION.md §4.29, §4.30 step 5. `cli.ts` calls it before
 * Pastel loads. The flow never prompts here: a dry run stops at the plan,
 * and without a terminal the values come from `--values` or `--yes`.
 */

import { parseCommandArgv } from '../../cli-kit/parse.js';
import { adoptPlanResult, emitJson, jsonFailure, jsonSuccess } from '../../core/json-output.js';
import { runAdoptFlow } from '../../core/flows/adopt.js';
import { DownloadCancelledError } from '../../core/download.js';
import { ShardMindError } from '../../runtime/types.js';
import type zod from 'zod';
import { args as argsSchema, options as optionsSchema } from '../options/adopt.js';

/** The exit code: 0 for a plan, 1 for a failure document. */
export async function runAdoptJson(
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
    const { args, options } = parseArgs(argv);
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
      {
        // A --json run stops at the plan, before any question.
        ask: () => Promise.reject(new Error('adopt --json never prompts')),
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
    if (result.kind !== 'plan') throw new Error('adopt --json returned no plan');
    emitJson(jsonSuccess('adopt', adoptPlanResult(result.plan, { dryRun: true, mode: result.mode })), write);
    return 0;
  } catch (err) {
    // A Ctrl+C stopped the download: the SIGINT handler exits 130, and the
    // caller gets no document for a run it cancelled.
    if (err instanceof DownloadCancelledError) return 130;
    emitJson(jsonFailure('adopt', err), write);
    return 1;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

function parseArgs(argv: readonly string[]) {
  try {
    return parseCommandArgv<zod.infer<typeof argsSchema>, zod.infer<typeof optionsSchema>>(argv, {
      args: argsSchema,
      options: optionsSchema,
    });
  } catch (err) {
    throw new ShardMindError(
      err instanceof Error ? err.message : String(err),
      'ARGS_INVALID',
      'Run `shardmind adopt --help` for the arguments and options adopt takes.',
    );
  }
}
