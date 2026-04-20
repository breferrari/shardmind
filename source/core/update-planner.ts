/**
 * Update planner — pure + read-only operations.
 *
 * Counterpart to install-planner. Takes the current install state, the
 * drift report, and the newly downloaded shard, and emits an `UpdatePlan`
 * describing every per-file action the executor will perform. Disk
 * mutations live in `update-executor.ts`.
 *
 * The planner is intentionally quiet about user interaction. The state
 * machine drives prompts (new values, new modules, removed-file choices)
 * and feeds the decisions back here as inputs. That keeps the planner
 * testable end-to-end with no TUI in the loop.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  ShardSchema,
  ShardState,
  DriftReport,
  ModuleSelections,
  ModuleDefinition,
  MergeStats,
  MergeResult,
  RenderContext,
  FileEntry,
} from '../runtime/types.js';
import { ShardMindError } from '../runtime/types.js';
import { isEnoent } from '../runtime/errno.js';
import { computeMergeAction } from './differ.js';
import { resolveModules } from './modules.js';
import { renderFile, createRenderer } from './renderer.js';
import { sha256, mapConcurrent, stripTemplatePrefix } from './fs-utils.js';
import {
  SHARD_TEMPLATES_DIR,
  CACHED_TEMPLATES,
} from '../runtime/vault-paths.js';

/** Cap fan-out when reading templates + user files during merge planning. */
const PLAN_IO_CONCURRENCY = 16;

/**
 * Copy-origin actions (those that come from `resolution.copy`, not from
 * the Nunjucks render pipeline) carry a `copyFromSourcePath` pointer.
 * The executor prefers `fsp.copyFile` on that path so binary assets
 * survive the round-trip byte-for-byte. Text-origin actions omit this
 * field and the executor writes `content` as UTF-8.
 */
export type UpdateAction =
  | { kind: 'noop'; path: string; reason: string }
  | { kind: 'overwrite'; path: string; content: string; renderedHash: string; templateKey: string | null; iteratorKey?: string; copyFromSourcePath?: string }
  | { kind: 'auto_merge'; path: string; content: string; renderedHash: string; stats: MergeStats; templateKey: string | null; iteratorKey?: string }
  | {
      kind: 'conflict';
      path: string;
      result: MergeResult;
      newContent: string;
      newContentHash: string;
      /** sha256 of the user's on-disk content at plan time; lets the
       * executor avoid re-reading + re-hashing on keep_mine / skip. */
      theirsHash: string;
      templateKey: string | null;
      iteratorKey?: string;
      /**
       * Set when the user has untracked content at a path the new shard
       * newly introduces (`add` that collided with a user-created file).
       * On `accept_new` the shard content adopts the path as managed; on
       * `keep_mine` / `skip` the user's file stays on disk AND stays
       * untracked — we never silently start managing a file the user
       * didn't opt in to.
       */
      preexisting?: boolean;
    }
  | { kind: 'skip_volatile'; path: string }
  | { kind: 'add'; path: string; content: string; renderedHash: string; templateKey: string | null; iteratorKey?: string; copyFromSourcePath?: string }
  | { kind: 'restore_missing'; path: string; content: string; renderedHash: string; templateKey: string | null; iteratorKey?: string; copyFromSourcePath?: string }
  | { kind: 'delete'; path: string }
  | { kind: 'keep_as_user'; path: string };

export interface PendingConflict {
  path: string;
  result: MergeResult;
}

export interface UpdatePlan {
  actions: UpdateAction[];
  pendingConflicts: PendingConflict[];
  counts: UpdatePlanCounts;
}

export interface UpdatePlanCounts {
  silent: number;      // managed overwrites + noops
  autoMerged: number;
  conflicts: number;
  volatile: number;
  added: number;
  deleted: number;
  keptAsUser: number;
  restored: number;
}

/**
 * Everything the planner needs, grouped by origin so call sites can't
 * accidentally mix fields from two different shards (e.g. a newSchema
 * from v4 with a newFilePlan from v3). Each group travels together.
 */
