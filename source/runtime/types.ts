/**
 * ShardMind shared types.
 * Imported by both CLI and runtime module.
 * See docs/IMPLEMENTATION.md §5, docs/ARCHITECTURE.md §18 for full documentation.
 */

export interface ShardManifest {
  apiVersion: 'v1';
  name: string;
  namespace: string;
  version: string;
  description?: string;
  persona?: string;
  license?: string;
  homepage?: string;
  requires?: {
    obsidian?: string;
    node?: string;
  };
  dependencies: ShardDependency[];
  hooks: {
    'post-install'?: string;
    'post-update'?: string;
    /**
     * Per-shard override for the hook execution timeout (milliseconds).
     * Defaults to 30_000 when absent. Valid range: 1_000..600_000.
     * See docs/ARCHITECTURE.md §9.3 for the hook contract.
     */
    timeout_ms?: number;
  };
}

export interface ShardDependency {
  name: string;
  namespace: string;
  version: string;
}

export interface ShardSchema {
  schema_version: number;
  values: Record<string, ValueDefinition>;
  groups: GroupDefinition[];
  modules: Record<string, ModuleDefinition>;
  signals: SignalDefinition[];
  frontmatter: Record<string, FrontmatterRule>;
  migrations: Migration[];
}

export interface ValueDefinition {
  type: 'string' | 'boolean' | 'number' | 'select' | 'multiselect' | 'list';
  required?: boolean;
  message: string;
  default?: unknown;
  options?: Array<{ value: string; label: string; description?: string }>;
  min?: number;
  max?: number;
  group: string;
  hint?: string;
  placeholder?: string;
}

export interface GroupDefinition {
  id: string;
  label: string;
  description?: string;
}

export interface ModuleDefinition {
  label: string;
  paths: string[];
  commands?: string[];
  agents?: string[];
  bases?: string[];
  removable: boolean;
}

export interface SignalDefinition {
  id: string;
  description: string;
  routes_to: string;
  core?: boolean;
  module?: string;
}

export interface FrontmatterRule {
  required?: string[];
  path_match?: string;
}

export interface Migration {
  from_version: string;
  changes: MigrationChange[];
}

export type MigrationChange =
  | { type: 'rename'; old: string; new: string }
  | { type: 'added'; key: string; default: unknown }
  | { type: 'removed'; key: string }
  | { type: 'type_changed'; key: string; from: string; to: string; transform: string };

export type ModuleSelections = Record<string, 'included' | 'excluded'>;

export interface ShardState {
  schema_version: number;
  shard: string;
  source: string;
  version: string;
  /**
   * sha256 of the downloaded tarball this install was built from.
   * Lets `shardmind update` detect retagged releases / source drift.
   */
  tarball_sha256: string;
  installed_at: string;
  updated_at: string;
  values_hash: string;
  modules: ModuleSelections;
  files: Record<string, FileState>;
  /**
   * Present iff this vault was installed via `github:owner/repo#<ref>`.
   * Records the ref name the user typed (branch / tag / SHA prefix).
   * `shardmind update` re-resolves this ref's HEAD on every run so the
   * vault tracks branch movement.
   *
   * Both `ref` and `resolvedSha` are optional and forward-compatible:
   * pre-#76 state.json (no ref fields) reads fine because `ShardState`
   * is the type of an existing-vault `state.json`, not a strict schema.
   */
  ref?: string;
  /**
   * 40-char hex commit SHA the ref resolved to at install / last
   * update. Distinct from `tarball_sha256` (content hash of the
   * downloaded archive, not the commit identity). Only present
   * alongside `ref`.
   */
  resolvedSha?: string;
}

export interface FileState {
  template: string | null;
  rendered_hash: string;
  ownership: 'managed' | 'modified' | 'user';
  iterator_key?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
}

export interface FrontmatterValidationResult {
  valid: boolean;
  noteType: string | null;
  missing: string[];
  extra: string[];
}

export interface ResolvedShard {
  namespace: string;
  name: string;
  /**
   * Display label for the resolved shard. Semver string for tag installs
   * (e.g. `"6.0.0"`); short SHA prefix (7 chars) for ref installs (e.g.
   * `"abc1234"`). Used for `Downloading owner/repo@<version>` messages
   * only — `state.version` is set from `manifest.version` (the value
   * inside `shard.yaml`) regardless of how the shard was addressed, so
   * semver-aware migrations keep working for ref installs too.
   */
  version: string;
  source: string;
  tarballUrl: string;
  /**
   * Present when the shard was addressed via `github:owner/repo#<ref>`.
   * `name` is the user-passed ref string (branch, tag, or SHA prefix);
   * `commit` is the 40-char hex SHA the ref resolved to at install time.
   * Recorded in `state.ref` + `state.resolvedSha` so a future
   * `shardmind update` can re-resolve the same ref and detect commit
   * movement on a tracked branch.
   */
  ref?: { name: string; commit: string };
}

export interface TempShard {
  tempDir: string;
  manifest: string;
  schema: string;
  /** sha256 of the tarball bytes as received, before extraction. */
  tarball_sha256: string;
  cleanup: () => Promise<void>;
}

