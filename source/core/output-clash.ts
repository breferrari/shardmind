/**
 * Two shard outputs that name the same vault file (#240).
 *
 * A static file and a template, two templates, or an `_each` expansion and
 * either can resolve to one path, identically or differing only in case or
 * Unicode form. One write then overwrites the other, and on a case-folding
 * filesystem (macOS, Windows) the vault tracks two names for one file. The
 * whole planned output set is checked once, before any write, by install
 * (`planOutputs`), update (`renderNewShard`) and adopt (`classifyAdoption`),
 * and by `lintShard`, so `shardmind validate` reports it before anyone
 * installs. Items of one `_each` list are the special case `eachOutputPaths`
 * refuses first, with an item-level message (#234), using the same fold.
 */

import { ShardMindError } from '../runtime/types.js';

/**
 * One planned output and where it comes from: the shard-relative source path
 * of a template or file, plus the list item for an `_each` expansion.
 */
export interface OutputRef {
  readonly outputPath: string;
  readonly origin: string;
}

/**
 * The comparison key for a vault path: NFC, then lower case, as the
 * vault-path guard and rename migrations compare names.
 */
export function foldOutputPath(outputPath: string): string {
  return outputPath.normalize('NFC').toLowerCase();
}

/** Throws OUTPUT_PATH_CLASH for the first two outputs that name the same file. */
export function assertNoOutputClashes(outputs: Iterable<OutputRef>): void {
  const seen = new Map<string, OutputRef>();
  for (const output of outputs) {
    const key = foldOutputPath(output.outputPath);
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, output);
      continue;
    }
    throw new ShardMindError(
      `${first.origin} and ${output.origin} both install to ${first.outputPath === output.outputPath ? output.outputPath : `${first.outputPath} / ${output.outputPath}`}`,
      'OUTPUT_PATH_CLASH',
      'Two shard files cannot name the same vault file, even differing only in case: one write would overwrite the other. Rename one of them in the shard, or change the list item the `_each` file is named after.',
    );
  }
}
