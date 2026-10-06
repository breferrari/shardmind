/**
 * What the headless `--json` runners share (#302). Spec:
 * docs/IMPLEMENTATION.md §4.29, §4.30. Each runner turns its options into a
 * document; the parsing, the failure document and, for a flow that downloads
 * a shard, the Ctrl+C cleanup are here.
 */

import { parseCommandArgv } from '../../cli-kit/parse.js';
import { DownloadCancelledError } from '../../core/download.js';
import { emitJson, jsonFailure, jsonSuccess, type JsonCommand } from '../../core/json-output.js';
import type { HookRunUi } from '../../core/hook-orchestrator.js';
import { ShardMindError } from '../../runtime/types.js';

export type Write = (chunk: string) => void;

export const writeStdout: Write = (chunk) => void process.stdout.write(chunk);

/**
 * `argv` parsed as the Pastel run parses it; its error is `ARGS_INVALID`
 * with Pastel's message and `help` as the hint.
 */
export function parseArgsOrThrow<A extends unknown[], O>(
  argv: readonly string[],
  schemas: Parameters<typeof parseCommandArgv>[1],
  help: string,
): { args: A; options: O } {
  try {
    return parseCommandArgv<A, O>(argv, schemas);
  } catch (err) {
    throw new ShardMindError(err instanceof Error ? err.message : String(err), 'ARGS_INVALID', help);
  }
}

/** The members of a flow's io that a `--json` run has nothing for. */
export interface HeadlessFlowIO {
  phase: () => void;
  progress: () => void;
  hooks: Omit<HookRunUi, 'signal'>;
  takeLock: () => void;
  onCleanup: (cleanup: () => Promise<void>) => void;
  newRunAbort: () => AbortController;
  onRun: () => void;
  onCommitted: () => void;
  onHookAbort: () => void;
}

/**
 * Runs a flow-backed `--json` command and returns its exit code: 0 with the
 * document `run` returns, 1 with a failure document. `run` gets the io a
 * `--json` run gives its flow: it shows nothing, and takes no lock, since
 * `--json` runs only with `--dry-run`. A Ctrl+C during the download removes
 * the temp dir and exits 130 with no document: the caller cancelled it (#57).
 */
export async function runFlowJson(
  command: JsonCommand,
  write: Write,
  run: (io: HeadlessFlowIO) => Promise<unknown>,
): Promise<number> {
  let cleanup: (() => Promise<void>) | undefined;
  const onSigint = (): void => {
    void (cleanup?.() ?? Promise.resolve()).finally(() => process.exit(130));
  };
  process.once('SIGINT', onSigint);
  try {
    const document = await run({
      phase: () => {},
      progress: () => {},
      hooks: { setPhase: () => {}, onStdout: () => {}, onStderr: () => {} },
      takeLock: () => {},
      onCleanup: (c) => {
        cleanup = c;
      },
      newRunAbort: () => new AbortController(),
      onRun: () => {},
      onCommitted: () => {},
      onHookAbort: () => {},
    });
    emitJson(jsonSuccess(command, document), write);
    return 0;
  } catch (err) {
    // The SIGINT handler exits 130; a cancelled run gets no document.
    if (err instanceof DownloadCancelledError) return 130;
    emitJson(jsonFailure(command, err), write);
    return 1;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}
