import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  ShardSchema,
  ModuleResolution,
  FileEntry,
  ModuleSelections,
} from '../runtime/types.js';
import { ShardMindError } from '../runtime/types.js';
import { isTier1Excluded } from './tier1.js';
import { loadShardmindignore, type IgnoreFilter } from './shardmindignore.js';

const VOLATILE_MARKER = '{# shardmind: volatile #}';

/**
 * Walk a shard source tree and classify every file into render / copy / skip.
 *
 * v6 contract: a single shard-root walk replaces the v5 four-tree pattern
 * (`templates/`, `commands/`, `agents/`, always-copy + `codex/`). Files live
 * at their final installed paths in source. The walker:
 *
 *  - applies Tier 1 exclusions (`tier1.ts`)
 *  - applies the root-level `.shardmindignore` (`shardmindignore.ts`)
 *  - rejects symlinks anywhere (security baseline — an untrusted shard
 *    could symlink outside the install target)
 *  - classifies each file: dotfolder `.njk` → render; everything else → copy
 *  - gates by module via `mod.paths` prefix, `mod.bases` exact match, or the
 *    per-name `mod.commands` / `mod.agents` heuristic (parent dir is
 *    `commands` / `agents`, basename-no-ext in the list)
 *
 * Spec: `docs/SHARD-LAYOUT.md §Engine change scope §Walk + discovery`.
 */
export async function resolveModules(
  schema: ShardSchema,
  selections: ModuleSelections,
  rootDir: string,
): Promise<ModuleResolution> {
  const ignoreFilter = await loadShardmindignore(rootDir);
  const files = await walkShardSource(rootDir, ignoreFilter);

  const render: FileEntry[] = [];
  const copy: FileEntry[] = [];
  const skip: FileEntry[] = [];

  for (const { relPath, absPath } of files) {
    const moduleId = classifyModule(relPath, schema);
    const isExcluded = moduleId !== null && selections[moduleId] === 'excluded';
    const isRender = isRenderable(relPath);
    const outputPath = isRender ? stripNjk(relPath) : relPath;

    if (isExcluded) {
      skip.push({ sourcePath: absPath, outputPath, module: moduleId, volatile: false, iterator: null });
      continue;
    }

    if (isRender) {
      const volatile = await detectVolatile(absPath);
      const iterator = extractIterator(relPath);
      render.push({ sourcePath: absPath, outputPath, module: moduleId, volatile, iterator });
    } else {
      copy.push({ sourcePath: absPath, outputPath, module: moduleId, volatile: false, iterator: null });
    }
  }

  return { render, copy, skip };
}

export interface WalkedFile {
  relPath: string;
  absPath: string;
}

/**
 * Recursively walk `rootDir`, returning every regular-file entry that survives
 * Tier 1 exclusion + `.shardmindignore` filtering + symlink rejection. Shared
 * by `resolveModules` (install/update planning) and `state.ts:cacheTemplates`
 * (merge-base cache) so both layers honor the exact same source-side filter.
 */
export async function walkShardSource(
  rootDir: string,
  ignoreFilter: IgnoreFilter,
): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  await walk(rootDir, '', ignoreFilter, out);
  return out;
}

async function walk(
  rootAbs: string,
  relDir: string,
  ignoreFilter: IgnoreFilter,
  out: WalkedFile[],
): Promise<void> {
  const dirAbs = relDir === '' ? rootAbs : path.join(rootAbs, relDir);
  const entries = await fsp.readdir(dirAbs, { withFileTypes: true });

  for (const entry of entries) {
    const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
    const entryAbs = path.join(dirAbs, entry.name);

    if (entry.isSymbolicLink()) {
      throw new ShardMindError(
        `Shard source contains a symbolic link: ${relPath}`,
        'WALK_SYMLINK_REJECTED',
        'Symlinks are rejected during install — an untrusted shard could symlink outside the install target. Replace the symlink with a regular file or directory.',
      );
    }

    const isDir = entry.isDirectory();
    const isFile = entry.isFile();

    if (!isDir && !isFile) {
      throw new ShardMindError(
        `Shard source contains an unsupported entry type: ${relPath}`,
        'WALK_INVALID_ENTRY',
        'Only regular files and directories are allowed in a shard source tree.',
      );
    }

    if (isTier1Excluded(relPath)) continue;
    if (ignoreFilter.ignores(relPath, isDir)) continue;

    if (isDir) {
      await walk(rootAbs, relPath, ignoreFilter, out);
    } else {
      out.push({ relPath, absPath: entryAbs });
    }
  }
}

function isRenderable(relPath: string): boolean {
  // `.njk` suffix is the author-explicit opt-in to Nunjucks rendering, the
  // same mechanism v5 used. Spec defers `rendered_files` (rendering without
  // `.njk` suffix at vault-visible paths) to v0.2 (#86); the engine here
  // doesn't restrict by path, since iterator templates and any author-tagged
  // `.njk` may legitimately produce vault-visible output.
  return relPath.endsWith('.njk');
}

function stripNjk(relPath: string): string {
  return relPath.endsWith('.njk') ? relPath.slice(0, -4) : relPath;
}

function classifyModule(relPath: string, schema: ShardSchema): string | null {
  for (const [moduleId, mod] of Object.entries(schema.modules)) {
    for (const modPath of mod.paths) {
      if (relPath === modPath || relPath.startsWith(modPath)) {
        return moduleId;
      }
    }
    if (mod.bases) {
      for (const baseId of mod.bases) {
        if (relPath === `bases/${baseId}.base.njk`) {
          return moduleId;
        }
      }
    }
  }
  // Per-name `commands` / `agents` matching (parent dir + basename-no-ext).
  // Path-prefix match takes precedence; this only fires when no `mod.paths`
  // claimed the file — keeps the spec rule "agent selection is modeled as
  // module gating" working without hardcoding `.claude/`/`.codex/`/etc.
  const segments = relPath.split('/');
  if (segments.length >= 2) {
    const parent = segments[segments.length - 2]!.toLowerCase();
    const fileName = segments[segments.length - 1]!;
    const baseNoExt = fileName.replace(/\.[^./]+$/, '');
    const resourceType = parent === 'commands' ? 'commands' : parent === 'agents' ? 'agents' : null;
    if (resourceType !== null) {
      for (const [moduleId, mod] of Object.entries(schema.modules)) {
        const list = mod[resourceType];
        if (list && list.includes(baseNoExt)) {
          return moduleId;
        }
      }
    }
  }
  return null;
}

function extractIterator(relPath: string): string | null {
  const basename = path.basename(relPath, '.njk');
  if (!basename.startsWith('_each')) return null;
  const dir = path.dirname(relPath);
  if (dir === '.') return null;
  return path.basename(dir);
}

async function detectVolatile(filePath: string): Promise<boolean> {
  const handle = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(256);
    const { bytesRead } = await handle.read(buf, 0, 256, 0);
    const content = buf.toString('utf-8', 0, bytesRead);
    return content.trimStart().startsWith(VOLATILE_MARKER);
  } finally {
    await handle.close();
  }
}