export interface PlanUpdateInput {
  /** Vault under update: root path, recorded state, detected drift. */
  vault: {
    root: string;
    state: ShardState;
    drift: DriftReport;
  };
  /**
   * Values on each side of the migration. `old` is what the renderer
   * used at install time; `new` is the migrated + user-answered shape.
   */
  values: {
    old: Record<string, unknown>;
    new: Record<string, unknown>;
  };
  /** Everything about the incoming shard. These fields always travel together. */
  newShard: {
    schema: ShardSchema;
    selections: ModuleSelections;
    tempDir: string;
    renderContext: RenderContext;
    /**
     * Optional prerendered new-shard plan. The state machine renders
     * once at the prompt-removed-files phase; passing that result back
     * here avoids a second full render pass. When omitted, `planUpdate`
     * renders internally (useful for tests that just want a plan).
     */
    filePlan?: NewFilePlan;
  };
  /**
   * Per-file decisions for removed-and-modified files. Keyed by the
   * vault-relative path that was in state.files but is no longer
   * produced by the new shard. Managed removals are handled without
   * a prompt — only modified removals need a user choice.
   */
  removedFileDecisions: Record<string, 'delete' | 'keep'>;
}

export type ConflictResolution = 'accept_new' | 'keep_mine' | 'skip';

export interface SchemaAdditions {
  /** Required value keys in the new schema that are missing from current values. */
  newRequiredKeys: string[];
  /**
   * Modules that exist in the new schema and are removable, but aren't
   * recorded in the current install's module selections. The user decides
   * whether to opt in; default is to include.
   */
  newOptionalModules: Array<{ id: string; def: ModuleDefinition }>;
  /**
   * Modules present in the current install but gone from the new schema.
   * v0.1 surfaces this only via the update summary's silent-delete count
   * (`mergeModuleSelections` already omits dropped ids from the new
   * selections); the list is populated here so v0.2 can render a
   * dedicated "these modules were removed upstream" block without a
   * second computation pass. Kept intentionally instead of deleted —
   * exported shape, pinned by tests.
   */
  dropped: string[];
}

export function computeSchemaAdditions(
  newSchema: ShardSchema,
  currentSelections: ModuleSelections,
  currentValues: Record<string, unknown>,
): SchemaAdditions {
  const newRequiredKeys: string[] = [];
  for (const [key, def] of Object.entries(newSchema.values)) {
    if (!def.required) continue;
    if (key in currentValues && currentValues[key] !== undefined) continue;
    if (def.default !== undefined) continue;
    newRequiredKeys.push(key);
  }

  const newOptionalModules: Array<{ id: string; def: ModuleDefinition }> = [];
  for (const [id, def] of Object.entries(newSchema.modules)) {
    if (id in currentSelections) continue;
    if (!def.removable) continue;
    newOptionalModules.push({ id, def });
  }

  const dropped: string[] = [];
  for (const id of Object.keys(currentSelections)) {
    if (!(id in newSchema.modules)) dropped.push(id);
  }

  return { newRequiredKeys, newOptionalModules, dropped };
}

/**
 * Merge old selections with user's opt-in choices for new optional modules.
 * Non-removable modules in the new schema are always included. Modules
 * dropped from the new schema are excluded from the result.
 */
export function mergeModuleSelections(
  currentSelections: ModuleSelections,
  newSchema: ShardSchema,
  newOptionalChoices: Record<string, 'included' | 'excluded'>,
): ModuleSelections {
  const next: ModuleSelections = {};
  for (const [id, def] of Object.entries(newSchema.modules)) {
    if (!def.removable) {
      next[id] = 'included';
      continue;
    }
    if (id in currentSelections) {
      next[id] = currentSelections[id]!;
      continue;
    }
    next[id] = newOptionalChoices[id] ?? 'included';
  }
  return next;
}

/**
 * Files that were previously managed but are no longer produced by the
 * new shard, AND that the user has edited (ownership = 'modified' in
 * drift). Managed-ownership removals are auto-handled; volatile removals
 * are untouched. Only this subset needs a prompt.
 */