export interface ModuleResolution {
  render: FileEntry[];
  copy: FileEntry[];
  skip: FileEntry[];
}

export interface FileEntry {
  sourcePath: string;
  outputPath: string;
  module: string | null;
  volatile: boolean;
  iterator: string | null;
}

export interface RenderedFile {
  outputPath: string;
  content: string;
  hash: string;
  volatile: boolean;
}

export interface RenderContext {
  values: Record<string, unknown>;
  included_modules: string[];
  shard: { name: string; version: string };
  install_date: string;
  year: string;
}

export interface DriftReport {
  managed: DriftEntry[];
  modified: DriftEntry[];
  volatile: DriftEntry[];
  missing: DriftEntry[];
  orphaned: string[];
}

export interface DriftEntry {
  path: string;
  template: string | null;
  renderedHash: string;
  actualHash: string | null;
  ownership: 'managed' | 'modified' | 'volatile';
}

export type MergeAction =
  | { type: 'skip'; reason: string }
  | { type: 'overwrite'; content: string }
  | { type: 'auto_merge'; content: string; stats: MergeStats }
  | { type: 'conflict'; result: MergeResult };

export interface MergeStats {
  linesUnchanged: number;
  linesAutoMerged: number;
}

/** Stats for a merge that may include conflicts (superset of MergeStats). */
export interface MergeStatsWithConflicts extends MergeStats {
  linesConflicted: number;
}

export interface MergeResult {
  content: string;
  conflicts: ConflictRegion[];
  stats: MergeStatsWithConflicts;
}

export interface ConflictRegion {
  lineStart: number;
  lineEnd: number;
  base: string;
  theirs: string;
  ours: string;
}

export interface MigrationResult {
  values: Record<string, unknown>;
  applied: MigrationChange[];
  warnings: string[];
}

export interface HookContext {
  vaultRoot: string;
  values: Record<string, unknown>;
  modules: ModuleSelections;
  shard: { name: string; version: string };
  previousVersion?: string;
  /**
   * True iff every user value equals its schema default (deep-equal,
   * with computed defaults resolved against the literal-default map
   * first). Hooks that modify *managed* files must no-op when this is
   * true — see Invariant 2 in `docs/SHARD-LAYOUT.md`. Hooks that create
   * *unmanaged* files (QMD indexes, MCP caches, etc.) may run
   * unconditionally; they don't affect the byte-equivalence invariant.
   */
  valuesAreDefaults: boolean;
  /**
   * Vault-relative paths of managed files newly added by this run.
   *
   * - Empty on a clean install (every file is new — the signal would be
   *   uninformative).
   * - Empty for a no-op update.
   * - Populated for an update with `UpdateAction.kind === 'add'` paths.
   *   `overwrite`, `auto_merge`, `restore_missing`, and conflict
   *   resolutions are excluded — those paths were already in state.files.
   *
   * Hooks restrict their writes to these paths by default per
   * Invariant 3 (post-update hooks are additive-only).
   */
  newFiles: string[];
  /**
   * Vault-relative paths of managed files removed by this run
   * (`UpdateAction.kind === 'delete'`). Empty on install. Hooks use
   * this to maintain external state — QMD collection refs, MCP
   * registrations — that referenced now-removed paths.
   */
  removedFiles: string[];
}

// ---------------------------------------------------------------------------
// Status command (`shardmind` root + `shardmind --verbose`).
// Produced by `core/status.ts`, rendered by `components/StatusView.tsx` and
// `components/VerboseView.tsx`. See docs/IMPLEMENTATION.md §4.14.
// ---------------------------------------------------------------------------

/**
 * Aggregated view of a vault's shard state, drift, update availability,
 * module selections, values validity, and — when verbose — frontmatter
 * health and environment diagnostics. Purely derived; no mutation.
 */
export interface StatusReport {
  manifest: ShardManifest;
  state: ShardState;
  /** Human-readable "3 weeks ago" for `state.installed_at` vs. report time. */
  installedAgo: string;
  /** Same for `updated_at`, or `null` if the shard has never been updated. */
  updatedAgo: string | null;
  drift: StatusDriftSummary;
  update: UpdateStatus;
  modules: StatusModuleSummary;
  values: StatusValuesSummary;
  /** Populated only when the builder is called with `verbose: true`. */
  frontmatter: StatusFrontmatterSummary | null;
  /** Populated only when the builder is called with `verbose: true`. */
  environment: StatusEnvironmentReport | null;
  /** Surface-worthy findings aggregated from every section. */
  warnings: StatusWarning[];
}

