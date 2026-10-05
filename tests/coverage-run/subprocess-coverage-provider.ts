/**
 * The coverage run's provider class (#293): vitest's v8 provider, plus the
 * code the spawned CLI ran. Loaded only in the main process, through
 * `getProvider` in subprocess-provider.ts, so the workers never load the
 * report stack.
 *
 * The E2E and Layer 2 suites run `dist/cli.js` as a child process, which the
 * v8 provider does not see: it profiles the test workers only. In a coverage
 * run each worker sets `NODE_V8_COVERAGE` for its children
 * (tests/setup/subprocess-coverage.ts), so each spawned CLI (and the hook
 * runner it spawns) writes its own V8 coverage to `SUBPROCESS_COVERAGE_DIR`
 * when it exits. This provider merges the entries for `dist/` across those
 * files, maps each bundle back to `source/` through the sourcemap tsup wrote
 * for the run, adds the result to the workers' map before the reports are
 * written, and removes the directory.
 *
 * A child killed by a signal writes nothing; one that exits, `process.exit`
 * included, does.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { Profiler } from 'node:inspector';
import { V8CoverageProvider } from '@vitest/coverage-v8/dist/provider.js';
import type { ReportContext } from 'vitest/node';
import { readDistEntries, resetSubprocessCoverageDir, SUBPROCESS_COVERAGE_DIR, type ProcessCov } from './coverage-run.js';
import { COMPACTED_PREFIX } from './compact-coverage.js';
import { transferHits, type FileCoverageData } from './transfer-hits.js';

/** istanbul's CoverageMap, as the v8 provider returns it (its typings are not installed). */
type CoverageMap = Awaited<ReturnType<V8CoverageProvider['generateCoverage']>>;
type RemapSource = { code: string; map?: unknown };

// @bcoe/v8-coverage is the merge the v8 provider itself uses (no typings).
const { mergeProcessCovs } = createRequire(import.meta.url)('@bcoe/v8-coverage') as {
  mergeProcessCovs: (covs: Array<ProcessCov<Profiler.ScriptCoverage>>) => ProcessCov<Profiler.ScriptCoverage>;
};

export class SubprocessCoverageProvider extends V8CoverageProvider {
  override async clean(clean = true): Promise<void> {
    await super.clean(clean);
    await resetSubprocessCoverageDir();
  }

  override async generateCoverage(context: ReportContext): Promise<CoverageMap> {
    const coverageMap = await super.generateCoverage(context);
    const merged = readSubprocessCoverage();
    const workerFiles = new Set(coverageMap.files());
    const total = { moved: 0, dropped: 0, unmapped: 0 };
    for (const script of merged.result) {
      const source = readBundle(script.url);
      if (!source) {
        total.unmapped++;
        continue;
      }
      // remapCoverage is private in the typings; it is the conversion the
      // provider runs on the workers' own coverage, ignore rules included.
      const remapped: Record<string, FileCoverageData> = await this['remapCoverage'](script.url, 0, source, script.functions);
      for (const [file, data] of Object.entries(remapped)) {
        // Every included file is in the workers' map (untested ones with zero
        // hits); the hits move onto its items rather than adding a second
        // structure for the same code (transfer-hits.ts).
        if (!workerFiles.has(file)) continue;
        const { moved, dropped } = transferHits(coverageMap.fileCoverageFor(file).data, data);
        total.moved += moved;
        total.dropped += dropped;
      }
    }
    // Said every run: a build without sourcemaps, or no NODE_V8_COVERAGE in
    // the workers, would otherwise drop the spawned CLI without a word.
    this.ctx.logger.log(
      `Subprocess coverage: ${merged.result.length} bundles (${total.unmapped} without a sourcemap, skipped), ` +
        `${total.moved} items with hits added, ${total.dropped} with no match dropped.`,
    );
    // Read once; the next coverage run starts from an empty directory anyway.
    // Kept in watch mode, where a rerun that keeps the last coverage
    // (`cleanOnRerun: false`) reports these processes again.
    if (!this.ctx.config.watch) await fs.promises.rm(SUBPROCESS_COVERAGE_DIR, { recursive: true, force: true });
    return coverageMap;
  }
}

/** Every spawned process's `dist/` entries, merged into one process coverage. */
function readSubprocessCoverage(): ProcessCov<Profiler.ScriptCoverage> {
  let names: string[];
  try {
    names = fs.readdirSync(SUBPROCESS_COVERAGE_DIR);
  } catch {
    return { result: [] };
  }
  const covs: Array<ProcessCov<Profiler.ScriptCoverage>> = [];
  const present = new Set(names);
  for (const name of names) {
    // Compacted or raw (compact-coverage.ts); a `.tmp` mid-rename is skipped,
    // and so is a raw file whose compacted copy exists (its removal failed
    // after the rename): the same process must not count twice.
    if (!name.endsWith('.json')) continue;
    if (!name.startsWith(COMPACTED_PREFIX) && present.has(`${COMPACTED_PREFIX}${name}`)) continue;
    const dist = readDistEntries<Profiler.ScriptCoverage>(path.join(SUBPROCESS_COVERAGE_DIR, name));
    if (dist && dist.length > 0) covs.push({ result: dist });
  }
  return mergeProcessCovs(covs);
}

/** A bundle and its sourcemap, with the map's sources made absolute. */
function readBundle(url: string): RemapSource | undefined {
  const file = fileURLToPath(url);
  let code: string;
  try {
    code = fs.readFileSync(file, 'utf-8');
  } catch {
    return undefined;
  }
  let map: { sources?: Array<string | null> } | undefined;
  try {
    map = JSON.parse(fs.readFileSync(`${file}.map`, 'utf-8')) as { sources?: Array<string | null> };
  } catch {
    return undefined; // built without a sourcemap: cannot be mapped to source/
  }
  // Made absolute in place: a mapping names its source by index, so a null
  // entry keeps its slot.
  map.sources = (map.sources ?? []).map((s) => (s == null ? s : new URL(s, url).href));
  // tsup's banner puts a shebang on the CLI's bundles, which the AST parser
  // rejects; a comment of the same length keeps every offset.
  if (code.startsWith('#!')) code = `//${code.slice(2)}`;
  return { code, map };
}
