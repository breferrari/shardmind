/**
 * `npm run vendor:update <kit> <version> [--commit]` (#280).
 *
 * Brings a new upstream version into a vendored kit, file by file, with
 * ShardMind's own three-way merge (`source/core/differ.ts`): base = upstream
 * at the recorded commit, theirs = our file (its header aside), new = upstream
 * at the new version's tag. The record advances only when no file conflicted.
 * See IMPLEMENTATION §4.27.
 */

import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { threeWayMerge } from '../../source/core/differ.js';
import { isEnoent } from '../../source/runtime/errno.js';
import { headerFor, readKitFile, readRecord, stripHeader, tagFor, toLf, writeRecord, type VendorRecord } from './record.js';
import { networkSource, type UpstreamSource } from './upstream.js';

/** What a conflicted run left for a person, so `--resolved` can check it was finished. */
export const PENDING_FILE = 'VENDOR.pending.json';

interface Pending {
  version: string;
  /** The recorded commit the run merged from. */
  from: string;
  /** The commit of the version it merged onto. */
  commit: string;
  /** Each conflicted file and the sha256 of the text written, markers included. */
  conflicted: Record<string, string>;
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

async function readPending(kitDir: string): Promise<Pending | null> {
  try {
    return JSON.parse(await fsp.readFile(path.join(kitDir, PENDING_FILE), 'utf-8')) as Pending;
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

/** A line the merge engine writes to open or close a conflict, whatever its label. */
const MARKER = /^(<{7}|>{7}) /m;

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

/** Every file under `dir`, POSIX, sorted; none when `dir` itself is missing. */
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string) => {
    let entries;
    try {
      entries = await fsp.readdir(path.join(dir, rel), { withFileTypes: true });
    } catch (err) {
      if (rel === '' && isEnoent(err)) return;
      throw err;
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

/** An upstream file as LF text, or null when that version has no such file. */
async function readOptional(file: string): Promise<string | null> {
  try {
    return toLf(await fsp.readFile(file, 'utf-8'));
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

/**
 * Git for `--commit`, refused up front: the author must be `Name <email>`, and
 * the kit and the index must be clean, so the two commits hold the update and
 * nothing else.
 */
function gitFor(kitDir: string, author: string): { git: (...args: string[]) => string; dirty: () => boolean } {
  const who = /^(.+) <([^<>]+)>$/.exec(author);
  if (!who) throw new Error(`--commit needs an author as "Name <email>", not ${JSON.stringify(author)}`);
  const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: kitDir, encoding: 'utf-8' }).trim();
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', `user.name=${who[1]}`, '-c', `user.email=${who[2]}`, ...args], {
      cwd: repo,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  const dirty = () => git('status', '--porcelain', '--', kitDir).trim() !== '';
  if (dirty()) throw new Error(`--commit needs a clean ${path.basename(kitDir)}; commit or stash its changes first`);
  if (git('diff', '--cached', '--name-only').trim() !== '') {
    throw new Error('--commit needs an empty index; commit or unstage what is staged first');
  }
  return { git, dirty };
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
  const pending = await readPending(opts.kitDir);
  if (pending) {
    throw new Error(
      `${record.kit} has an unfinished update to ${pending.version}; resolve its conflicts and run ` +
        `vendor:update -- ${record.kit} ${pending.version} --resolved`,
    );
  }
  const vcs = opts.commit ? gitFor(opts.kitDir, opts.commit.author) : null;

  // Every header is checked before anything is written.
  const ours = new Map<string, string>();
  for (const file of files) {
    ours.set(file, stripHeader(await readKitFile(opts.kitDir, record, file), record, file));
  }

  const tag = tagFor(record, opts.version);
  const commit = await source.commitForTag(record.repository, tag);
  const tarball = await source.versionInfo(record.package, opts.version);
  const trees: Array<{ cleanup: () => Promise<void> }> = [];
  try {
    const oldTree = await source.checkout(record.repository, record.commit);
    trees.push(oldTree);
    const newTree = await source.checkout(record.repository, commit);
    trees.push(newTree);
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
      // Left for a person: the merges, markers included. The record stays at
      // the version it describes, and so do the headers, so vendor:check still
      // reads the kit; once the markers are resolved, `--resolved` finishes it.
      await write(final, record);
      const conflicted: Record<string, string> = {};
      for (const c of result.conflicts) {
        if (c.reason === 'conflicting changes') conflicted[c.file] = hash(headerFor(record, c.file) + final.get(c.file)!);
      }
      const left: Pending = { version: opts.version, from: record.commit, commit, conflicted };
      await fsp.writeFile(path.join(opts.kitDir, PENDING_FILE), `${JSON.stringify(left, null, 2)}\n`, 'utf-8');
      return result;
    }

    if (vcs) {
      const { git, dirty } = vcs;
      const plain: VendorRecord = {
        ...next,
        files: Object.fromEntries(files.map((f) => [f, { upstream: record.files[f]!.upstream, modified: false }])),
      };
      await write(asIs, plain);
      await writeRecord(opts.kitDir, plain);
      git('add', '-A', '--', opts.kitDir);
      git('commit', '-q', '-m', `chore: vendor ${record.package}@${opts.version} as-is into ${record.kit}`, '--', opts.kitDir);
      await write(final, next);
      await writeRecord(opts.kitDir, next);
      // No ShardMind change survived the merge: the as-is commit is the update.
      if (dirty()) {
        git('add', '-A', '--', opts.kitDir);
        git('commit', '-q', '-m', `chore: re-apply ShardMind's changes to ${record.kit}`, '--', opts.kitDir);
      }
      return result;
    }

    await write(final, next);
    await writeRecord(opts.kitDir, next);
    return result;
  } finally {
    for (const tree of trees) await tree.cleanup();
  }
}

/**
 * Finishes an update a person resolved (`--resolved`): each file as it stands
 * is the result, so the record advances to `version` with `modified` measured
 * against the new upstream. A re-run of `updateKit` cannot do this, since a
 * resolution that keeps ShardMind's line conflicts with the old base again.
 *
 * Nothing is written unless the kit is whole: no marker left in any of its
 * files, and every file the conflicted run left is changed since. The record
 * never claims a version over a half-merged kit.
 */
export async function finishKit(opts: { kitDir: string; version: string; source?: UpstreamSource }): Promise<void> {
  const source = opts.source ?? networkSource;
  const record = await readRecord(opts.kitDir);
  const files = Object.keys(record.files).sort();
  const pending = await readPending(opts.kitDir);
  if (!pending) throw new Error(`${record.kit} has no conflicted update to finish (no ${PENDING_FILE})`);
  if (pending.version !== opts.version || pending.from !== record.commit) {
    throw new Error(
      `${record.kit}'s unfinished update is to ${pending.version} from ${pending.from.slice(0, 7)}, ` +
        `not to ${opts.version} from ${record.commit.slice(0, 7)}`,
    );
  }

  const marked: string[] = [];
  for (const file of await filesUnder(opts.kitDir)) {
    if (MARKER.test(toLf(await fsp.readFile(path.join(opts.kitDir, file), 'utf-8')))) marked.push(file);
  }
  if (marked.length > 0) {
    throw new Error(`${record.kit} still holds conflict markers in: ${marked.join(', ')}; resolve them first`);
  }
  const untouched: string[] = [];
  for (const [file, written] of Object.entries(pending.conflicted).sort(([a], [b]) => a.localeCompare(b))) {
    if (!(file in record.files)) continue; // dropped from the kit by the person: nothing to finish
    if (hash(await readKitFile(opts.kitDir, record, file)) === written) untouched.push(file);
  }
  if (untouched.length > 0) {
    throw new Error(`${record.kit}: these conflicted files are unchanged since the update: ${untouched.join(', ')}`);
  }

  const resolved = new Map<string, string>();
  for (const file of files) resolved.set(file, stripHeader(await readKitFile(opts.kitDir, record, file), record, file));

  const tag = tagFor(record, opts.version);
  const commit = pending.commit;
  const tarball = await source.versionInfo(record.package, opts.version);
  const tree = await source.checkout(record.repository, commit);
  try {
    const next: VendorRecord = { ...record, version: opts.version, tag, commit, tarball, files: {} };
    for (const file of files) {
      const entry = record.files[file]!;
      const incoming = await readOptional(path.join(tree.root, record.sourceRoot, entry.upstream));
      if (incoming === null) {
        throw new Error(`${record.kit}/${file}: ${entry.upstream} is gone in ${opts.version}; drop it from the kit and VENDOR.json first`);
      }
      next.files[file] =
        resolved.get(file) === incoming
          ? { upstream: entry.upstream, modified: false }
          : { upstream: entry.upstream, modified: true, change: entry.change ?? 'kept from the previous version.' };
    }
    for (const [file, text] of resolved) await fsp.writeFile(path.join(opts.kitDir, file), headerFor(next, file) + text);
    await writeRecord(opts.kitDir, next);
    await fsp.rm(path.join(opts.kitDir, PENDING_FILE));
  } finally {
    await tree.cleanup();
  }
}

/** The command: `vendor:update <kit> <version> [--commit "Name <email>"] [--resolved]`. */
export async function main(argv: string[], root = process.cwd()): Promise<number> {
  const usage = 'usage: npm run vendor:update -- <kit> <version> [--commit "Name <email>"] [--resolved]';
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { commit: { type: 'string' }, resolved: { type: 'boolean' } },
      allowPositionals: true,
    });
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}\n${usage}`);
    return 2;
  }
  const [kit, version, ...extra] = parsed.positionals;
  if (!kit || !version || extra.length > 0) {
    console.error(usage);
    return 2;
  }
  const author = parsed.values.commit;
  if (parsed.values.resolved) {
    if (author !== undefined) {
      console.error(`--resolved does not commit; commit the kit yourself.\n${usage}`);
      return 2;
    }
    await finishKit({ kitDir: path.join(root, 'source', kit), version });
    console.log(`${kit} is at ${version}.`);
    return 0;
  }
  const result = await updateKit({
    kitDir: path.join(root, 'source', kit),
    version,
    commit: author === undefined ? undefined : { author },
  });
  for (const f of result.updated) console.log(`updated   ${f}`);
  for (const f of result.merged) console.log(`merged    ${f}`);
  for (const c of result.conflicts) console.log(`CONFLICT  ${c.file} (${c.reason})`);
  for (const f of result.addedUpstream) console.log(`new upstream file, not vendored: ${f}`);
  if (result.conflicts.length > 0) {
    console.log(`\n${result.conflicts.length} file(s) need a person; VENDOR.json was not advanced.`);
    console.log(`Resolve them, then run: npm run vendor:update -- ${kit} ${version} --resolved`);
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
