import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { stringify as stringifyYaml } from 'yaml';
import type {
  ShardManifest,
  ShardSchema,
  ShardState,
  FileState,
  FileEntry,
  RenderContext,
  ResolvedShard,
} from '../runtime/types.js';
import { ShardMindError } from '../runtime/types.js';
import { resolveModules } from './modules.js';
import { createRenderer, renderFile } from './renderer.js';
import {
  initShardDir,
  cacheTemplates,
  cacheManifest,
  writeState,
} from './state.js';
import { restoreBackups, type BackupRecord } from './install-plan.js';

export interface RenderPlan {
  renderEntries: FileEntry[];
  copyEntries: FileEntry[];
  totalFiles: number;
}

export interface PlannedOutput {
  outputPath: string;
  source: 'render' | 'copy';
}

export interface InstallRunnerOptions {
  vaultRoot: string;
  manifest: ShardManifest;
  schema: ShardSchema;
  tempDir: string;
  resolved: ResolvedShard;
  values: Record<string, unknown>;
  selections: Record<string, 'included' | 'excluded'>;
  onProgress?: (event: ProgressEvent) => void;
  dryRun?: boolean;
}

export interface InstallResult {
  writtenPaths: string[];
  state: ShardState;
  fileCount: number;
}

export type ProgressEvent =
  | { kind: 'start'; total: number }
  | { kind: 'file'; index: number; total: number; label: string; outputPath: string }
  | { kind: 'done'; total: number };

/**
 * Enumerate every file that would be written given the selected modules.
 * Used for collision detection and module file counting before install.
 */
export async function planOutputs(
  schema: ShardSchema,
  tempDir: string,
  selections: Record<string, 'included' | 'excluded'>,
): Promise<{
  outputs: PlannedOutput[];
  plan: RenderPlan;
  moduleFileCounts: Record<string, number>;
  alwaysIncludedFileCount: number;
}> {
  const resolution = await resolveModules(schema, selections, tempDir);
  const outputs: PlannedOutput[] = [];
  const moduleFileCounts: Record<string, number> = {};
  let alwaysIncludedFileCount = 0;

  for (const id of Object.keys(schema.modules)) {
    moduleFileCounts[id] = 0;
  }

  for (const entry of resolution.render) {
    outputs.push({ outputPath: entry.outputPath, source: 'render' });
    if (entry.module && entry.module in moduleFileCounts) {
      moduleFileCounts[entry.module]!++;
    } else if (!entry.module) {
      alwaysIncludedFileCount++;
    }
  }
  for (const entry of resolution.copy) {
    outputs.push({ outputPath: entry.outputPath, source: 'copy' });
    if (entry.module && entry.module in moduleFileCounts) {
      moduleFileCounts[entry.module]!++;
    } else if (!entry.module) {
      alwaysIncludedFileCount++;
    }
  }

  const plan: RenderPlan = {
    renderEntries: resolution.render,
    copyEntries: resolution.copy,
    totalFiles: resolution.render.length + resolution.copy.length,
  };

  return { outputs, plan, moduleFileCounts, alwaysIncludedFileCount };
}

/**
 * Execute the install pipeline: render + copy + write + cache + state.
 * Returns paths written so the caller can roll back on later failure.
 */
