/**
 * Adopt planner — pure classification of an existing user vault against a
 * downloaded shard.
 *
 * Sibling of `install-planner.ts`. Where install builds an output plan from
 * a clean target, adopt walks the same rendered/copied outputs and asks of
 * each one: "what does the user already have here?" — producing three
 * buckets (`matches`, `differs`, `shardOnly`) that the UI surfaces as
 * auto-adopt vs. per-file diff vs. fresh install. Paths in the user's
 * vault but not in the shard ("user-only") are silently left untouched
 * and never enter the planner's output: classification is shard-source-
 * driven, never recursive over cwd.
 *
 * This module is pure: it reads the shard tempdir + the user's vault but
 * never writes. Disk mutations live in `adopt-executor.ts`.
 *
 * Spec: `docs/SHARD-LAYOUT.md §Adopt semantics`. Phase 3 (classify) of the
 * adopt flow runs after the wizard collects values, so every render here
 * uses the user's chosen values just like a real install would.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  FileEntry,
  RenderedFile,
  ShardManifest,
  ShardSchema,
  ModuleSelections,
} from '../runtime/types.js';
import { ShardMindError } from '../runtime/types.js';
import { errnoCode, isEnoent } from '../runtime/errno.js';
import { resolveModules } from './modules.js';
import { assertSafeVaultPaths } from './vault-path-guard.js';
import { isFree } from './rename-migrations.js';
import {
  buildRenderContext,
  createRenderer,
  renderFile,
} from './renderer.js';
import { assertNoOutputClashes, plannedOutputRefs } from './output-clash.js';
import { isBinaryForMerge, mapConcurrent, sha256, toPosix } from './fs-utils.js';

/**
 * Cap on parallel `readFile` operations during user-vault hashing. Same
 * budget `drift.ts` uses for the symmetric concurrent-read fan-out — a
 * vault with thousands of files would otherwise saturate macOS's 256-fd
 * default and crash with EMFILE.
 */
const ADOPT_READ_CONCURRENCY = 32;

/**
 * One classified shard output. `kind` is the dispatch tag the UI + executor
 * branch on. `templateKey` (vault-relative POSIX path of the source file)
 * is the merge-base pointer that lands in `state.files[<path>].template`
 * after adopt — same shape `install-executor.ts` writes for managed files.
 *
 * For `differs`, both `shardContent`/`shardHash` (what the rendered or
 * copied output would have produced) and `userContent`/`userHash` (what
 * the user's bytes currently hash to) are populated. The 2-way diff UI
 * needs both; the executor needs `userHash` for the keep-mine branch and
 * `shardContent`/`shardHash` for the use-shard branch.
 */
export type AdoptClassification =
  | {
      kind: 'matches';
      path: string;
      templateKey: string;
      shardHash: string;
      iteratorKey?: string;
      volatile: boolean;
      /** The old path the user's file sits at, under a rename migration (#179). */
      movedFrom?: string;
    }
  | {
      kind: 'differs';
      path: string;
      templateKey: string;
      shardContent: Buffer;
      shardHash: string;
      userContent: Buffer;
      userHash: string;
      isBinary: boolean;
      iteratorKey?: string;
      volatile: boolean;
      /** The old path the user's file sits at, under a rename migration (#179). */
      movedFrom?: string;
    }
  | {
      kind: 'shard-only';
      path: string;
      templateKey: string;
      shardContent: Buffer;
      shardHash: string;
      iteratorKey?: string;
      volatile: boolean;
    };

/** The old path a classification's file moves from (#179), if any. */
export function movedFromOf(c: AdoptClassification): string | undefined {
  return c.kind === 'shard-only' ? undefined : c.movedFrom;
}

/**
 * Output of adopt classification. Three buckets, no `userOnly` field —
 * adopt deliberately never enumerates the user's tree. Classification is
 * shard-source-driven: only paths the shard would have produced get
 * stat'd against the vault, so symlinks under the user's vault are never
 * followed and Tier 1 entries (`.git/`, `.obsidian/workspace.json`) are
 * never enumerated. The user-facing summary's "user files left
 * untouched" line is implicit (everything outside `state.files` is
 * unmanaged), not a planner-emitted list.
 */
export interface AdoptPlan {
  matches: AdoptClassification[];
  differs: AdoptClassification[];
  shardOnly: AdoptClassification[];
  /** Total file count the planner would have written under a clean install. */
  totalShardFiles: number;
}