export function removedFilesNeedingDecision(
  drift: DriftReport,
  newFilePaths: ReadonlySet<string>,
): string[] {
  const paths: string[] = [];
  for (const entry of drift.modified) {
    if (!newFilePaths.has(entry.path)) paths.push(entry.path);
  }
  return paths.sort();
}

export interface RenderedFileEntry {
  outputPath: string;
  entry: FileEntry;
  /**
   * Text content used by the merge engine and by text-writing
   * executors. For copy-origin files, this is a `toString('utf-8')`
   * view of the source bytes — suitable for text comparison but NOT
   * round-trip-safe for binary assets. The executor must prefer
   * `copyFromSourcePath` for those to preserve bytes.
   */
  content: string;
  hash: string;
  /**
   * Set for copy-origin files (images, scripts, binary assets). When
   * present, the executor should write by byte-copying this source
   * path rather than encoding `content` as UTF-8 — which would mangle
   * any non-UTF-8 bytes.
   */
  copyFromSourcePath?: string;
}

export interface NewFilePlan {
  outputs: RenderedFileEntry[];
}

/**
 * Render every file the new shard would produce for `newSelections`.
 * Returned content + hashes feed directly into `planUpdate` so that one
 * render pass covers both "add" and "merge ours".
 *
 * Rendered files carry string content from Nunjucks. Copy-origin files
 * carry a `copyFromSourcePath` pointer so the executor can `fsp.copyFile`
 * byte-for-byte — essential for binary assets (PNG, PDF, compiled
 * scripts) that would be corrupted by a UTF-8 round trip.
 */
export async function renderNewShard(
  newSchema: ShardSchema,
  newTempDir: string,
  newSelections: ModuleSelections,
  newRenderContext: RenderContext,
): Promise<NewFilePlan> {
  const resolution = await resolveModules(newSchema, newSelections, newTempDir);
  const env = createRenderer(path.join(newTempDir, SHARD_TEMPLATES_DIR));

  // Render and copy in parallel (bounded by PLAN_IO_CONCURRENCY) since
  // each entry is independent.
  const [renderedPairs, copiedPairs] = await Promise.all([
    mapConcurrent(resolution.render, PLAN_IO_CONCURRENCY, async (entry) => {
      const rendered = await renderFile(entry, newRenderContext, env);
      const files = Array.isArray(rendered) ? rendered : [rendered];
      return files.map((file) => ({
        outputPath: file.outputPath,
        entry,
        content: file.content,
        hash: file.hash,
      }));
    }),
    mapConcurrent(resolution.copy, PLAN_IO_CONCURRENCY, async (entry) => {
      const buffer = await fsp.readFile(entry.sourcePath);
      return {
        outputPath: entry.outputPath,
        entry,
        content: buffer.toString('utf-8'),
        hash: sha256(buffer),
        copyFromSourcePath: entry.sourcePath,
      };
    }),
  ]);

  return { outputs: [...renderedPairs.flat(), ...copiedPairs] };
}

/**
 * Build the full UpdatePlan. Reads the on-disk content of `modified`
 * entries and the cached old-template content for three-way merges, but
 * never writes.
 */