export async function runInstall(opts: InstallRunnerOptions): Promise<InstallResult> {
  const { vaultRoot, manifest, schema, tempDir, resolved, values, selections, onProgress, dryRun } = opts;

  const resolution = await resolveModules(schema, selections, tempDir);
  const totalFiles = resolution.render.length + resolution.copy.length;
  const writtenPaths: string[] = [];
  const fileStates: Record<string, FileState> = {};

  onProgress?.({ kind: 'start', total: totalFiles });

  const env = createRenderer(path.join(tempDir, 'templates'));
  const includedModules = Object.entries(selections)
    .filter(([, s]) => s === 'included')
    .map(([id]) => id);
  const context: RenderContext = {
    values,
    included_modules: includedModules,
    shard: { name: manifest.name, version: manifest.version },
    install_date: new Date().toISOString(),
    year: new Date().getUTCFullYear().toString(),
  };

  let index = 0;

  // Render .njk files
  for (const entry of resolution.render) {
    index++;
    onProgress?.({
      kind: 'file',
      index,
      total: totalFiles,
      label: entry.outputPath,
      outputPath: entry.outputPath,
    });

    let rendered;
    try {
      rendered = await renderFile(entry, context, env);
    } catch (err) {
      throw wrapRenderError(entry.outputPath, err);
    }

    const files = Array.isArray(rendered) ? rendered : [rendered];
    for (const file of files) {
      if (!dryRun) {
        await writeVaultFile(vaultRoot, file.outputPath, file.content);
        writtenPaths.push(file.outputPath);
      }
      fileStates[file.outputPath] = {
        template: path.relative(tempDir, entry.sourcePath).replace(/\\/g, '/'),
        rendered_hash: file.hash,
        ownership: 'managed',
        ...(entry.iterator ? { iterator_key: entry.iterator } : {}),
      };
    }
  }

  // Copy verbatim files
  for (const entry of resolution.copy) {
    index++;
    onProgress?.({
      kind: 'file',
      index,
      total: totalFiles,
      label: entry.outputPath,
      outputPath: entry.outputPath,
    });

    const buffer = await fsp.readFile(entry.sourcePath);
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    if (!dryRun) {
      await writeVaultFileBuffer(vaultRoot, entry.outputPath, buffer);
      writtenPaths.push(entry.outputPath);
    }
    fileStates[entry.outputPath] = {
      template: path.relative(tempDir, entry.sourcePath).replace(/\\/g, '/'),
      rendered_hash: hash,
      ownership: 'managed',
    };
  }

  onProgress?.({ kind: 'done', total: totalFiles });

  const state: ShardState = {
    schema_version: 1,
    shard: `${manifest.namespace}/${manifest.name}`,
    source: resolved.source,
    version: manifest.version,
    installed_at: context.install_date,
    updated_at: context.install_date,
    values_hash: hashValues(values),
    modules: selections,
    files: fileStates,
  };

  if (!dryRun) {
    // Guard: shard-values.yaml is user-owned. If it already exists we
    // refuse to overwrite — prior install flow should have routed
    // through ExistingInstallGate, and without an active install this
    // file has no engine context to merge against.
    const valuesAbsPath = path.join(vaultRoot, 'shard-values.yaml');
    if (await fileExists(valuesAbsPath)) {
      throw new ShardMindError(
        'shard-values.yaml already exists at the install target',
        'VALUES_FILE_COLLISION',
        'Run `shardmind update` if this vault already has a shard, or move/remove shard-values.yaml to install fresh.',
      );
    }

    await initShardDir(vaultRoot);
    await cacheTemplates(vaultRoot, tempDir);
    await cacheManifest(vaultRoot, manifest, schema);
    await writeState(vaultRoot, state);
    await writeValuesFile(vaultRoot, values);
    // Track shard-values.yaml in writtenPaths so rollback can clean it up.
    writtenPaths.push('shard-values.yaml');
  }

  return { writtenPaths, state, fileCount: totalFiles };
}

async function fileExists(absolutePath: string): Promise<boolean> {
  try {
    await fsp.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Roll back a partial install. Removes all written files, cleans up
 * empty parent directories, deletes .shardmind/ if present, and
 * restores any backups created during collision handling.
 * Best-effort — errors during rollback are swallowed because the
 * primary failure is already being reported.
 */
export async function rollbackInstall(
  vaultRoot: string,
  writtenPaths: string[],
  backups: BackupRecord[] = [],
): Promise<void> {
  const sortedByDepth = [...writtenPaths].sort(
    (a, b) => b.split('/').length - a.split('/').length,
  );
  for (const rel of sortedByDepth) {
    const abs = path.join(vaultRoot, rel);
    try {
      await fsp.unlink(abs);
    } catch {
      // already gone
    }
  }

  // Remove empty parent directories (best-effort, deepest first)
  const dirs = new Set<string>();
  for (const rel of writtenPaths) {
    let dir = path.dirname(rel);
    while (dir && dir !== '.' && dir !== '/') {
      dirs.add(dir);
      dir = path.dirname(dir);
    }
  }
  const sortedDirs = [...dirs].sort((a, b) => b.split('/').length - a.split('/').length);
  for (const rel of sortedDirs) {
    try {
      await fsp.rmdir(path.join(vaultRoot, rel));
    } catch {
      // non-empty or already gone
    }
  }

  try {
    await fsp.rm(path.join(vaultRoot, '.shardmind'), { recursive: true, force: true });
  } catch {
    // ignore
  }

  // Restore any backups last, so they land on paths that have been
  // freed by the file removal above.
  if (backups.length > 0) {
    await restoreBackups(backups);
  }
}

export function hashValues(values: Record<string, unknown>): string {
  const serialized = JSON.stringify(values, Object.keys(values).sort());
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

async function writeVaultFile(
  vaultRoot: string,
  outputPath: string,
  content: string,
): Promise<void> {
  const abs = path.join(vaultRoot, outputPath);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, 'utf-8');
}

async function writeVaultFileBuffer(
  vaultRoot: string,
  outputPath: string,
  content: Buffer,
): Promise<void> {
  const abs = path.join(vaultRoot, outputPath);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content);
}

async function writeValuesFile(
  vaultRoot: string,
  values: Record<string, unknown>,
): Promise<void> {
  const abs = path.join(vaultRoot, 'shard-values.yaml');
  const serialized = stringifyYaml(values, { lineWidth: 0 }).trimEnd() + '\n';
  await fsp.writeFile(abs, serialized, 'utf-8');
}

function wrapRenderError(outputPath: string, err: unknown): ShardMindError {
  if (err instanceof ShardMindError) {
    return err;
  }
  const message = err instanceof Error ? err.message : String(err);
  return new ShardMindError(
    `Template render failed: ${outputPath}`,
    'RENDER_FAILED',
    message,
  );
}