export interface AdoptPlannerInput {
  vaultRoot: string;
  schema: ShardSchema;
  manifest: ShardManifest;
  /** Extracted shard tempdir. */
  tempDir: string;
  /** User's wizard answers; required because `.njk` templates render against them. */
  values: Record<string, unknown>;
  selections: ModuleSelections;
  /**
   * Override for `buildRenderContext`'s clock. Tests pin `install_date`
   * + `year` so `RenderContext`-based renders are deterministic across
   * runs. Production code lets it default to `new Date()`.
   */
  now?: Date;
  /**
   * Rename migrations from the release the vault was cloned from to the
   * shard's version, old path → new path (`adopt --from-version`, #179).
   */
  renames?: ReadonlyMap<string, string>;
}

/**
 * Render every shard output, hash, and compare against the user's vault.
 *
 * Walks the shard via `resolveModules` (Tier 1 + `.shardmindignore` +
 * symlink rejection apply transparently) and processes each `render` /
 * `copy` entry. Excluded modules go to the `skip` bucket and are dropped
 * here too — adopt mirrors install's "module excluded → file not
 * installed" rule, so user content at those paths stays user-content.
 *
 * Read fan-out is capped via `mapConcurrent` to keep file-descriptor
 * pressure bounded under realistic vault sizes (drift.ts uses the same
 * budget).
 */
export async function classifyAdoption(input: AdoptPlannerInput): Promise<AdoptPlan> {
  const { vaultRoot, schema, manifest, tempDir, values, selections, now, renames } = input;

  const resolution = await resolveModules(schema, selections, tempDir);
  // Two outputs naming one vault path are refused before rendering or any
  // write (#240).
  assertNoOutputClashes(plannedOutputRefs(resolution, values, tempDir));
  const env = createRenderer(tempDir);
  const renderContext = buildRenderContext(manifest, values, selections, now, vaultRoot);

  // `renderFile` reads the source file then runs Nunjucks; `buildItemFromCopy`
  // reads the source file. Both are independent across entries — fan out to
  // bounded concurrency so a shard with hundreds of files doesn't serialize
  // on per-entry I/O. Same budget the user-side classification uses.
  const renderedGroups = await mapConcurrent(
    resolution.render,
    ADOPT_READ_CONCURRENCY,
    async (entry) => {
      const rendered = await renderFile(entry, renderContext, env);
      const outputs = Array.isArray(rendered) ? rendered : [rendered];
      return outputs.map((file) => buildItemFromRender(entry, file, tempDir));
    },
  );
  const copyItems = await mapConcurrent(
    resolution.copy,
    ADOPT_READ_CONCURRENCY,
    (entry) => buildItemFromCopy(entry, tempDir),
  );

  const items: ShardOutputItem[] = [...renderedGroups.flat(), ...copyItems];
  const movable = renames?.size
    ? movableRenames(renames, new Set(items.map((i) => i.outputPath)))
    : new Map<string, string>();

  const classifications = await mapConcurrent(items, ADOPT_READ_CONCURRENCY, async (item) => {
    return classifyOne(vaultRoot, item, movable.get(item.outputPath));
  });

  const matches: AdoptClassification[] = [];
  const differs: AdoptClassification[] = [];
  const shardOnly: AdoptClassification[] = [];

  for (const c of classifications) {
    if (c.kind === 'matches') matches.push(c);
    else if (c.kind === 'differs') differs.push(c);
    else shardOnly.push(c);
  }

  // Refuse before any prompt or `--json` plan (#163); the executor checks
  // again before it writes.
  // A moved file's old path is checked as a write: moving a symlink or a
  // hard-linked file would put the link at a managed path (#179).
  await assertSafeVaultPaths(vaultRoot, [
    ...classifications.map((c) => c.path),
    ...classifications.flatMap((c) => movedFromOf(c) ?? []),
  ]);

  return {
    matches,
    differs,
    shardOnly,
    totalShardFiles: items.length,
  };
}

/**
 * The renames adopt may follow, new path → old path: the new path is a shard
 * output, the old one is not, and no other rename claims the new path.
 */
function movableRenames(
  renames: ReadonlyMap<string, string>,
  outputs: ReadonlySet<string>,
): Map<string, string> {
  const movable = new Map<string, string>();
  const claimedTwice = new Set<string>();
  for (const [from, to] of renames) {
    if (!outputs.has(to) || outputs.has(from)) continue;
    if (movable.has(to)) claimedTwice.add(to);
    movable.set(to, from);
  }
  for (const to of claimedTwice) movable.delete(to);
  return movable;
}

