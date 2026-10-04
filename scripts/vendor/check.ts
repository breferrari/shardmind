/**
 * `npm run vendor:check [--summary <file>]` (#280).
 *
 * For every `source/*-kit/VENDOR.json`: is npm's latest newer than the
 * vendored version, and does each file's recorded `modified` match its bytes
 * (header aside) against upstream at the recorded commit? It reports and
 * always exits 0; `--summary` also writes the report as Markdown, which the
 * weekly workflow appends to its job summary. See IMPLEMENTATION §4.27.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readRecord, stripHeader, RECORD_FILE } from './record.js';
import { networkSource, type UpstreamSource } from './upstream.js';

export interface KitStatus {
  kit: string;
  package: string;
  version: string;
  latest: string;
  behind: boolean;
  /** Files whose recorded `modified` disagrees with their bytes. */
  wrongModified: string[];
}

export type KitReport = KitStatus | { kit: string; error: string };

/** The kits under `source/` that carry a record. */
async function kitDirs(root: string): Promise<string[]> {
  const sourceDir = path.join(root, 'source');
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true });
  const dirs: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.endsWith('-kit')) continue;
    const dir = path.join(sourceDir, e.name);
    if (await fsp.access(path.join(dir, RECORD_FILE)).then(() => true, () => false)) dirs.push(dir);
  }
  return dirs.sort();
}

async function checkKit(kitDir: string, source: UpstreamSource): Promise<KitStatus> {
  const record = await readRecord(kitDir);
  const latest = await source.latestVersion(record.package);
  const tree = await source.checkout(record.repository, record.commit);
  try {
    const wrongModified: string[] = [];
    for (const [file, entry] of Object.entries(record.files).sort(([a], [b]) => a.localeCompare(b))) {
      const ours = stripHeader(await fsp.readFile(path.join(kitDir, file), 'utf-8'), record, file);
      const upstream = await fsp.readFile(path.join(tree.root, record.sourceRoot, entry.upstream), 'utf-8').catch(() => null);
      if ((ours !== upstream) !== entry.modified) wrongModified.push(file);
    }
    return {
      kit: record.kit,
      package: record.package,
      version: record.version,
      latest,
      behind: latest !== record.version,
      wrongModified,
    };
  } finally {
    await tree.cleanup();
  }
}

export async function checkKits(opts: { root: string; source?: UpstreamSource }): Promise<KitStatus[]> {
  const source = opts.source ?? networkSource;
  const out: KitStatus[] = [];
  for (const dir of await kitDirs(opts.root)) out.push(await checkKit(dir, source));
  return out;
}

export function formatReport(reports: readonly KitReport[]): string {
  if (reports.length === 0) return '## Vendored kits\n\nNo `source/*-kit/VENDOR.json` found.\n';
  const lines = ['## Vendored kits', ''];
  for (const r of reports) {
    if ('error' in r) {
      lines.push(`- **${r.kit}**: could not check: ${r.error}`);
      continue;
    }
    lines.push(
      r.behind
        ? `- **${r.kit}**: ${r.package} ${r.version} → ${r.latest} available. Run \`npm run vendor:update -- ${r.kit} ${r.latest}\`.`
        : `- **${r.kit}**: ${r.package} ${r.version}, up to date.`,
    );
    if (r.wrongModified.length > 0) {
      lines.push(`  - VENDOR.json's \`modified\` is wrong for: ${r.wrongModified.join(', ')}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** The command. Always 0: a kit behind its upstream is news, not a failure. */
export async function main(
  argv: string[],
  opts: { root?: string; source?: UpstreamSource } = {},
): Promise<number> {
  const root = opts.root ?? process.cwd();
  const source = opts.source ?? networkSource;
  const reports: KitReport[] = [];
  for (const dir of await kitDirs(root)) {
    try {
      reports.push(await checkKit(dir, source));
    } catch (err) {
      reports.push({ kit: path.basename(dir), error: err instanceof Error ? err.message : String(err) });
    }
  }
  const report = formatReport(reports);
  console.log(report);
  const at = argv.indexOf('--summary');
  if (at >= 0 && argv[at + 1]) await fsp.appendFile(argv[at + 1]!, report, 'utf-8');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      // Even an unexpected failure is reported, not fatal: this runs on a schedule.
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(0);
    },
  );
}