export async function planUpdate(input: PlanUpdateInput): Promise<UpdatePlan> {
  const { vault, values, newShard, removedFileDecisions } = input;
  const { root: vaultRoot, state: currentState, drift } = vault;
  const { old: oldValues, new: newValues } = values;
  const {
    schema: newSchema,
    selections: newSelections,
    tempDir: newTempDir,
    renderContext: newRenderContext,
    filePlan: newFilePlan,
  } = newShard;

  const newPlan =
    newFilePlan ?? (await renderNewShard(newSchema, newTempDir, newSelections, newRenderContext));
  const newByPath = new Map(newPlan.outputs.map((o) => [o.outputPath, o] as const));

  const actions: UpdateAction[] = [];
  const pendingConflicts: PendingConflict[] = [];
  const counts: UpdatePlanCounts = {
    silent: 0,
    autoMerged: 0,
    conflicts: 0,
    volatile: 0,
    added: 0,
    deleted: 0,
    keptAsUser: 0,
    restored: 0,
  };

  for (const entry of drift.volatile) {
    actions.push({ kind: 'skip_volatile', path: entry.path });
    counts.volatile++;
  }

  for (const entry of drift.managed) {
    const target = newByPath.get(entry.path);
    if (!target) {
      actions.push({ kind: 'delete', path: entry.path });
      counts.deleted++;
      continue;
    }
    if (target.hash === entry.renderedHash) {
      actions.push({ kind: 'noop', path: entry.path, reason: 'identical' });
      counts.silent++;
      continue;
    }
    actions.push({
      kind: 'overwrite',
      path: entry.path,
      content: target.content,
      renderedHash: target.hash,
      templateKey: toTemplateKey(newTempDir, target.entry.sourcePath),
      ...(target.entry.iterator ? { iteratorKey: target.entry.iterator } : {}),
      ...(target.copyFromSourcePath ? { copyFromSourcePath: target.copyFromSourcePath } : {}),
    });
    counts.silent++;
  }

  for (const entry of drift.missing) {
    const target = newByPath.get(entry.path);
    if (!target) {
      actions.push({ kind: 'delete', path: entry.path });
      counts.deleted++;
      continue;
    }
    actions.push({
      kind: 'restore_missing',
      path: entry.path,
      content: target.content,
      renderedHash: target.hash,
      templateKey: toTemplateKey(newTempDir, target.entry.sourcePath),
      ...(target.entry.iterator ? { iteratorKey: target.entry.iterator } : {}),
      ...(target.copyFromSourcePath ? { copyFromSourcePath: target.copyFromSourcePath } : {}),
    });
    counts.restored++;
  }

  // Modified files: run the three-way merge for each in parallel.
  // `computeMergeAction` is CPU-bound (diff3 + sha256), but each entry
  // also does three file reads, so fanning out with bounded concurrency
  // saves real wall-clock time on vaults with many modified files.
  const modifiedActions = await mapConcurrent<typeof drift.modified[number], UpdateAction>(
    drift.modified,
    PLAN_IO_CONCURRENCY,
    async (entry) => {
      const target = newByPath.get(entry.path);
      if (!target) {
        const decision = removedFileDecisions[entry.path] ?? 'keep';
        return decision === 'delete'
          ? { kind: 'delete', path: entry.path }
          : { kind: 'keep_as_user', path: entry.path };
      }

      const fileState = currentState.files[entry.path];
      if (!fileState) {
        throw new ShardMindError(
          `Drift reports '${entry.path}' as modified but it is not in state.files`,
          'UPDATE_CACHE_MISSING',
          'State and drift report disagree — re-install the shard to regenerate a coherent state.json.',
        );
      }

      const [actualRead, oldTemplate] = await Promise.all([
        readStringAndByteHash(path.join(vaultRoot, entry.path)),
        loadOldTemplate(vaultRoot, fileState.template),
      ]);
      if (actualRead === null) {
        // Drift reported this file as `modified` at scan time, so ENOENT
        // now is a race between scan and merge — the user (or another
        // process) deleted the file mid-update. Pretending it was empty
        // would overwrite their absence with the merged shard content
        // on the next write. Surface a typed error instead so the user
        // can re-run the update against a coherent vault.
        throw new ShardMindError(
          `File '${entry.path}' vanished between drift detection and merge planning`,
          'UPDATE_CACHE_MISSING',
          `Vault contents changed during \`shardmind update\`. Re-run — drift detection picks up the current shape and either classifies '${entry.path}' as missing (restored from the shard) or excludes it from the plan.`,
        );
      }
      const actualContent = actualRead.content;
      const theirsHash = actualRead.hash;

      if (oldTemplate === null) {
        return conflictFromDirect(
          entry.path,
          target,
          actualContent,
          theirsHash,
          newTempDir,
        );
      }

      const newTemplate = await fsp.readFile(target.entry.sourcePath, 'utf-8');
      const mergeAction = await computeMergeAction({
        path: entry.path,
        ownership: 'modified',
        oldTemplate,
        newTemplate,
        oldValues,
        newValues,
        actualContent,
        renderContext: newRenderContext,
      });

      switch (mergeAction.type) {
        case 'skip':
          return { kind: 'noop', path: entry.path, reason: mergeAction.reason };
        case 'overwrite':
          // Shouldn't reach us for ownership='modified' (differ branches on
          // ownership before). Defensive no-op: preserve the user's file.
          return { kind: 'noop', path: entry.path, reason: 'modified-ownership differ returned overwrite' };
        case 'auto_merge': {
          const content = mergeAction.content;
          return {
            kind: 'auto_merge',
            path: entry.path,
            content,
            renderedHash: sha256(content),
            stats: mergeAction.stats,
            templateKey: toTemplateKey(newTempDir, target.entry.sourcePath),
            ...(target.entry.iterator ? { iteratorKey: target.entry.iterator } : {}),
          };
        }
        case 'conflict':
          return {
            kind: 'conflict',
            path: entry.path,
            result: mergeAction.result,
            newContent: target.content,
            newContentHash: target.hash,
            theirsHash,
            templateKey: toTemplateKey(newTempDir, target.entry.sourcePath),
            ...(target.entry.iterator ? { iteratorKey: target.entry.iterator } : {}),
          };
      }
    },
  );

  for (const action of modifiedActions) {
    actions.push(action);
    switch (action.kind) {
      case 'delete': counts.deleted++; break;
      case 'keep_as_user': counts.keptAsUser++; break;
      case 'noop': counts.silent++; break;
      case 'auto_merge': counts.autoMerged++; break;
      case 'conflict':
        pendingConflicts.push({
          path: action.path,
          result: action.result,
        });
        counts.conflicts++;
        break;
    }
  }

  // New-add actions: for each shard-produced output that isn't tracked
  // in state.files, decide between a plain `add` (path is free on disk)
  // and a `conflict` (user has untracked content at the same path).
  // Silently overwriting an untracked user file is a data-loss bug on
  // par with the install command's collision handling — route the
  // user's content through DiffView instead.
  const trackedPaths = new Set(Object.keys(currentState.files));
  const addCandidates = newPlan.outputs.filter(o => !trackedPaths.has(o.outputPath));
  const addActions = await mapConcurrent<typeof addCandidates[number], UpdateAction>(
    addCandidates,
    PLAN_IO_CONCURRENCY,
    async (output) => {
      const abs = path.join(vaultRoot, output.outputPath);
      // Stat in a single I/O so we can tell "free path" from "file collision"
      // from "directory collision" without a pathExists → readFile race.
      // ENOENT → free path. EISDIR branch below handles the directory case.
      let stat;
      try {
        stat = await fsp.stat(abs);
      } catch (err) {
        if (isEnoent(err)) {
          return {
            kind: 'add',
            path: output.outputPath,
            content: output.content,
            renderedHash: output.hash,
            templateKey: toTemplateKey(newTempDir, output.entry.sourcePath),
            ...(output.entry.iterator ? { iteratorKey: output.entry.iterator } : {}),
            ...(output.copyFromSourcePath ? { copyFromSourcePath: output.copyFromSourcePath } : {}),
          };
        }
        throw err;
      }

      if (stat.isDirectory()) {
        // User has a directory at a path the new shard wants as a file.
        // Reading it as a file below would crash with EISDIR; silently
        // emitting plain `add` would crash the same way on write. Surface
        // a typed error at plan time so the user sees actionable guidance
        // BEFORE any snapshot or write runs.
        throw new ShardMindError(
          `Update cannot proceed: the new shard adds a file at '${output.outputPath}', but a directory exists there.`,
          'UPDATE_WRITE_FAILED',
          `Remove or rename the directory at '${abs}' before re-running \`shardmind update\`. This directory is not part of the previous install — it's user content at a path the new shard now claims.`,
        );
      }

      // Preexisting untracked file at an add path. Read bytes so
      // `theirsHash` stays consistent with install-executor's
      // bytewise hashing (binary assets were silently mishashed when
      // the previous implementation decoded as UTF-8 first). If the
      // file raced out of existence between the stat above and
      // this read, fall back to a plain `add` — there's nothing to
      // collide with anymore.
      const actualRead = await readStringAndByteHash(abs);
      if (actualRead === null) {
        return {
          kind: 'add',
          path: output.outputPath,
          content: output.content,
          renderedHash: output.hash,
          templateKey: toTemplateKey(newTempDir, output.entry.sourcePath),
          ...(output.entry.iterator ? { iteratorKey: output.entry.iterator } : {}),
          ...(output.copyFromSourcePath ? { copyFromSourcePath: output.copyFromSourcePath } : {}),
        };
      }
      return {
        ...(conflictFromDirect(
          output.outputPath,
          output,
          actualRead.content,
          actualRead.hash,
          newTempDir,
        ) as Extract<UpdateAction, { kind: 'conflict' }>),
        preexisting: true,
      };
    },
  );
  for (const action of addActions) {
    actions.push(action);
    if (action.kind === 'add') {
      counts.added++;
    } else if (action.kind === 'conflict') {
      // Same accounting as a modified-file conflict so the pending-
      // conflicts count in the summary stays coherent.
      pendingConflicts.push({ path: action.path, result: action.result });
      counts.conflicts++;
    }
  }

  return { actions, pendingConflicts, counts };
}