/** The user's bytes at `rel`, or null when nothing is there. */
async function readUserFile(vaultRoot: string, rel: string): Promise<Buffer | null> {
  const userPath = path.join(vaultRoot, rel);
  try {
    return await fsp.readFile(userPath);
  } catch (err) {
    // Nothing there. A path under a regular file is ENOTDIR on POSIX and
    // ENOENT on Windows: both mean no file, so the platforms agree.
    if (isEnoent(err) || errnoCode(err) === 'ENOTDIR') return null;
    throw new ShardMindError(
      `Could not read user vault file: ${userPath}`,
      'COLLISION_CHECK_FAILED',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * The user's bytes at a rename's old path, or null when no file is there: a
 * folder, or a path under a file, is no file to move (#179).
 */
async function readOldPath(vaultRoot: string, rel: string): Promise<Buffer | null> {
  const abs = path.join(vaultRoot, rel);
  const st = await fsp.lstat(abs).catch((err: unknown) => {
    const code = errnoCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new ShardMindError(
      `Could not read user vault file: ${abs}`,
      'COLLISION_CHECK_FAILED',
      err instanceof Error ? err.message : String(err),
    );
  });
  if (st === null || st.isDirectory()) return null;
  // A link is never moved: refused as the guard refuses any linked path.
  if (st.isSymbolicLink()) await assertSafeVaultPaths(vaultRoot, [rel]);
  return readUserFile(vaultRoot, rel);
}

interface ShardOutputItem {
  outputPath: string;
  templateKey: string;
  shardContent: Buffer;
  shardHash: string;
  iteratorKey: string | undefined;
  volatile: boolean;
}

function buildItemFromRender(
  entry: FileEntry,
  file: RenderedFile,
  tempDir: string,
): ShardOutputItem {
  const buf = Buffer.from(file.content, 'utf-8');
  return {
    outputPath: file.outputPath,
    templateKey: toPosix(tempDir, entry.sourcePath),
    shardContent: buf,
    shardHash: file.hash,
    iteratorKey: entry.iterator ?? undefined,
    volatile: file.volatile,
  };
}

async function buildItemFromCopy(
  entry: FileEntry,
  tempDir: string,
): Promise<ShardOutputItem> {
  const buf = await fsp.readFile(entry.sourcePath);
  return {
    outputPath: entry.outputPath,
    templateKey: toPosix(tempDir, entry.sourcePath),
    shardContent: buf,
    shardHash: sha256(buf),
    iteratorKey: undefined,
    volatile: false,
  };
}

async function classifyOne(
  vaultRoot: string,
  item: ShardOutputItem,
  renamedFrom: string | undefined,
): Promise<AdoptClassification> {
  let userBuf = await readUserFile(vaultRoot, item.outputPath);
  // A file cloned from an older release sits at the rename's old path; it is
  // compared here and moved by the executor (#179). The new path must be free
  // of anything, a dangling link or a file where a folder goes included.
  let movedFrom: string | undefined;
  if (userBuf === null && renamedFrom !== undefined && (await isFree(vaultRoot, item.outputPath))) {
    userBuf = await readOldPath(vaultRoot, renamedFrom);
    if (userBuf !== null) movedFrom = renamedFrom;
  }
  if (userBuf === null) {
    return {
      kind: 'shard-only',
      path: item.outputPath,
      templateKey: item.templateKey,
      shardContent: item.shardContent,
      shardHash: item.shardHash,
      ...(item.iteratorKey ? { iteratorKey: item.iteratorKey } : {}),
      volatile: item.volatile,
    };
  }
  const moved = movedFrom !== undefined ? { movedFrom } : {};

  // Volatile templates skip the differs prompt: their rendered output is
  // expected to vary across renders (timestamps, randomized order, etc.),
  // so a content prompt is meaningless. Treat as `matches` whenever the
  // file exists at all — the user's bytes are accepted as-is and recorded
  // as managed at the user's hash. Symmetric with how the install pipeline
  // writes volatile-marker outputs (managed ownership, hash-of-rendered).
  if (item.volatile) {
    return {
      kind: 'matches',
      path: item.outputPath,
      templateKey: item.templateKey,
      shardHash: sha256(userBuf),
      ...(item.iteratorKey ? { iteratorKey: item.iteratorKey } : {}),
      volatile: true,
      ...moved,
    };
  }

  const userHash = sha256(userBuf);
  if (userHash === item.shardHash) {
    return {
      kind: 'matches',
      path: item.outputPath,
      templateKey: item.templateKey,
      shardHash: item.shardHash,
      ...(item.iteratorKey ? { iteratorKey: item.iteratorKey } : {}),
      volatile: false,
      ...moved,
    };
  }

  return {
    kind: 'differs',
    path: item.outputPath,
    templateKey: item.templateKey,
    shardContent: item.shardContent,
    shardHash: item.shardHash,
    userContent: userBuf,
    userHash,
    isBinary: isBinaryForMerge(userBuf) || isBinaryForMerge(item.shardContent),
    ...(item.iteratorKey ? { iteratorKey: item.iteratorKey } : {}),
    volatile: false,
    ...moved,
  };
}

