import fs from 'node:fs/promises';
import path from 'node:path';
import type { ShardSchema, ModuleResolution, FileEntry, ModuleSelections } from '../runtime/types.js';
import { SHARD_TEMPLATES_DIR } from '../runtime/vault-paths.js';

const VOLATILE_MARKER = '{# shardmind: volatile #}';

// Directories that are always copied (not module-gated)
const ALWAYS_COPY_DIRS = ['scripts', 'utilities', 'skills'] as const;

export async function resolveModules(
  schema: ShardSchema,
  selections: ModuleSelections,
  tempDir: string,
): Promise<ModuleResolution> {
  const render: FileEntry[] = [];
  const copy: FileEntry[] = [];
  const skip: FileEntry[] = [];

  // 1. Walk templates/ directory
  const templatesDir = path.join(tempDir, SHARD_TEMPLATES_DIR);
  if (await dirExists(templatesDir)) {
    const files = await walkDir(templatesDir);
    for (const absPath of files) {
      const relPath = path.relative(templatesDir, absPath).replace(/\\/g, '/');
      const moduleId = findModule(relPath, schema);
      const isExcluded = moduleId !== null && selections[moduleId] === 'excluded';

      if (isExcluded) {
        skip.push({ sourcePath: absPath, outputPath: computeTemplateOutput(relPath), module: moduleId, volatile: false, iterator: null });
        continue;
      }

      if (relPath.endsWith('.njk')) {
        const volatile = await detectVolatile(absPath);
        const iterator = extractIterator(relPath);
        const outputPath = computeTemplateOutput(relPath);
        render.push({ sourcePath: absPath, outputPath, module: moduleId, volatile, iterator });
      } else {
        copy.push({ sourcePath: absPath, outputPath: relPath, module: moduleId, volatile: false, iterator: null });
      }
    }
  }

  // 2. Walk commands/ and agents/ (module-gated)
  for (const dir of ['commands', 'agents'] as const) {
    const dirPath = path.join(tempDir, dir);
    if (!await dirExists(dirPath)) continue;

    const files = await walkDir(dirPath);
    for (const absPath of files) {
      const relPath = path.relative(dirPath, absPath).replace(/\\/g, '/');
      const fileName = path.basename(relPath, path.extname(relPath));
      const moduleId = findModuleForResource(fileName, dir, schema);
      const isExcluded = moduleId !== null && selections[moduleId] === 'excluded';
      const outputPath = `.claude/${dir}/${relPath}`;

      if (isExcluded) {
        skip.push({ sourcePath: absPath, outputPath, module: moduleId, volatile: false, iterator: null });
      } else {
        copy.push({ sourcePath: absPath, outputPath, module: moduleId, volatile: false, iterator: null });
      }
    }
  }

  // 3. Walk scripts/, utilities/, skills/ (always copied)
  for (const dir of ALWAYS_COPY_DIRS) {
    const dirPath = path.join(tempDir, dir);
    if (!await dirExists(dirPath)) continue;

    const files = await walkDir(dirPath);
    for (const absPath of files) {
      const relPath = path.relative(dirPath, absPath).replace(/\\/g, '/');
      copy.push({ sourcePath: absPath, outputPath: `.claude/${dir}/${relPath}`, module: null, volatile: false, iterator: null });
    }
  }

  // 4. Walk codex/ (if present)
  const codexDir = path.join(tempDir, 'codex');
  if (await dirExists(codexDir)) {
    const files = await walkDir(codexDir);
    for (const absPath of files) {
      const relPath = path.relative(codexDir, absPath).replace(/\\/g, '/');
      copy.push({ sourcePath: absPath, outputPath: `.codex/prompts/${relPath}`, module: null, volatile: false, iterator: null });
    }
  }

  return { render, copy, skip };
}

function computeTemplateOutput(relPath: string): string {
  // Special case: settings.json.njk → .claude/settings.json
  if (relPath === 'settings.json.njk') {
    return '.claude/settings.json';
  }
  // Strip .njk suffix
  if (relPath.endsWith('.njk')) {
    return relPath.slice(0, -4);
  }
  return relPath;
}

function findModule(relPath: string, schema: ShardSchema): string | null {
  for (const [moduleId, mod] of Object.entries(schema.modules)) {
    // Check paths (directory prefixes)
    for (const modPath of mod.paths) {
      if (relPath.startsWith(modPath)) {
        return moduleId;
      }
    }
    // Check partials (exact path matches against template-relative paths)
    if (mod.partials) {
      for (const partial of mod.partials) {
        if (relPath === partial) {
          return moduleId;
        }
      }
    }
    // Check bases (match templates/bases/<id>.base.njk against bases[] IDs)
    if (mod.bases) {
      for (const baseId of mod.bases) {
        if (relPath === `bases/${baseId}.base.njk`) {
          return moduleId;
        }
      }
    }
  }
  return null;
}

function findModuleForResource(
  fileName: string,
  resourceType: 'commands' | 'agents',
  schema: ShardSchema,
): string | null {
  for (const [moduleId, mod] of Object.entries(schema.modules)) {
    const list = mod[resourceType];
    if (list && list.includes(fileName)) {
      return moduleId;
    }
  }
  return null;
}

function extractIterator(relPath: string): string | null {
  const basename = path.basename(relPath, '.njk');
  // Match filenames like _each.md or _each.anything
  if (!basename.startsWith('_each')) return null;
  // Iterator key is the parent directory name
  const dir = path.dirname(relPath);
  if (dir === '.') return null;
  return path.basename(dir);
}

async function detectVolatile(filePath: string): Promise<boolean> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(256);
    const { bytesRead } = await handle.read(buf, 0, 256, 0);
    const content = buf.toString('utf-8', 0, bytesRead);
    return content.trimStart().startsWith(VOLATILE_MARKER);
  } finally {
    await handle.close();
  }
}

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function walkDir(dirPath: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...await walkDir(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}