function conflictFromDirect(
  filePath: string,
  target: RenderedFileEntry,
  actualContent: string,
  theirsHash: string,
  newTempDir: string,
): UpdateAction {
  // Synthesize a conflict region covering the whole file when the
  // cached old template is absent — usually a corrupted or manually
  // modified `.shardmind/templates/` directory. Without a base we
  // can't do a real three-way merge, so the whole file becomes one
  // conflict region and the user decides in DiffView.
  const theirsLines = actualContent.split(/\r?\n/);
  const oursLines = target.content.split(/\r?\n/);
  return {
    kind: 'conflict',
    path: filePath,
    result: {
      content: `<<<<<<< yours\n${actualContent}\n=======\n${target.content}\n>>>>>>> shard update\n`,
      conflicts: [
        {
          lineStart: 1,
          lineEnd: theirsLines.length + oursLines.length + 3,
          base: '',
          theirs: actualContent,
          ours: target.content,
        },
      ],
      stats: {
        linesUnchanged: 0,
        linesAutoMerged: 0,
        linesConflicted: theirsLines.length + oursLines.length,
      },
    },
    newContent: target.content,
    newContentHash: target.hash,
    theirsHash,
    templateKey: toTemplateKey(newTempDir, target.entry.sourcePath),
  };
}

