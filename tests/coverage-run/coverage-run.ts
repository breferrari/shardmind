/**
 * What a coverage run (`npm run test:coverage`, #267, #293) changes outside
 * the provider: read by the global setup before any worker starts, by the
 * workers' setup file, and by the spawn helpers' compaction
 * (compact-coverage.ts).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Where each spawned process writes its V8 coverage (`NODE_V8_COVERAGE`). Cleared at the start of a coverage run. */
export const SUBPROCESS_COVERAGE_DIR = path.join(REPO_ROOT, 'coverage', '.subprocess');

/** The URL prefix of the built CLI's files, as V8 coverage names them. */
export const DIST_URL_PREFIX = `${pathToFileURL(path.join(REPO_ROOT, 'dist')).href}/`;

/** Key under which the global setup provides `SUBPROCESS_COVERAGE_DIR` in a coverage run, or null. */
export const SUBPROCESS_COVERAGE_DIR_KEY = 'subprocessCoverageDir';

declare module 'vitest' {
  export interface ProvidedContext {
    subprocessCoverageDir: string | null;
  }
}

/**
 * Empty the subprocess coverage directory, creating it if need be. Called at
 * the start of every coverage run, even one that keeps the last report
 * (`coverage.clean: false`): a file left from an earlier run would be counted
 * in this one.
 */
export async function resetSubprocessCoverageDir(dir: string = SUBPROCESS_COVERAGE_DIR): Promise<void> {
  await fs.promises.rm(dir, { recursive: true, force: true });
  await fs.promises.mkdir(dir, { recursive: true });
}

/** One process's V8 coverage, as `NODE_V8_COVERAGE` writes it. */
export type ProcessCov<Script extends { url: string } = { url: string }> = { result: Script[] };

/**
 * The `dist/` entries of one coverage file, or undefined when it does not
 * parse yet (a process still writing it). Parsing is what tells a complete
 * file from one cut short, so even a file with no `dist/` entry is parsed.
 */
export function readDistEntries<Script extends { url: string }>(
  file: string,
  distPrefix: string = DIST_URL_PREFIX,
): Script[] | undefined {
  try {
    const cov = JSON.parse(fs.readFileSync(file, 'utf-8')) as ProcessCov<Script>;
    return cov.result.filter((script) => script.url.startsWith(distPrefix));
  } catch {
    return undefined;
  }
}
