/**
 * Two shard outputs that name the same vault file (#240).
 *
 * A static file and a template, two templates, or an `_each` expansion and
 * either can resolve to one path, identically or differing only in case or
 * Unicode form. One write then overwrites the other, and on a case-folding
 * filesystem (macOS, Windows) the vault tracks two names for one file. The
 * same holds one level up: `Notes/a.md` and `notes/b.md` land in one folder
 * there, and a file at `notes` blocks the folder `notes/today.md` needs.
 *
 * `plannedOutputRefs` lists every output of a module resolution (with
 * `_each` expansions for the given values), and `findOutputClashes` /
 * `assertNoOutputClashes` check the list. Install (`planOutputs`), update
 * (`renderNewShard`) and adopt (`classifyAdoption`) refuse before any write;
 * `lintShard` reports, so `shardmind validate` catches it before anyone
 * installs. Items of one `_each` list are the special case `eachOutputPaths`
 * refuses first, with an item-level message (#234), using the same fold.
 */

import type { FileEntry } from '../runtime/types.js';
import { ShardMindError } from '../runtime/types.js';
import { foldOutputPath, toPosix } from './fs-utils.js';
import { eachOutputPaths } from './renderer.js';

export { foldOutputPath };

/**
 * One planned output and where it comes from: the shard-relative source path
 * of a template or file, with the list item for an `_each` expansion.
 */
export interface OutputRef {
  readonly outputPath: string;
  readonly origin: string;
  /** The module the source belongs to; null when it is always installed. */
  readonly module?: string | null;
}

/**
 * Every output of a module resolution, as install would write it. An `_each`
 * template is listed under the paths its items name when `values` holds its
 * list, else under its own path. Items of one list that name the same file
 * are listed once: `eachOutputPaths` refuses them with its own message.
 */
export function plannedOutputRefs(
  resolution: { render: readonly FileEntry[]; copy: readonly FileEntry[] },
  values: Record<string, unknown> | undefined,
  sourceRoot: string,
): OutputRef[] {
  const refs: OutputRef[] = [];
  for (const entry of resolution.render) {
    const origin = toPosix(sourceRoot, entry.sourcePath);
    const list = entry.iterator && values ? values[entry.iterator] : undefined;
    if (!Array.isArray(list)) {
      refs.push({ outputPath: entry.outputPath, origin, module: entry.module });
      continue;
    }
    const listed = new Set<string>();
    for (const item of list) {
      let outputPath: string;
      try {
        outputPath = eachOutputPaths(entry.outputPath, [item])[0]!;
      } catch {
        continue; // an item with no name is the render's to report
      }
      const key = foldOutputPath(outputPath);
      if (listed.has(key)) continue;
      listed.add(key);
      refs.push({ outputPath, origin: `${origin} (item ${describeItem(item)})`, module: entry.module });
    }
  }
  for (const entry of resolution.copy) {
    refs.push({ outputPath: entry.outputPath, origin: toPosix(sourceRoot, entry.sourcePath), module: entry.module });
  }
  return refs;
}

/** One clash: two outputs that would write the same file or folder. */
export interface OutputClash {
  readonly first: OutputRef;
  readonly second: OutputRef;
  /** What the two collide on: the same file, or a file where a folder must be, or two spellings of one folder. */
  readonly at: string;
}

/**
 * Every clash in `outputs`, compared NFC- and case-folded. Besides two
 * outputs at one path, it finds a file that sits where another output needs
 * a folder, and two outputs whose folders differ only in case.
 */
export function findOutputClashes(outputs: Iterable<OutputRef>): OutputClash[] {
  const files = new Map<string, OutputRef>();
  // Each folder (folded) with the spelling and output that first used it.
  const folders = new Map<string, { spelling: string; ref: OutputRef }>();
  const clashes: OutputClash[] = [];
  const all = [...outputs];

  for (const ref of all) {
    const parts = ref.outputPath.split('/');
    for (let i = 1; i < parts.length; i++) {
      const spelling = parts.slice(0, i).join('/');
      const key = foldOutputPath(spelling);
      const seen = folders.get(key);
      if (!seen) folders.set(key, { spelling, ref });
      else if (seen.spelling !== spelling) clashes.push({ first: seen.ref, second: ref, at: `${seen.spelling}/ and ${spelling}/` });
    }
  }
  for (const ref of all) {
    const key = foldOutputPath(ref.outputPath);
    const seen = files.get(key);
    if (seen) {
      clashes.push({ first: seen, second: ref, at: seen.outputPath === ref.outputPath ? ref.outputPath : `${seen.outputPath} and ${ref.outputPath}` });
      continue;
    }
    files.set(key, ref);
    const folder = folders.get(key);
    if (folder) clashes.push({ first: ref, second: folder.ref, at: `${ref.outputPath} (a file, and a folder of ${folder.ref.outputPath})` });
  }
  return clashes;
}

/** The error for a clash; its hint is for the shard's author and its users alike. */
export function outputClashError(clash: OutputClash): ShardMindError {
  return new ShardMindError(
    `${clash.first.origin} and ${clash.second.origin} both install to ${clash.at}`,
    'OUTPUT_PATH_CLASH',
    'Two shard files cannot install to the same vault path, even differing only in case. Shard author: rename one of them (or, for an `_each` file, the list item it is named after). Installing it: report this to the shard author; if the item comes from your own values, rename it in shard-values.yaml.',
  );
}

/** Throws OUTPUT_PATH_CLASH for the first clash in `outputs`. */
export function assertNoOutputClashes(outputs: Iterable<OutputRef>): void {
  const [clash] = findOutputClashes(outputs);
  if (clash) throw outputClashError(clash);
}

function describeItem(item: unknown): string {
  if (typeof item === 'object' && item !== null) {
    const fields = item as Record<string, unknown>;
    const label = fields['slug'] ?? fields['name'];
    return label === undefined || label === null ? 'with no slug or name' : JSON.stringify(String(label).slice(0, 60));
  }
  return JSON.stringify(String(item).slice(0, 60));
}
