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
  DriftEntry,
  FileState,
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
import { assertNoOutputClashes, plannedOutputRefs } from './output-clash.js';
import { assertSafeVaultPaths } from './vault-path-guard.js';
import { isCaseOnlyRename } from './rename-migrations.js';
import { resolveModules } from './modules.js';
import { renderFile, createRenderer, itemForTemplate } from './renderer.js';
import { isBinaryForMerge, sha256, mapConcurrent } from './fs-utils.js';
import { CACHED_TEMPLATES } from '../runtime/vault-paths.js';

/** Cap fan-out when reading templates + user files during merge planning. */
const PLAN_IO_CONCURRENCY = 16;

/**
 * Copy-origin actions (those that come from `resolution.copy`, not from
 * the Nunjucks render pipeline) carry a `copyFromSourcePath` pointer.
 * The executor prefers `fsp.copyFile` on that path so binary assets
 * survive the round-trip byte-for-byte. Text-origin actions omit this
 * field and the executor writes `content` as UTF-8.
 */
export type UpdateAction = (
  | {
      kind: 'noop';
      path: string;
      reason: string;
      /**
       * The state entry the executor records for the path, with the new
       * render's hash as the baseline: a modified file the merge left as it
       * is, or an untracked file identical to a newly added path, adopted
       * (#62). A noop without it keeps the prior state entry.
       */
      rebaseline?: Rebaseline;
    }
  | { kind: 'overwrite'; path: string; content: string; renderedHash: string; templateKey: string | null; iteratorKey?: string; copyFromSourcePath?: string }
  | {
      kind: 'auto_merge';
      path: string;
      content: string;
      /**
       * sha256 of the new render: what the executor records as
       * `rendered_hash` and `--json` reports. Never the merged bytes, which hold the user's
       * lines — recorded as the baseline, drift would read them as
       * engine-owned and the next update would overwrite them (#150).
       */
      baselineHash: string;
      /** `managed` only when the merge produced exactly the new render. */
      ownership: 'managed' | 'modified';
      stats: MergeStats;
      templateKey: string | null;
      iteratorKey?: string;
    }
  | {
      kind: 'conflict';
      path: string;
      result: MergeResult;
      newContent: string;
      newContentHash: string;
      /** sha256 of the user's on-disk content at plan time. Reported by
       * `--json`; never recorded as the baseline (#150). */
      theirsHash: string;
      templateKey: string | null;
      iteratorKey?: string;
      /**
       * Set for a copy-origin target: Accept new copies these bytes rather
       * than writing `newContent`, a UTF-8 view that mangles binary (#63).
       */
      copyFromSourcePath?: string;
      /**
       * Set when the user has untracked content at a path the new shard
       * newly introduces (`add` that collided with a user-created file).
       * On `accept_new` the shard content adopts the path as managed; on
       * `keep_mine` / `skip` the user's file stays on disk AND stays
       * untracked — we never silently start managing a file the user
       * didn't opt in to. The opt-ins track it as the user's modified copy:
       * `keep_and_track` for this file (#165), or the run's
       * `--adopt-preexisting` (#61).
       */
      preexisting?: boolean;
    }
  | { kind: 'skip_volatile'; path: string }
  | { kind: 'add'; path: string; content: string; renderedHash: string; templateKey: string | null; iteratorKey?: string; copyFromSourcePath?: string }
  | { kind: 'restore_missing'; path: string; content: string; renderedHash: string; templateKey: string | null; iteratorKey?: string; copyFromSourcePath?: string }
  | { kind: 'delete'; path: string }
  | { kind: 'keep_as_user'; path: string }
) & {
  /**
   * Set when the action's path is a rename's new path (#178): the file was
   * tracked at this old path. The executor deletes it after writing the new
   * path, or moves it there when nothing new is written.
   */
  renamedFrom?: string;
  /**
   * The new path's template keys, set with `renamedFrom`. An entry the
   * executor moves as it is (no change, a volatile file) records them, so a
   * later merge finds its base in the new shard's cache.
   */
  renamedKeys?: { templateKey: string; iteratorKey?: string };
};

/**
 * The state entry recorded for a modified file the update leaves on disk.
 * `renderedHash` is always the engine's (the new render): per the
 * baseline rule (`docs/SHARD-LAYOUT.md §Re-hash + state`), the user's
 * bytes are never recorded there. `ownership` is `managed` only when the
 * user's bytes already equal the new render.
 */
