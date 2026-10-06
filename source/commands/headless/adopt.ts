/**
 * `shardmind adopt --json`, run without Ink (#302). Spec:
 * docs/IMPLEMENTATION.md §4.29, §4.30 step 5. `cli.ts` calls it before
 * Pastel loads. The flow never prompts here: a dry run stops at the plan,
 * and without a terminal the values come from `--values` or `--yes`.
 */

import { adoptPlanResult, adoptRunResult } from '../../core/json-output.js';
import { runAdoptFlow } from '../../core/flows/adopt.js';
import type zod from 'zod';
import { args as argsSchema, options as optionsSchema } from '../options/adopt.js';
import { parseArgsOrThrow, runFlowJson, writeStdout, type Write } from './shared.js';

/** The exit code: 0 with a plan or a result, 1 with a failure document, 130 after a Ctrl+C. */
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
      // A --json run never asks: a dry run stops at the plan, and a real run
      // settles the differing files as --yes does, or by --mode (#348).
      {
        ...io,
        ask: () => Promise.reject(new Error('adopt --json never prompts')),
        // stderr only: stdout carries the one JSON document (#347).
        warn: (message) => void process.stderr.write(`${message}
`),
      },
    );
    if (result.kind === 'plan') return adoptPlanResult(result.plan, { dryRun: true, mode: result.mode });
    // A real run answers with what it did (#348). Adopt keeps no snapshot
    // once it succeeded (§4.28, retention per kind).
    return adoptRunResult({
      plan: result.plan,
      resolutions: result.resolutions,
      mode: result.mode,
      modeGiven: options.mode !== undefined,
      version: result.shard.manifest.version,
      summary: result.summary,
      hooks: result.hooks,
      backupDir: null,
      externalTools: result.externalTools,
      durationMs: result.durationMs,
    });
  });
}
