/**
 * `npm run vendor:update <kit> <version> [--commit]` (#280).
 *
 * Brings a new upstream version into a vendored kit, file by file, with
 * ShardMind's own three-way merge (`source/core/differ.ts`): base = upstream
 * at the recorded commit, theirs = our file (its header aside), new = upstream
 * at the new version's tag. The record advances only when no file conflicted.
 * See IMPLEMENTATION §4.27.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { threeWayMerge } from '../../source/core/differ.js';
import { headerFor, readRecord, stripHeader, tagFor, writeRecord, type VendorRecord } from './record.js';
import { networkSource, type UpstreamSource } from './upstream.js';

export interface UpdateConflict {
  file: string;
  reason: 'conflicting changes' | 'removed upstream';
}

export interface UpdateResult {
  /** Unmodified files that took the new upstream as-is. */
  updated: string[];
  /** Modified files whose changes merged cleanly into the new upstream. */
  merged: string[];
  /** Files left for a person: written with markers, or untouched when removed upstream. */
  conflicts: UpdateConflict[];
  /** Upstream files the new version adds (under `sourceRoot`), listed, never added. */
  addedUpstream: string[];
}

export interface UpdateOptions {
  kitDir: string;
  version: string;
  source?: UpstreamSource;
  /** Make two commits (upstream as-is, then ShardMind's changes), as `Name <email>`. */
  commit?: { author: string };
}

/** Every file under `dir`, POSIX, sorted; none when `dir` is missing. */
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string) => {
    let entries;
    try {
      entries = await fsp.readdir(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(child);
      else out.push(child);
    }
  };
  await walk('');
  return out.sort();
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await fsp.readFile(file, 'utf-8');
  } catch {
    return null;
  }
}

/** The engine's markers, named for this merge: ours is ShardMind's, the other side is upstream. */
function relabel(content: string, record: VendorRecord, version: string): string {
  return content
    .replace(/^<<<<<<< yours$/gm, '<<<<<<< shardmind')
    .replace(/^>>>>>>> shard update$/gm, `>>>>>>> ${record.package}@${version}`);
}

export async function updateKit(opts: UpdateOptions): Promise<UpdateResult> {
  const source = opts.source ?? networkSource;
  const record = await readRecord(opts.kitDir);
  const files = Object.keys(record.files).sort();

  // Every header is checked before anything is written.
  const ours = new Map<string, string>();
  for (const file of files) {
    ours.set(file, stripHeader(await fsp.readFile(path.join(opts.kitDir, file), 'utf-8'), record, file));
  }

  const tag = tagFor(record, opts.version);
  const commit = await source.commitForTag(record.repository, tag);
  const tarball = await source.versionInfo(record.package, opts.version);
  const oldTree = await source.checkout(record.repository, record.commit);
  const newTree = await source.checkout(record.repository, commit);
  try {
    const oldRoot = path.join(oldTree.root, record.sourceRoot);
    const newRoot = path.join(newTree.root, record.sourceRoot);
    const next: VendorRecord = { ...record, version: opts.version, tag, commit, tarball, files: { ...record.files } };
    const result: UpdateResult = { updated: [], merged: [], conflicts: [], addedUpstream: [] };
    const asIs = new Map<string, string>();
    const final = new Map<string, string>();

    for (const file of files) {
      const entry = record.files[file]!;
      const base = await readOptional(path.join(oldRoot, entry.upstream));
      const incoming = await readOptional(path.join(newRoot, entry.upstream));
      const mine = ours.get(file)!;
      if (incoming === null) {
        result.conflicts.push({ file, reason: 'removed upstream' });
        continue;
      }
      if (base === null) throw new Error(`${record.kit}/${file}: ${entry.upstream} is missing at the recorded commit`);
      asIs.set(file, incoming);
      if (mine === base) {
        final.set(file, incoming);
        next.files[file] = { upstream: entry.upstream, modified: false };
        result.updated.push(file);
        continue;
      }
      const merge = threeWayMerge(base, mine, incoming);
      final.set(file, relabel(merge.content, record, opts.version));
      if (merge.conflicts.length > 0) {
        result.conflicts.push({ file, reason: 'conflicting changes' });
        continue;
      }
      next.files[file] =
        merge.content === incoming
          ? { upstream: entry.upstream, modified: false }
          : { upstream: entry.upstream, modified: true, change: entry.change ?? 'kept from the previous version.' };
      result.merged.push(file);
    }

    const before = new Set(await filesUnder(oldRoot));
    result.addedUpstream = (await filesUnder(newRoot)).filter((f) => !before.has(f));
    result.conflicts.sort((a, b) => a.file.localeCompare(b.file));

    const write = async (content: Map<string, string>, rec: VendorRecord) => {
      for (const [file, text] of content) await fsp.writeFile(path.join(opts.kitDir, file), headerFor(rec, file) + text);
    };

    if (result.conflicts.length > 0) {
      // Left for a person: the merges, markers included, under the new
      // version's header; the record stays at the version it describes.
      await write(final, { ...next, files: { ...record.files, ...next.files } });
      return result;
    }

    if (opts.commit) {
      const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: opts.kitDir, encoding: 'utf-8' }).trim();
      const author = /^(.*) <(.*)>$/.exec(opts.commit.author);
      if (!author) throw new Error(`--commit needs an author as "Name <email>", not ${opts.commit.author}`);
      const git = (...args: string[]) =>
        execFileSync('git', ['-c', `user.name=${author[1]}`, '-c', `user.email=${author[2]}`, ...args], { cwd: repo, stdio: 'pipe' });
      const plain: VendorRecord = {
        ...next,
        files: Object.fromEntries(files.map((f) => [f, { upstream: record.files[f]!.upstream, modified: false }])),
      };
      await write(asIs, plain);
      await writeRecord(opts.kitDir, plain);
      git('add', '-A', '--', opts.kitDir);
      git('commit', '-q', '-m', `chore: vendor ${record.package}@${opts.version} as-is into ${record.kit}`);
      await write(final, next);
      await writeRecord(opts.kitDir, next);
      git('add', '-A', '--', opts.kitDir);
      git('commit', '-q', '-m', `chore: re-apply ShardMind's changes to ${record.kit}`);
      return result;
    }

    await write(final, next);
    await writeRecord(opts.kitDir, next);
    return result;
  } finally {
    await oldTree.cleanup();
    await newTree.cleanup();
  }
}

/** The command: `vendor:update <kit> <version> [--commit "Name <email>"]`. */
export async function main(argv: string[], root = process.cwd()): Promise<number> {
  const args = argv.filter((a) => a !== '--commit');
  const commitAt = argv.indexOf('--commit');
  const [kit, version] = args;
  if (!kit || !version) {
    console.error('usage: npm run vendor:update -- <kit> <version> [--commit "Name <email>"]');
    return 2;
  }
  const author = commitAt >= 0 ? argv[commitAt + 1] : undefined;
  const result = await updateKit({
    kitDir: path.join(root, 'source', kit),
    version,
    commit: author ? { author } : undefined,
  });
  for (const f of result.updated) console.log(`updated   ${f}`);
  for (const f of result.merged) console.log(`merged    ${f}`);
  for (const c of result.conflicts) console.log(`CONFLICT  ${c.file} (${c.reason})`);
  for (const f of result.addedUpstream) console.log(`new upstream file, not vendored: ${f}`);
  if (result.conflicts.length > 0) {
    console.log(`\n${result.conflicts.length} file(s) need a person; VENDOR.json was not advanced.`);
    return 1;
  }
  console.log(`\n${kit} is at ${version}.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
