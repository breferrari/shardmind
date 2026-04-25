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
import { isEnoent } from '../runtime/errno.js';
import { resolveModules } from './modules.js';
import {
  buildRenderContext,
  createRenderer,
  renderFile,
} from './renderer.js';
import { mapConcurrent, sha256, toPosix } from './fs-utils.js';

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
  const { vaultRoot, schema, manifest, tempDir, values, selections, now } = input;

  const resolution = await resolveModules(schema, selections, tempDir);
  const env = createRenderer(tempDir);
  const renderContext = buildRenderContext(manifest, values, selections, now);

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

  const classifications = await mapConcurrent(items, ADOPT_READ_CONCURRENCY, async (item) => {
    return classifyOne(vaultRoot, item);
  });

  const matches: AdoptClassification[] = [];
  const differs: AdoptClassification[] = [];
  const shardOnly: AdoptClassification[] = [];

  for (const c of classifications) {
    if (c.kind === 'matches') matches.push(c);
    else if (c.kind === 'differs') differs.push(c);
    else shardOnly.push(c);
  }

  return {
    matches,
    differs,
    shardOnly,
    totalShardFiles: items.length,
  };
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
): Promise<AdoptClassification> {
  const userPath = path.join(vaultRoot, item.outputPath);

  let userBuf: Buffer | null;
  try {
    userBuf = await fsp.readFile(userPath);
  } catch (err) {
    if (isEnoent(err)) {
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
    throw new ShardMindError(
      `Could not read user vault file: ${userPath}`,
      'COLLISION_CHECK_FAILED',
      err instanceof Error ? err.message : String(err),
    );
  }

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
    isBinary: looksBinary(userBuf) || looksBinary(item.shardContent),
    ...(item.iteratorKey ? { iteratorKey: item.iteratorKey } : {}),
    volatile: false,
  };
}

/**
 * Heuristic: a NUL byte in the first 8 KB indicates the file is not a
 * text file the diff UI can render usefully. Same convention git's diff
 * uses (the heuristic predates language-aware detection and is still
 * load-bearing in modern git for the "Binary files differ" message).
 *
 * The 8 KB ceiling caps work for huge files; a buffer that is text for
 * 8 KB and then suddenly contains binary is exotic enough that a wrong
 * answer here just means a noisy 2-way diff, not a correctness issue.
 */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}