/**
 * Read a user file and produce both its string view (for the three-way
 * merge, which is line-oriented) and its bytewise hash (for `theirsHash`
 * which is recorded in state.files on `keep_mine`/`skip` resolutions).
 * Always hashes bytes — install-executor hashes copy-origin files this
 * way, so a bytewise hash here stays consistent across install/update
 * cycles even for content that isn't valid UTF-8.
 *
 * Returns `null` on ENOENT so callers decide semantics:
 *   - modified-file path: file was in `drift.modified` at scan time, so
 *     ENOENT now is a race. Caller throws `UPDATE_CACHE_MISSING`.
 *   - add-collision path: ENOENT between `fsp.stat` and read is a race;
 *     caller degrades to a plain `add` (no collision to report).
 */
async function readStringAndByteHash(
  absPath: string,
): Promise<{ content: string; hash: string } | null> {
  try {
    const buf = await fsp.readFile(absPath);
    return { content: buf.toString('utf-8'), hash: sha256(buf) };
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

async function loadOldTemplate(
  vaultRoot: string,
  templateKey: string | null,
): Promise<string | null> {
  if (!templateKey) return null;
  const abs = path.join(vaultRoot, CACHED_TEMPLATES, stripTemplatePrefix(templateKey));
  try {
    return await fsp.readFile(abs, 'utf-8');
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

function toTemplateKey(tempDir: string, sourcePath: string): string {
  if (!tempDir) return sourcePath.replace(/\\/g, '/');
  const rel = path.relative(tempDir, sourcePath).replace(/\\/g, '/');
  return rel;
}