export interface StatusDriftSummary {
  managed: number;
  modified: number;
  volatile: number;
  missing: number;
  orphaned: number;
  /** Capped list of modified file paths for display; `modified` holds the true count. */
  modifiedPaths: string[];
  /**
   * Per-modified-file line-change counts, populated only when the builder
   * is called with `verbose: true`. Requires rendering the cached template
   * against current values (see `status.ts`), so we gate it behind verbose
   * to keep the quick-mode status run sub-second on large vaults.
   *
   * When populated, the array has the same length and order as
   * `modifiedPaths`. The whole field is `null` in quick mode; individual
   * entries are never `null` — a failed render or diff surfaces via the
   * `{ skipped: true, reason }` variant of `StatusModifiedChanges`.
   */
  modifiedChanges: StatusModifiedChanges[] | null;
  /** Capped list of orphan paths for verbose display. */
  orphanedPaths: string[];
  /** Capped list of missing file paths for verbose display. */
  missingPaths: string[];
  /** True if any `*Paths` list is truncated (caller can render "… and N more"). */
  truncated: boolean;
}

/**
 * Line-level change summary for a single modified file. Mirrors the
 * semantics of `diff --stat`: `linesAdded` counts lines present on disk
 * that aren't in the rendered base; `linesRemoved` counts lines in the
 * rendered base that aren't on disk. When the diff was skipped or
 * couldn't be computed, the `{ path, skipped: true, reason }` variant
 * is used instead — callers never need to handle `null` here.
 */
export type StatusModifiedChanges =
  | { path: string; linesAdded: number; linesRemoved: number }
  | { path: string; skipped: true; reason: 'no-template' | 'render-failed' | 'read-failed' };

/**
 * Update availability for the installed shard.
 *
 * - `up-to-date` — latest GitHub tag equals `state.version`.
 * - `available` — latest tag is different (typically newer) than installed.
 *   `cacheAge` tells the caller whether to trust the answer fully ('fresh')
 *   or note that it's from a previous cached answer ('stale'). We intentionally
 *   don't compare semver precedence — a downgrade to a re-tagged earlier
 *   release is still something the user should see.
 * - `unknown` — three sub-cases distinguished by `reason`:
 *     * `'no-network'` — we tried to fetch and the request failed AND no
 *       prior cache exists. Transient; retryable.
 *     * `'cache-miss'` — the update check was skipped (caller passed
 *       `skipUpdateCheck`) AND no prior cache had been primed. Distinct
 *       from `'no-network'` because the user didn't experience a failure,
 *       the query was intentionally deferred.
 *     * `'unsupported-source'` — the installed `state.source` is not a
 *       `github:` reference (e.g. a future private-registry shape).
 *       Permanent for the given vault until reinstall.
 */
export type UpdateStatus =
  | { kind: 'up-to-date'; current: string }
  | { kind: 'available'; current: string; latest: string; cacheAge: 'fresh' | 'stale' }
  | {
      kind: 'unknown';
      current: string;
      reason: 'no-network' | 'cache-miss' | 'unsupported-source';
    };

export interface StatusModuleSummary {
  /** Module IDs the user opted into at install time. */
  included: string[];
  /** Module IDs the user opted out of at install time. */
  excluded: string[];
}

export interface StatusValuesSummary {
  valid: boolean;
  /** Number of keys the schema declares. */
  total: number;
  /**
   * Keys zod rejected (missing required, wrong type, bad enum). Capped at
   * `MAX_INVALID_VALUE_KEYS` for display; `invalidCount` carries the true
   * count so warnings and verbose summaries don't under-report.
   */
  invalidKeys: string[];
  /** True pre-cap count of invalid keys; `>= invalidKeys.length`. */
  invalidCount: number;
  /** True when the values file itself couldn't be read or parsed. */
  fileMissing: boolean;
}

export interface StatusFrontmatterSummary {
  /** Count of managed `.md` files whose frontmatter passed validation. */
  valid: number;
  /** Count of managed `.md` files the validator inspected. */
  total: number;
  /**
   * Files with missing required keys; capped at `MAX_FRONTMATTER_ISSUES`
   * for display. `issueCount` carries the true pre-cap count so the
   * rendered "…and N more" reflects reality.
   */
  issues: StatusFrontmatterIssue[];
  /** True pre-cap count of files with issues; `>= issues.length`. */
  issueCount: number;
  /** True when the `issues` list has been truncated. */
  truncated: boolean;
}

export interface StatusFrontmatterIssue {
  path: string;
  missing: string[];
  noteType: string | null;
}

/**
 * Environment diagnostics surfaced under `--verbose`.
 *
 * `obsidianCliAvailable` is a best-effort PATH lookup: `true` if we found
 * an `obsidian` (or `Obsidian.exe` on Windows) binary on the user's PATH,
 * `false` otherwise. Never a hard warning — Obsidian is not required to
 * manage a shard, it's just nice to know.
 */
export interface StatusEnvironmentReport {
  nodeVersion: string;
  obsidianCliAvailable: boolean;
}

export interface StatusWarning {
  severity: 'info' | 'warning' | 'error';
  message: string;
  hint?: string;
}

import type { ErrorCode } from './errors.js';
export type { ErrorCode } from './errors.js';

export class ShardMindError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;

  constructor(message: string, code: ErrorCode, hint?: string) {
    super(message);
    this.name = 'ShardMindError';
    this.code = code;
    this.hint = hint;
  }
}

/**
 * Compile-time exhaustiveness helper. Placing this in a `default` branch
 * of a discriminated-union switch forces TypeScript to fail the build
 * if a new variant is added without a corresponding case.
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}
