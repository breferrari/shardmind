/**
 * `shardmind --json`, run without Ink (#302). Spec: docs/IMPLEMENTATION.md
 * §4.29. `cli.ts` calls it before Pastel loads: a mounted Ink app wrote
 * terminal codes around a document and a blank line after it (§4.23).
 */

import { buildStatusReport } from '../../core/status.js';
import { emitJson, jsonFailure, jsonSuccess, statusResult } from '../../core/json-output.js';
import { options } from '../options/status.js';
import { parseArgsOrThrow, writeStdout, type Write } from './shared.js';

/** The exit code: 0 for a report or no vault, 1 for a failure document. */
export async function runStatusJson(
  argv: readonly string[],
  _engineVersion: string | undefined,
  write: Write = writeStdout,
): Promise<number> {
  try {
    const { verbose } = parseArgsOrThrow<[], { verbose: boolean }>(
      argv,
      { options },
      'Run `shardmind --help` for the options the status command takes.',
    ).options;
    // As the Ink run: the shard's update check runs; --no-update-check
    // turns off only the engine's self-update banner, which --json never shows.
    const report = await buildStatusReport(process.cwd(), { verbose, skipUpdateCheck: false, uncapped: true });
    emitJson(jsonSuccess('status', statusResult(report)), write);
    return 0;
  } catch (err) {
    emitJson(jsonFailure('status', err), write);
    return 1;
  }
}