export interface Rebaseline {
  renderedHash: string;
  templateKey: string | null;
  iteratorKey?: string;
  ownership: 'managed' | 'modified';
}

export interface PendingConflict {
  path: string;
  result: MergeResult;
  /** Copied from the `conflict` action: DiffView names an add-collision as one (#60). */
  preexisting?: boolean;
}

export interface UpdatePlan {
  actions: UpdateAction[];
  pendingConflicts: PendingConflict[];
  counts: UpdatePlanCounts;
}

export interface UpdatePlanCounts {
  silent: number;      // managed overwrites + noops
  /** The managed-overwrite part of `silent`; the rest left files byte-identical (#153). */
  overwritten: number;
  /** Untracked files identical to a newly added path, adopted as managed (#62); not part of `silent`. */
  adopted: number;
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
    /**
     * New path → old path for each rename migration that applies (#178):
     * `state` and `drift` are already keyed by the new paths
     * (`applyRenames`), and the file is still at the old one.
     */
    movedFrom?: ReadonlyMap<string, string>;
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

/**
 * `keep_and_track` (#165) is keep mine that also tracks a preexisting
 * add-collision as the user's modified copy, for that file alone; on a file
 * already tracked it is the same as `keep_mine`.
 */
export type ConflictResolution = 'accept_new' | 'keep_mine' | 'keep_and_track' | 'skip';

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

/** Every count at zero: the start of a plan, and the whole of an up-to-date one (#230). */
export function emptyUpdatePlanCounts(): UpdatePlanCounts {
  return {
    silent: 0,
    overwritten: 0,
    adopted: 0,
    autoMerged: 0,
    conflicts: 0,
    volatile: 0,
    added: 0,
    deleted: 0,
    keptAsUser: 0,
    restored: 0,
  };
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
 * drift). Managed-ownership removals are auto-handled; a volatile one is
 * kept as the user's without a prompt (#210). Only this subset needs one.
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
  /** Copy-origin only: the source must not be line-merged (`isBinaryForMerge`), measured once here (#63). */
  binary?: boolean;
  /** Copy-origin only: the source's size in bytes. */
  byteLength?: number;
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
  // Two outputs naming one vault path are refused before rendering or any
  // write (#240).
  assertNoOutputClashes(plannedOutputRefs(resolution, newRenderContext.values, newTempDir));
  const env = createRenderer(newTempDir);

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
        binary: isBinaryForMerge(buffer),
        byteLength: buffer.length,
      };
    }),
  ]);

  return { outputs: [...renderedPairs.flat(), ...copiedPairs] };
}

/** The `noop` reason for an untracked file adopted because it already matches (#62). */
export const ALREADY_NEW_VERSION = 'already the new version';

/** Actions that write, or record a path the next update may write. */
const WRITE_ACTIONS = new Set<UpdateAction['kind']>([
  'overwrite',
  'auto_merge',
  'conflict',
  'add',
  'restore_missing',
]);

/**
 * The vault paths an update plan touches (#163): `writes` it writes or
 * starts tracking — including an untracked file adopted because it is
 * already the new version (#62) — and `deletes` it removes.
 */
export function pathsTheUpdateTouches(actions: readonly UpdateAction[]): {
  writes: string[];
  deletes: string[];
  /** Renames that only change a name's case (#169): the guard reads neither name as a case-mismatch. */
  caseRenames: Array<[string, string]>;
} {
  const writes = actions.filter(
    (a) =>
      WRITE_ACTIONS.has(a.kind) ||
      (a.kind === 'noop' && a.reason === ALREADY_NEW_VERSION) ||
      // A rename writes or moves into its new path, whatever the kind (#178).
      a.renamedFrom !== undefined,
  );
  return {
    writes: writes.map((a) => a.path),
    deletes: [
      ...actions.filter((a) => a.kind === 'delete').map((a) => a.path),
      // A rename removes or moves its old path (#178).
      ...actions.flatMap((a) => (a.renamedFrom === undefined ? [] : [a.renamedFrom])),
    ],
    caseRenames: actions.flatMap((a) =>
      a.renamedFrom !== undefined && isCaseOnlyRename(a.renamedFrom, a.path) ? [[a.renamedFrom, a.path] as [string, string]] : [],
    ),
  };
}

/**
 * Build the full UpdatePlan. Reads the on-disk content of `modified`
 * entries and the cached old-template content for three-way merges, but
 * never writes.
 */
export async function planUpdate(input: PlanUpdateInput): Promise<UpdatePlan> {
  const { vault, values, newShard, removedFileDecisions } = input;
  const { root: vaultRoot, state: currentState, drift } = vault;
  const movedFrom = vault.movedFrom ?? new Map<string, string>();
  // `state` and `drift` are keyed by a renamed file's new path while its bytes
  // are still at the old one (#178): every vault read goes through here.
  const diskPathOf = (rel: string): string => movedFrom.get(rel) ?? rel;
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
  const counts = emptyUpdatePlanCounts();

  // A file whose template is volatile in the new shard is skipped like one
  // whose installed template was (drift's volatile bucket): a template that
  // turns volatile in this release (#210).
  const turnsVolatile = (e: DriftEntry): boolean => newByPath.get(e.path)?.entry.volatile === true;
  const volatileEntries = [
    ...drift.volatile,
    ...drift.managed.filter(turnsVolatile),
    ...drift.modified.filter(turnsVolatile),
    ...drift.missing.filter(turnsVolatile),
  ];
  const managedEntries = drift.managed.filter((e) => !turnsVolatile(e));
  const modifiedEntries = drift.modified.filter((e) => !turnsVolatile(e));
  const missingEntries = drift.missing.filter((e) => !turnsVolatile(e));

  for (const entry of volatileEntries) {
    // A volatile file the new shard no longer ships is kept as the user's
    // and untracked: its template leaves the cache with this update, so a
    // later run could no longer tell it is volatile (#210).
    if (!newByPath.has(entry.path)) {
      actions.push({ kind: 'keep_as_user', path: entry.path });
      counts.keptAsUser++;
      continue;
    }
    actions.push({ kind: 'skip_volatile', path: entry.path });
    counts.volatile++;
  }

  // A managed entry is about to be replaced (`target`) or deleted (no
  // target). Both need the baseline proven first, below.
  const overwriteCandidates: Array<{ entry: DriftEntry; target: RenderedFileEntry | undefined }> = [];
  for (const entry of managedEntries) {
    const target = newByPath.get(entry.path);
    if (!target) {
      overwriteCandidates.push({ entry, target });
      continue;
    }
    if (target.hash === entry.renderedHash) {
      actions.push({ kind: 'noop', path: entry.path, reason: 'identical' });
      counts.silent++;
      continue;
    }
    overwriteCandidates.push({ entry, target });
  }

  // Before overwriting or deleting, prove the recorded hash is the engine's. For a
  // copy-origin file the cached old source IS what the engine wrote, so a
  // recorded hash that differs from it was not the engine's: state written
  // before #150 recorded the user's bytes there, or a hook personalized the
  // file. Either way the bytes on disk are not the engine's to replace, so
  // the entry takes the modified (merge) path. Rendered files get no such
  // check — a render depends on per-run context and cannot prove a baseline.
  const baselineChecks = await mapConcurrent(
    overwriteCandidates,
    PLAN_IO_CONCURRENCY,
    async (c) => ({
      ...c,
      foreign: await recordedHashIsForeign(vaultRoot, currentState.files[c.entry.path]),
    }),
  );
  const toMerge: DriftEntry[] = [...modifiedEntries];
  for (const { entry, target, foreign } of baselineChecks) {
    if (foreign) {
      // The modified path merges a file the shard still produces, and keeps
      // a dropped one as unmanaged user content (`keep_as_user`): the
      // removed-files prompt is built from drift, so it never offers these.
      toMerge.push(entry);
      continue;
    }
    if (!target) {
      actions.push({ kind: 'delete', path: entry.path });
      counts.deleted++;
      continue;
    }
    actions.push({
      kind: 'overwrite',
      path: entry.path,
      content: target.content,
      renderedHash: target.hash,
      ...targetKeys(target, newTempDir),
      ...copyFrom(target),
    });
    counts.silent++;
    // Same set as the executor's `summary.replacedFiles` minus accepted conflicts.
    counts.overwritten++;
  }

  for (const entry of missingEntries) {
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
      ...targetKeys(target, newTempDir),
      ...copyFrom(target),
    });
    counts.restored++;
  }

  // Modified files: run the three-way merge for each in parallel.
  // `computeMergeAction` is CPU-bound (diff3 + sha256), but each entry
  // also does three file reads, so fanning out with bounded concurrency
  // saves real wall-clock time on vaults with many modified files.
  const modifiedActions = await mapConcurrent<DriftEntry, UpdateAction>(
    toMerge,
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

      const [actualRead, oldBytes] = await Promise.all([
        readBytesAndHash(path.join(vaultRoot, diskPathOf(entry.path))),
        readCachedTemplate(vaultRoot, fileState.template),
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
      const theirsHash = actualRead.hash;

      // Bytes that must not be line-merged never reach the merge, which runs
      // on a UTF-8 decoding and writes mangled bytes back (#63). Any side
      // counts, whatever the target's origin: a user can drop a binary over a
      // rendered note, and a copy source can become a template.
      const userOrOldBinary =
        isBinaryForMerge(actualRead.buf) || (oldBytes !== null && isBinaryForMerge(oldBytes));
      const shard = await shardBytesInfo(target);
      if (userOrOldBinary || shard.binary) {
        // "Did the shard change it" compares source with source: the cached
        // old source against the new one (for a template, its .njk source,
        // not the render), so an unchanged template is not re-prompted.
        const newSourceHash = target.copyFromSourcePath
          ? target.hash
          : sha256(await fsp.readFile(target.entry.sourcePath));
        return planBinary(entry.path, target, actualRead, oldBytes, newSourceHash, shard.byteLength, newTempDir);
      }
      const actualContent = actualRead.buf.toString('utf-8');

      const oldTemplate = oldBytes === null ? null : oldBytes.toString('utf-8');
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
      // An `_each` file renders each side with its own item (#233): the old
      // one from the old values, looked up at the file's old path (a rename
      // migration may have moved it); the new one from the new values. A file
      // whose old template was `_each` but whose new one is static still gets
      // its old item. If the old lookup misses, the new item stands in.
      const newItem = target.entry.iterator
        ? itemForTemplate(target.entry.outputPath, newValues, entry.path)
        : undefined;
      const oldItem = itemForTemplate(fileState.template, oldValues, diskPathOf(entry.path)) ?? newItem;
      const items = oldItem === undefined && newItem === undefined ? {} : { oldItem, newItem };
      const mergeAction = await computeMergeAction({
        path: entry.path,
        ownership: 'modified',
        oldTemplate,
        newTemplate,
        oldValues,
        newValues,
        actualContent,
        renderContext: newRenderContext,
        // Copy-origin files (no `.njk` suffix) are verbatim, not templates.
        // Rendering them through Nunjucks crashes on a literal `{{` and would
        // substitute any real `{{ expr }}` as data, so merge raw bytes (#132).
        literal: target.copyFromSourcePath !== undefined,
        ...items,
      });

      const keys = targetKeys(target, newTempDir);
      switch (mergeAction.type) {
        case 'skip':
          return {
            kind: 'noop',
            path: entry.path,
            reason: mergeAction.reason,
            rebaseline: rebaselineOf(target, newTempDir, theirsHash === target.hash ? 'managed' : 'modified'),
          };
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
            baselineHash: target.hash,
            ownership: sha256(content) === target.hash ? 'managed' : 'modified',
            stats: mergeAction.stats,
            ...keys,
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
            ...keys,
            ...copyFrom(target),
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
  // in state.files, decide between a plain `add` (path is free on disk),
  // adopting the user's file (it is byte-identical to the new version, #62),
  // and a `conflict` (user has other untracked content at the same path).
  // Silently overwriting an untracked user file is a data-loss bug on
  // par with the install command's collision handling — route the
  // user's content through DiffView instead.
  const trackedPaths = new Set(Object.keys(currentState.files));
  const addCandidates = newPlan.outputs.filter(o => !trackedPaths.has(o.outputPath));
  // One directory listing per folder for the exact-name check below, however
  // many identical files a folder holds.
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
        // A link is refused before anything reads through it (#163).
        if ((await fsp.lstat(abs)).isSymbolicLink()) await assertSafeVaultPaths(vaultRoot, [output.outputPath]);
        stat = await fsp.stat(abs);
      } catch (err) {
        if (isEnoent(err)) {
          return {
            kind: 'add',
            path: output.outputPath,
            content: output.content,
            renderedHash: output.hash,
            ...targetKeys(output, newTempDir),
            ...copyFrom(output),
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
      const actualRead = await readBytesAndHash(abs);
      if (actualRead === null) {
        return {
          kind: 'add',
          path: output.outputPath,
          content: output.content,
          renderedHash: output.hash,
          ...targetKeys(output, newTempDir),
          ...copyFrom(output),
        };
      }
      // The user already has exactly the new version: a prompt here would
      // offer two answers that both leave the same bytes. Adopt the file as
      // managed, with no write (#62). A symlink or a case-folded name here
      // refuses the whole update below (#163).
      if (actualRead.hash === output.hash) {
        return alreadyNewVersion(output, newTempDir);
      }
      // A binary collision gets the whole-file binary prompt, not a text
      // diff of decoded bytes (#63).
      const shard = await shardBytesInfo(output);
      const collision =
        shard.binary || isBinaryForMerge(actualRead.buf)
          ? binaryConflict(output.outputPath, output, actualRead, shard.byteLength, newTempDir)
          : (conflictFromDirect(
              output.outputPath,
              output,
              actualRead.buf.toString('utf-8'),
              actualRead.hash,
              newTempDir,
            ) as Extract<UpdateAction, { kind: 'conflict' }>);
      return { ...collision, preexisting: true };
    },
  );
  for (const action of addActions) {
    actions.push(action);
    if (action.kind === 'add') {
      counts.added++;
    } else if (action.kind === 'noop') {
      counts.adopted++;
    } else if (action.kind === 'conflict') {
      // Same accounting as a modified-file conflict so the pending-
      // conflicts count in the summary stays coherent.
      pendingConflicts.push({ path: action.path, result: action.result, preexisting: action.preexisting });
      counts.conflicts++;
    }
  }

  for (const action of actions) {
    const from = movedFrom.get(action.path);
    const target = newByPath.get(action.path);
    if (from === undefined || target === undefined) continue;
    action.renamedFrom = from;
    action.renamedKeys = targetKeys(target, newTempDir);
  }

  // Refuse before any prompt or `--json` plan, so a dry run reports what
  // the run would do (#163). The executor checks again before it writes.
  const touched = pathsTheUpdateTouches(actions);
  await assertSafeVaultPaths(vaultRoot, touched.writes, touched.deletes, touched.caseRenames);

  return { actions, pendingConflicts, counts };
}

/**
 * Plan a modified file whose bytes must not be line-merged (#63). The user's
 * bytes already equal the new version: nothing to do, and the file is the
 * engine's again. The cached old source equals the new source (`newSourceHash`,
 * a template's own source for a rendered target): keep the user's bytes. Any
 * other case is a whole-file conflict carrying byte counts; Accept new copies
 * a copy source's bytes, or writes a template's render.
 */
function planBinary(
  filePath: string,
  target: RenderedFileEntry,
  actual: { buf: Buffer; hash: string },
  oldBytes: Buffer | null,
  newSourceHash: string,
  shardByteLength: number,
  newTempDir: string,
): UpdateAction {
  if (actual.hash === target.hash) return alreadyNewVersion(target, newTempDir);
  if (oldBytes !== null && sha256(oldBytes) === newSourceHash) {
    return { kind: 'noop', path: filePath, reason: 'no upstream change', rebaseline: rebaselineOf(target, newTempDir, 'modified') };
  }
  return binaryConflict(filePath, target, actual, shardByteLength, newTempDir);
}

/** A whole-file conflict for a binary file: byte counts, no text regions (#63). */
function binaryConflict(
  filePath: string,
  target: RenderedFileEntry,
  actual: { buf: Buffer; hash: string },
  shardByteLength: number,
  newTempDir: string,
): Extract<UpdateAction, { kind: 'conflict' }> {
  return {
    kind: 'conflict',
    path: filePath,
    result: {
      content: '',
      conflicts: [],
      stats: { linesUnchanged: 0, linesAutoMerged: 0, linesConflicted: 0 },
      binary: { yours: actual.buf.length, shard: shardByteLength },
    },
    newContent: target.content,
    newContentHash: target.hash,
    theirsHash: actual.hash,
    ...targetKeys(target, newTempDir),
    ...copyFrom(target),
  };
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
    ...targetKeys(target, newTempDir),
    ...copyFrom(target),
  };
}

/**
 * Read a user file and produce both its string view (for the three-way
 * merge, which is line-oriented) and its bytewise hash (`theirsHash`, which
 * decides whether the user's bytes already equal the new render).
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
async function readBytesAndHash(
  absPath: string,
): Promise<{ buf: Buffer; hash: string } | null> {
  try {
    const buf = await fsp.readFile(absPath);
    return { buf, hash: sha256(buf) };
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

/**
 * Whether a managed entry's recorded hash is provably NOT the engine's: the
 * OLD source was copy-origin, it is in the merge-base cache, and the cached
 * bytes hash differently. Copy-origin is read from the recorded template key
 * — a render source always ends in `.njk` (`modules.ts`), a copy source
 * never does — because the cached bytes are the old source's, whatever the
 * new shard does with the path. (Iterator outputs are always rendered, so
 * they never reach the comparison.) No readable cached source means no
 * proof either way, and the answer is `false`: this check must never be
 * what fails an update.
 */
async function recordedHashIsForeign(vaultRoot: string, fileState: FileState | undefined): Promise<boolean> {
  if (!fileState?.template || fileState.template.endsWith('.njk')) return false;
  try {
    const cached = await readCachedTemplate(vaultRoot, fileState.template);
    return cached !== null && sha256(cached) !== fileState.rendered_hash;
  } catch {
    return false;
  }
}

/** The merge-base cache's bytes for `templateKey`, or `null` when absent. */
async function readCachedTemplate(
  vaultRoot: string,
  templateKey: string | null,
): Promise<Buffer | null> {
  if (!templateKey) return null;
  try {
    return await fsp.readFile(path.join(vaultRoot, CACHED_TEMPLATES, templateKey));
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

/** The `templateKey` (and `iteratorKey`, for an iterator output) an action records for `output`. */
function targetKeys(output: RenderedFileEntry, newTempDir: string): { templateKey: string; iteratorKey?: string } {
  return {
    templateKey: toTemplateKey(newTempDir, output.entry.sourcePath),
    ...(output.entry.iterator ? { iteratorKey: output.entry.iterator } : {}),
  };
}

/** The state entry a file the update leaves in place records: the new render as its baseline. */
function rebaselineOf(
  target: RenderedFileEntry,
  newTempDir: string,
  ownership: Rebaseline['ownership'],
): Rebaseline {
  return { renderedHash: target.hash, ...targetKeys(target, newTempDir), ownership };
}

/**
 * Whether the new version's bytes for `output` must not be line-merged, and
 * how many there are. A rendered output is text by construction; a copy
 * source was measured in `renderNewShard`, and is read here only for a plan
 * built elsewhere that did not measure it.
 */
async function shardBytesInfo(output: RenderedFileEntry): Promise<{ binary: boolean; byteLength: number }> {
  if (!output.copyFromSourcePath) return { binary: false, byteLength: Buffer.byteLength(output.content) };
  if (output.binary !== undefined && output.byteLength !== undefined) {
    return { binary: output.binary, byteLength: output.byteLength };
  }
  const bytes = await fsp.readFile(output.copyFromSourcePath);
  return { binary: isBinaryForMerge(bytes), byteLength: bytes.length };
}

/**
 * The user already has exactly the new version's bytes at `output`'s path:
 * nothing to write, and the file is the engine's from here on. Shared by a
 * modified file that matches the new version and an untracked one at a newly
 * added path (#62), so both read the same in the plan and `--json`.
 */
function alreadyNewVersion(output: RenderedFileEntry, newTempDir: string): UpdateAction {
  return {
    kind: 'noop',
    path: output.outputPath,
    reason: ALREADY_NEW_VERSION,
    rebaseline: rebaselineOf(output, newTempDir, 'managed'),
  };
}

/** `{ copyFromSourcePath }` for a copy-origin output, so the executor copies bytes. */
function copyFrom(output: RenderedFileEntry): { copyFromSourcePath?: string } {
  return output.copyFromSourcePath ? { copyFromSourcePath: output.copyFromSourcePath } : {};
}

function toTemplateKey(tempDir: string, sourcePath: string): string {
  if (!tempDir) return sourcePath.replace(/\\/g, '/');
  const rel = path.relative(tempDir, sourcePath).replace(/\\/g, '/');
  return rel;
}
