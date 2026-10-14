/**
 * Pure aggregator that produces a `StatusReport` for the root command
 * (`shardmind`) and its `--verbose` variant.
 *
 * Design contract:
 *
 *   - Single entry point `buildStatusReport(vaultRoot, opts)`.
 *   - Returns `null` when the vault has no `.shardmind/state.json` — the
 *     "not in a shard-managed vault" signal. Commands that want to prompt
 *     the user to install render their own message in that case; this
 *     function never does I/O for side effects.
 *   - Quick mode (`verbose: false`) skips frontmatter lint and environment
 *     probes because both are O(managed files) — we want the common case
 *     to run in a few ms.
 *   - Failure in any subsystem degrades to a warning entry instead of
 *     throwing, unless the failure is in reading `state.json` itself
 *     (malformed state means we can't meaningfully say anything about
 *     the vault). This posture mirrors the update command's "never
 *     surprise the user with a stack trace on a read-only command".
 *
 * See docs/IMPLEMENTATION.md §4.14 for the full flow and the sections
 * in docs/ARCHITECTURE.md §10.2–10.3 for the rendered UX.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { diffLines } from 'diff';
import semver from 'semver';
import type {
  ShardManifest,
  ShardSchema,
  ShardState,
  StatusReport,
  StatusDriftSummary,
  StatusEnvironmentReport,
  StatusFrontmatterIssue,
  StatusFrontmatterSummary,
  StatusModifiedChanges,
  StatusModuleSummary,
  StatusValuesSummary,
  StatusWarning,
  UpdateStatus,
  DriftReport,
  DriftEntry,
  ModuleSelections,
  RenderContext,
  ShardEntry,
  ShardStatusReport,
} from '../runtime/types.js';
import { ShardMindError } from '../runtime/types.js';
import { shardStateOf } from '../runtime/state-schema.js';
import { readVaultState, shardLayout, SINGLE_SHARD_SCHEMA_VERSION, type ShardLayout } from './state.js';
import { parseManifest } from './manifest.js';
import { parseSchema, buildValuesValidator } from './schema.js';
import { detectDrift, foreignPathsOf, type DriftOptions } from './drift.js';
import { loadValuesYaml } from './values-io.js';
import { getLatestVersion } from './update-check.js';
import { mapConcurrent, pathExists } from './fs-utils.js';
import { errnoCode } from '../runtime/errno.js';
import { validateFrontmatter } from '../runtime/frontmatter.js';
import { renderString, buildRenderContext, itemForTemplate } from './renderer.js';
import { SHARD_MANIFEST_FILE, SHARD_SCHEMA_FILE, TEMPLATES_DIR } from '../runtime/vault-paths.js';

/** Shards reported at once (#406): each fans its own reads out, bounded. */
const SHARD_CONCURRENCY = 3;

/**
 * Upper bound on how many paths a single drift bucket surfaces by name.
 * The counts are always full; only the displayed lists are capped so a
 * vault with a few thousand orphans doesn't produce a page-long dump.
 */
const MAX_PATHS_PER_BUCKET = 20;

/** Cap on per-file frontmatter issue rows shown in verbose. */
const MAX_FRONTMATTER_ISSUES = 20;

/** Concurrency used for the verbose frontmatter walk. */
const FRONTMATTER_READ_CONCURRENCY = 16;

/**
 * Upper bound on the number of invalid value keys reported. A schema with
 * hundreds of truly-invalid keys is pathological; listing them all would
 * overflow the terminal width and isn't more actionable than a representative
 * sample.
 */
const MAX_INVALID_VALUE_KEYS = 20;

/**
 * Concurrency cap for the per-modified-file render + diff pass. Each file
 * rebuilds the Nunjucks render pipeline from a cached template; at 8 in
 * flight we saturate disk on a drifted 200-file vault without piling up
 * v8 heap pressure from parallel template environments.
 */
const MODIFIED_DIFF_CONCURRENCY = 8;

export interface BuildStatusReportOptions {
  /** Load verbose-only sections (frontmatter lint + environment probe). */
  verbose: boolean;
  /** Injectable clock for tests. Defaults to `Date.now()`. */
  now?: number;
  /**
   * Skip the network-backed update check entirely. Used by tests and by
   * paths that only need the local picture (e.g. CI-mode dashboards).
   */
  skipUpdateCheck?: boolean;
  /**
   * Lift every list cap (drift paths, invalid value keys, frontmatter
   * issues, and the per-modified-file diff), so `shardmind --json` lists
   * every file (#139). Counts are full either way; concurrency bounds stay.
   */
  uncapped?: boolean;
}

export async function buildStatusReport(
  vaultRoot: string,
  opts: BuildStatusReportOptions,
): Promise<StatusReport | null> {
  const now = opts.now ?? Date.now();

  // Status is ambient: a state.json that breaks its contract (#343) is
  // reported as a warning and read as it is, each field degrading below.
  const contractWarnings: StatusWarning[] = [];
  const vault = await readVaultState(vaultRoot, {
    onContractError: (err) => contractWarnings.push({ severity: 'error', message: err.message, hint: err.hint }),
  });
  if (!vault) return null;

  // Every shard of the vault, the base first (#406). A broken file read as
  // it is may hold anything in `shards`: an entry that is not an object, or
  // none, reads as an empty shard, each field degrading as before.
  const entries: unknown[] = Array.isArray(vault.shards) && vault.shards.length > 0 ? vault.shards : [{}];
  const states = entries.map((entry) => shardStateOf((isRecord(entry) ? entry : {}) as ShardEntry, SINGLE_SHARD_SCHEMA_VERSION));
  const layouts = states.map((state, i) => shardLayout(state.shard, i));
  const warningsOf = states.map((_, i) => (i === 0 ? contractWarnings : []));
  // Every update check starts now, in parallel: each may be a network call.
  // The disk work then runs a few shards at a time, each already fanning its
  // own reads out. No shard reads another's files, or any values file, as
  // its orphans. The environment is the vault's, probed once (verbose only).
  const updates = states.map((state, i) => startUpdateCheck(vaultRoot, state, layouts[i]!, opts, now, warningsOf[i]!));
  const [shards, environment] = await Promise.all([
    mapConcurrent(states.map((state, i) => ({ state, i })), SHARD_CONCURRENCY, ({ state, i }) => {
      const layout = layouts[i];
      if (!layout) return Promise.resolve(unnamedShardReport(state, now, warningsOf[i]!));
      return buildShardReport(vaultRoot, state, {
        opts,
        now,
        ...layout,
        foreign: foreignPathsOf(states, i),
        warnings: warningsOf[i]!,
        update: updates[i]!,
      });
    }),
    opts.verbose ? probeEnvironment() : Promise.resolve(null),
  ]);
  const base = shards[0]!;
  // An overlay's findings show at the top level too, prefixed with its name
  // in state.json, so two entries are always told apart.
  const overlayWarnings = shards
    .slice(1)
    .flatMap((shard, j) => shard.warnings.map((w) => ({ ...w, message: `${entryName(shard.state, j + 1)}: ${w.message}` })));
  return { ...base, environment, warnings: [...base.warnings, ...overlayWarnings], shards };
}

/** A shard's name as state.json gives it, or its place in the list when it gives none. */
function entryName(state: ShardState, index: number): string {
  return typeof state.shard === 'string' && state.shard !== '' ? state.shard : `shards[${index}]`;
}

/** The shard's update check, started at once (#406); `unknown` when skipped or there is no source to read. */
function startUpdateCheck(
  vaultRoot: string,
  state: ShardState,
  layout: ShardLayout | null,
  opts: BuildStatusReportOptions,
  now: number,
  warnings: StatusWarning[],
): Promise<UpdateStatus> {
  const currentVersion = currentVersionOf(state);
  if (opts.skipUpdateCheck || layout === null) {
    // Not network failure: the caller skipped the lookup (CI mode,
    // offline-first tests), or the shard has no files to keep a cache in.
    return Promise.resolve({ kind: 'unknown', current: currentVersion, reason: 'cache-miss' });
  }
  return resolveUpdate(state, currentVersion, vaultRoot, now, warnings, opts.verbose, layout.cacheDir);
}

/**
 * A state read past its contract check may hold anything, so state.version
 * may arrive as an empty string from a hand-edited state.json. Normalized
 * once, so every `UpdateStatus.current` and every equality check against
 * `latest_version` uses the same value. Mirrors the synthesizeManifest
 * fallback for `state.shard`.
 */
function currentVersionOf(state: ShardState): string {
  return (typeof state.version === 'string' ? state.version.trim() : '') || 'unknown';
}

/**
 * The block of an overlay whose name in state.json is not
 * `<namespace>/<name>` (#406): it has no files to find, so none is read
 * (never the base's), and one finding says why.
 */
function unnamedShardReport(state: ShardState, now: number, warnings: StatusWarning[]): ShardStatusReport {
  warnings.push({
    severity: 'error',
    message: `state.json lists a shard named ${JSON.stringify(state.shard)}, which is not <namespace>/<name>: its files cannot be found.`,
    hint: 'Restore .shardmind/state.json from version control.',
  });
  return {
    manifest: synthesizeManifest(state),
    state,
    installedAgo: relativeTimeAgo(state.installed_at, now),
    updatedAgo: null,
    drift: summarizeDrift(EMPTY_DRIFT, 0, true),
    update: { kind: 'unknown', current: currentVersionOf(state), reason: 'cache-miss' },
    modules: buildModuleSummary(state),
    values: { valid: false, total: 0, invalidKeys: [], invalidCount: 0, fileMissing: false, checked: false },
    frontmatter: null,
    warnings,
    valuesFile: null,
  };
}

interface ShardReportInput {
  opts: BuildStatusReportOptions;
  now: number;
  /** The shard's engine folder: `.shardmind/`, or an overlay's (#406). */
  cacheDir: string;
  /** The shard's values file: `shard-values.yaml`, or an overlay's. */
  valuesFile: string;
  /** Posix paths other shards own, never this shard's orphans. */
  foreign: ReadonlySet<string>;
  /** Findings already made for this shard (the base: the contract check's). */
  warnings: StatusWarning[];
  /** The shard's update check, started with every other shard's. */
  update: Promise<UpdateStatus>;
}

/** One shard's report (#406): what a one-shard vault's status has always held, from its own paths. */
async function buildShardReport(vaultRoot: string, state: ShardState, input: ShardReportInput): Promise<ShardStatusReport> {
  const { opts, now, cacheDir, valuesFile, foreign, warnings } = input;
  // A display cap, or none under `uncapped`.
  const cap = (display: number): number => (opts.uncapped ? Infinity : display);

  // The three loads are independent; drift and the update check need none.
  const [manifest, schema, rawValues] = await Promise.all([
    loadCachedManifest(path.join(vaultRoot, cacheDir, SHARD_MANIFEST_FILE), warnings),
    loadCachedSchema(path.join(vaultRoot, cacheDir, SHARD_SCHEMA_FILE), warnings),
    loadRawValues(path.join(vaultRoot, valuesFile), valuesFile),
  ]);

  const [detected, update, values] = await Promise.all([
    safeDetectDrift(vaultRoot, state, warnings, { cacheDir, foreign }),
    input.update,
    schema
      ? buildValuesSummary(rawValues, schema, cap(MAX_INVALID_VALUE_KEYS))
      : Promise.resolve<StatusValuesSummary>({
          valid: false,
          total: 0,
          invalidKeys: [],
          invalidCount: 0,
          fileMissing: rawValues === null,
          checked: false,
        }),
  ]);
  // A failed detection degrades to an empty report so every section still
  // renders, flagged `failed` so no reader mistakes it for a clean vault.
  const drift = detected ?? EMPTY_DRIFT;

  // manifest is load-bearing for display; if the cached file is gone, we
  // synthesize a minimal one from state so the status view can still render.
  const effectiveManifest: ShardManifest = manifest ?? synthesizeManifest(state);

  const driftSummary = summarizeDrift(drift, cap(MAX_PATHS_PER_BUCKET), detected === null);
  const modules: StatusModuleSummary = buildModuleSummary(state);

  // Verbose sections are independent — fan them out in parallel. Each has
  // its own IO budget (frontmatter: 16, modified diff: 8) so they don't
  // contend on the same handles. The environment is the vault's, probed once.
  const [modifiedChanges, frontmatter] = opts.verbose
    ? await Promise.all([
        driftSummary.modified > 0
          ? computeModifiedChanges(
              vaultRoot,
              drift.modified.slice(0, cap(MAX_PATHS_PER_BUCKET)),
              effectiveManifest,
              rawValues,
              state.modules && typeof state.modules === 'object' ? state.modules : {},
              path.join(cacheDir, TEMPLATES_DIR),
            )
          : Promise.resolve(null),
        // The lint walks drift's files; after a failed detection it would
        // check nothing and report a clean 0/0.
        schema && detected
          ? lintFrontmatter(vaultRoot, detected, schema, cap(MAX_FRONTMATTER_ISSUES))
          : Promise.resolve(null),
      ])
    : [null, null];

  if (modifiedChanges) {
    driftSummary.modifiedChanges = modifiedChanges;
  }

  emitSectionWarnings({
    warnings,
    state,
    driftSummary,
    update,
    values,
    frontmatter,
    valuesFile,
  });

  return {
    manifest: effectiveManifest,
    state,
    installedAgo: relativeTimeAgo(state.installed_at, now),
    updatedAgo:
      state.updated_at && state.updated_at !== state.installed_at
        ? relativeTimeAgo(state.updated_at, now)
        : null,
    drift: driftSummary,
    update,
    modules,
    values,
    frontmatter,
    warnings,
    valuesFile,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}


// ---------------------------------------------------------------------------
// Manifest / schema / drift loaders (isolated so a failure in one doesn't
// cascade into the others).
// ---------------------------------------------------------------------------

async function loadCachedManifest(
  filePath: string,
  warnings: StatusWarning[],
): Promise<ShardManifest | null> {
  try {
    return await parseManifest(filePath, {
      installedCopy: true,
      // Informational: nothing to fix in the vault, but an update to a shard
      // release that still declares it is refused until the author migrates.
      onRemovedSlot: () =>
        warnings.push({
          severity: 'info',
          message: 'The shard release this vault was installed from declares a post-install hook, which ShardMind 1.0 removed.',
          hint: 'HOOK_SLOT_REMOVED: nothing to change in this vault. An update installs once the shard publishes a release without post-install.',
        }),
    });
  } catch (err) {
    warnings.push({
      severity: 'warning',
      message: 'Cached shard manifest could not be loaded.',
      hint:
        err instanceof ShardMindError
          ? err.hint ?? `${err.code}: ${err.message}`
          : 'The status view falls back to state.json for identity.',
    });
    return null;
  }
}

async function loadCachedSchema(
  filePath: string,
  warnings: StatusWarning[],
): Promise<ShardSchema | null> {
  try {
    return await parseSchema(filePath);
  } catch (err) {
    warnings.push({
      severity: 'warning',
      message: 'Cached shard schema could not be loaded.',
      hint:
        err instanceof ShardMindError
          ? err.hint ?? `${err.code}: ${err.message}`
          : 'Values validity and frontmatter lint are unavailable this run.',
    });
    return null;
  }
}

async function safeDetectDrift(
  vaultRoot: string,
  state: ShardState,
  warnings: StatusWarning[],
  driftOpts: DriftOptions,
): Promise<DriftReport | null> {
  try {
    return await detectDrift(vaultRoot, state, driftOpts);
  } catch (err) {
    warnings.push({
      severity: 'error',
      message: 'Drift detection failed.',
      hint: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

const EMPTY_DRIFT: DriftReport = { managed: [], modified: [], volatile: [], missing: [], orphaned: [] };

// ---------------------------------------------------------------------------
// Summary builders.
// ---------------------------------------------------------------------------

function summarizeDrift(drift: DriftReport, limit: number, failed: boolean): StatusDriftSummary {
  const modifiedPaths = drift.modified.map(e => e.path);
  const orphanedPaths = drift.orphaned;
  const missingPaths = drift.missing.map(e => e.path);

  const truncated =
    modifiedPaths.length > limit ||
    orphanedPaths.length > limit ||
    missingPaths.length > limit;

  return {
    managed: drift.managed.length,
    modified: drift.modified.length,
    volatile: drift.volatile.length,
    missing: drift.missing.length,
    orphaned: drift.orphaned.length,
    modifiedPaths: modifiedPaths.slice(0, limit),
    modifiedChanges: null,
    orphanedPaths: orphanedPaths.slice(0, limit),
    missingPaths: missingPaths.slice(0, limit),
    truncated,
    failed,
  };
}

function buildModuleSummary(state: ShardState): StatusModuleSummary {
  const included: string[] = [];
  const excluded: string[] = [];
  // A hand-broken state.json can hold anything here (#343): no modules then.
  const modules = state.modules && typeof state.modules === 'object' ? state.modules : {};
  for (const [id, status] of Object.entries(modules).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (status === 'included') included.push(id);
    else excluded.push(id);
  }
  return { included, excluded };
}

/**
 * Load and parse `shard-values.yaml` once, shared between values validation
 * and the per-modified-file render+diff pass. Returns `null` when the file
 * can't be read or isn't a YAML mapping — callers degrade to "missing"
 * behavior rather than re-try.
 */
async function loadRawValues(
  filePath: string,
  label: string,
): Promise<Record<string, unknown> | null> {
  try {
    return await loadValuesYaml(filePath, {
      errors: { readFailed: 'VALUES_READ_FAILED', invalid: 'VALUES_INVALID' },
      label,
    });
  } catch {
    return null;
  }
}

function buildValuesSummary(
  rawValues: Record<string, unknown> | null,
  schema: ShardSchema,
  limit: number,
): StatusValuesSummary {
  if (rawValues === null) {
    return {
      valid: false,
      total: totalValuesCount(schema),
      invalidKeys: [],
      invalidCount: 0,
      fileMissing: true,
      checked: true,
    };
  }

  const validator = buildValuesValidator(schema);
  const result = validator.safeParse(rawValues);
  if (result.success) {
    return {
      valid: true,
      total: totalValuesCount(schema),
      invalidKeys: [],
      invalidCount: 0,
      fileMissing: false,
      checked: true,
    };
  }

  // Collect top-level keys zod flagged. Nested paths are rare in our shape
  // but we still surface them with dot-joined keys for clarity. The true
  // count is retained in `invalidCount`; `invalidKeys` is the display cap.
  const allInvalid = uniq(
    result.error.issues.map(issue =>
      issue.path.length === 0 ? '(root)' : issue.path.join('.'),
    ),
  );
  return {
    valid: false,
    total: totalValuesCount(schema),
    invalidKeys: allInvalid.slice(0, limit),
    invalidCount: allInvalid.length,
    fileMissing: false,
    checked: true,
  };
}

function totalValuesCount(schema: ShardSchema): number {
  return Object.keys(schema.values).length;
}

function uniq<T>(xs: readonly T[]): T[] {
  return Array.from(new Set(xs));
}

// ---------------------------------------------------------------------------
// Update check.
// ---------------------------------------------------------------------------

async function resolveUpdate(
  state: ShardState,
  currentVersion: string,
  vaultRoot: string,
  now: number,
  warnings: StatusWarning[],
  verbose: boolean,
  cacheDir: string,
): Promise<UpdateStatus> {
  const result = await getLatestVersion(vaultRoot, state.source, now, cacheDir);

  // A corrupt cache entry was self-healed on the way in. The user's next
  // run sees a clean cache; we flag it once here for verbose runs so a
  // user investigating flakiness can see their cache was broken before
  // the heal. Non-verbose runs don't surface it — the fix already happened.
  if (result.cacheHealed && verbose) {
    warnings.push({
      severity: 'info',
      message: 'Update-check cache was corrupt and has been reset.',
      hint: 'UPDATE_CHECK_CACHE_CORRUPT: healed automatically; no action needed.',
    });
  }

  if (result.kind === 'unknown') {
    return {
      kind: 'unknown',
      current: currentVersion,
      reason: result.reason,
    };
  }

  // Use semver equality where possible so `1.0.0` == `1.0.0+build.2`
  // (build metadata is non-precedence per semver 2.0.0 §10). Fall back
  // to strict string compare for non-semver version strings (custom
  // tag schemes, pre-release tags without normalization).
  const isSame =
    semver.valid(result.latest_version) !== null && semver.valid(currentVersion) !== null
      ? semver.eq(result.latest_version, currentVersion)
      : result.latest_version === currentVersion;
  if (isSame) {
    return { kind: 'up-to-date', current: currentVersion };
  }

  return {
    kind: 'available',
    current: currentVersion,
    latest: result.latest_version,
    cacheAge: result.kind === 'fresh' ? 'fresh' : 'stale',
  };
}

// ---------------------------------------------------------------------------
// Verbose-only: frontmatter lint.
// ---------------------------------------------------------------------------

/**
 * Walk every managed `.md` file in drift's `managed` + `modified` buckets and
 * run the runtime frontmatter validator against each. Volatile files aren't
 * checked because they're explicitly user-owned and the shard asserts no
 * ownership. Missing files can't be checked (they're not on disk).
 */
async function lintFrontmatter(
  vaultRoot: string,
  drift: DriftReport,
  schema: ShardSchema,
  limit: number,
): Promise<StatusFrontmatterSummary> {
  const candidates = [...drift.managed, ...drift.modified].filter(e =>
    e.path.toLowerCase().endsWith('.md'),
  );

  if (candidates.length === 0) {
    return { valid: 0, total: 0, issues: [], issueCount: 0, truncated: false };
  }

  const results = await mapConcurrent(
    candidates,
    FRONTMATTER_READ_CONCURRENCY,
    async entry => {
      try {
        const content = await fsp.readFile(path.join(vaultRoot, entry.path), 'utf-8');
        return { path: entry.path, result: validateFrontmatter(entry.path, content, schema) };
      } catch (err) {
        if (errnoCode(err) === 'ENOENT') return null;
        // Permission or other read error: treat as if missing — the drift
        // report would have flagged it too; we just don't double-warn here.
        return null;
      }
    },
  );

  const issues: StatusFrontmatterIssue[] = [];
  let valid = 0;
  let total = 0;

  for (const row of results) {
    if (!row) continue;
    total++;
    if (row.result.valid) {
      valid++;
    } else if (row.result.missing.length > 0) {
      issues.push({
        path: row.path,
        missing: row.result.missing,
        noteType: row.result.noteType,
      });
    }
  }

  const issueCount = issues.length;
  const truncated = issueCount > limit;
  return {
    valid,
    total,
    issues: issues.slice(0, limit),
    issueCount,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Verbose-only: per-modified-file line-change counts.
// ---------------------------------------------------------------------------

/**
 * For each drifted `modified` file, render the cached template with the
 * current `shard-values.yaml` + module selections, then 2-way diff the
 * rendered base against the actual file content. Returns an array aligned
 * 1:1 with the capped `modifiedPaths` list.
 *
 * Every failure mode (no cached template, render throw, file read error)
 * surfaces as a `skipped` variant so the UI can print the path plus a
 * dim "diff unavailable" tag instead of blanking out. The rendered base
 * is discarded immediately — we only need the line counts.
 *
 * Verbose-only because each file costs one template render (~5–20 ms for
 * typical shards) plus one line-diff pass; running this unconditionally
 * would regress the common-case quick-status wall-clock target.
 */
async function computeModifiedChanges(
  vaultRoot: string,
  entries: readonly DriftEntry[],
  manifest: ShardManifest,
  rawValues: Record<string, unknown> | null,
  selections: ModuleSelections,
  templatesDir: string,
): Promise<StatusModifiedChanges[]> {
  if (rawValues === null) {
    // Without values we can't render; surface a skipped entry per file so
    // the user knows the counts are unavailable rather than silently absent.
    return entries.map(e => ({
      path: e.path,
      skipped: true as const,
      reason: 'render-failed' as const,
    }));
  }

  const renderCtx = buildRenderContext(manifest, rawValues, selections, undefined, vaultRoot);
  return mapConcurrent(entries, MODIFIED_DIFF_CONCURRENCY, entry =>
    renderAndDiffEntry(vaultRoot, entry, renderCtx, templatesDir),
  );
}

/**
 * Single-entry pipeline: read cached template → render against current
 * values → read actual file → count line diff. Each failure step returns
 * the matching `skipped` variant so the caller can render "diff
 * unavailable" without a try/catch ladder in the mapping callback.
 */
async function renderAndDiffEntry(
  vaultRoot: string,
  entry: DriftEntry,
  renderCtx: RenderContext,
  templatesDir: string,
): Promise<StatusModifiedChanges> {
  if (!entry.template) {
    return { path: entry.path, skipped: true, reason: 'no-template' };
  }

  const templatePath = path.join(vaultRoot, templatesDir, entry.template);

  let templateSource: string;
  try {
    templateSource = await fsp.readFile(templatePath, 'utf-8');
  } catch {
    return { path: entry.path, skipped: true, reason: 'no-template' };
  }

  let base: string;
  try {
    // An `_each` file renders with its own item, as the install did (#233).
    const item = itemForTemplate(entry.template, renderCtx.values, entry.path);
    base = renderString(
      templateSource,
      item === undefined ? renderCtx : { ...renderCtx, item } as typeof renderCtx,
      entry.path,
    );
  } catch {
    return { path: entry.path, skipped: true, reason: 'render-failed' };
  }

  let actual: string;
  try {
    actual = await fsp.readFile(path.join(vaultRoot, entry.path), 'utf-8');
  } catch {
    return { path: entry.path, skipped: true, reason: 'read-failed' };
  }

  const { linesAdded, linesRemoved } = countLineChanges(base, actual);
  return { path: entry.path, linesAdded, linesRemoved };
}

/**
 * 2-way line count via the `diff` package. Returns the number of lines
 * present in `actual` but not in `base` (added) and the number present in
 * `base` but not in `actual` (removed). Semantics match `git diff --stat`.
 *
 * Both inputs are normalized before diffing so byte-level-but-logically-
 * equivalent edits don't inflate the counts:
 *   - CRLF → LF: a template stored LF but re-saved CRLF by a Windows
 *     editor would otherwise register every line as changed.
 *   - Leading UTF-8 BOM: editors like Notepad prepend a BOM on save; a
 *     BOM-only shift would otherwise cause the entire file to diff.
 */
function countLineChanges(
  base: string,
  actual: string,
): { linesAdded: number; linesRemoved: number } {
  const normalize = (s: string): string =>
    (s.startsWith('\uFEFF') ? s.slice(1) : s).replace(/\r\n/g, '\n');
  const hunks = diffLines(normalize(base), normalize(actual));
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const hunk of hunks) {
    if (hunk.added) linesAdded += hunk.count ?? 0;
    else if (hunk.removed) linesRemoved += hunk.count ?? 0;
  }
  return { linesAdded, linesRemoved };
}

// ---------------------------------------------------------------------------
// Verbose-only: environment probe.
// ---------------------------------------------------------------------------

/**
 * Report the current Node.js version and a best-effort "is the Obsidian
 * CLI on PATH?" answer. Both are metadata only — no part of ShardMind
 * requires either to function; the section exists so a user troubleshooting
 * a vault can see their environment at a glance.
 *
 * The PATH lookup is a pure filesystem scan (no subprocess spawn): spawn
 * would pay the startup cost of another binary and needs careful argument
 * escaping, whereas statting a handful of directories is free.
 */
async function probeEnvironment(): Promise<StatusEnvironmentReport> {
  return {
    nodeVersion: process.version,
    obsidianCliAvailable: await detectObsidianCli(),
  };
}

async function detectObsidianCli(): Promise<boolean> {
  const pathEnv = process.env['PATH'] ?? '';
  if (!pathEnv) return false;

  const isWindows = process.platform === 'win32';
  const candidates = isWindows ? ['obsidian.exe', 'Obsidian.exe'] : ['obsidian'];

  // Parallelize stat calls across every PATH entry × candidate binary. A
  // typical PATH has 15–30 entries; a serial loop pays latency per entry
  // even though each stat is independent. `some(Boolean)` is the correct
  // reducer — we only need one hit to answer yes.
  const checks = pathEnv
    .split(path.delimiter)
    .filter(dir => dir.length > 0)
    .flatMap(dir => candidates.map(name => pathExists(path.join(dir, name))));

  const results = await Promise.all(checks);
  return results.some(Boolean);
}

// ---------------------------------------------------------------------------
// Warning aggregation.
// ---------------------------------------------------------------------------

interface WarningInputs {
  warnings: StatusWarning[];
  state: ShardState;
  driftSummary: StatusDriftSummary;
  update: UpdateStatus;
  values: StatusValuesSummary;
  frontmatter: StatusFrontmatterSummary | null;
  /** The shard's values file, named in its findings (#406). */
  valuesFile: string;
}

function emitSectionWarnings(input: WarningInputs): void {
  const { warnings, driftSummary, update, values, frontmatter, valuesFile } = input;

  if (update.kind === 'available') {
    warnings.push({
      severity: 'info',
      message: `v${update.latest} available${update.cacheAge === 'stale' ? ' (cached, network offline)' : ''}`,
      hint: `Run 'shardmind update' to upgrade from v${update.current}.`,
    });
  }

  if (driftSummary.modified > 0) {
    warnings.push({
      severity: 'warning',
      message: `${driftSummary.modified} managed file${driftSummary.modified === 1 ? '' : 's'} modified by you.`,
      hint: 'Your edits are preserved on update via three-way merge.',
    });
  }

  if (driftSummary.missing > 0) {
    warnings.push({
      severity: 'warning',
      message: `${driftSummary.missing} managed file${driftSummary.missing === 1 ? '' : 's'} missing from disk.`,
      hint: "Run 'shardmind update' to restore missing files from the shard.",
    });
  }

  if (values.fileMissing) {
    warnings.push({
      severity: 'error',
      message: `${valuesFile} is missing or unreadable.`,
      hint: `Reinstall the shard or restore ${valuesFile} from version control.`,
    });
  } else if (!values.valid && values.invalidCount > 0) {
    warnings.push({
      severity: 'warning',
      message: `${valuesFile} has ${values.invalidCount} invalid key${values.invalidCount === 1 ? '' : 's'}.`,
      hint: `Check: ${values.invalidKeys.slice(0, 5).join(', ')}${values.invalidCount > 5 ? ', …' : ''}.`,
    });
  }

  if (frontmatter && frontmatter.issueCount > 0) {
    warnings.push({
      severity: 'warning',
      message: `${frontmatter.issueCount} note${frontmatter.issueCount === 1 ? '' : 's'} missing required frontmatter.`,
      hint: 'Run shardmind --verbose for the full list.',
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/**
 * Synthesize a minimal `ShardManifest` from `ShardState` for the rare case
 * where the cached `.shardmind/shard.yaml` is gone but `state.json` still
 * describes the install. Lets status render a header instead of bailing out
 * because one file went missing.
 *
 * Defends against a `state.shard` that is null, empty, whitespace-only, or
 * missing a `/` separator. `ShardState.shard` is typed as `string` but
 * Status reads past the contract check (#343), so a hand-
 * edited or partially-corrupt state.json can land here with malformed
 * values. Every parse path collapses to `unknown/unknown` rather than
 * rendering whitespace or crashing on `.split` of null.
 */
function synthesizeManifest(state: ShardState): ShardManifest {
  const [namespace, name] = parseShardIdentifier(state.shard);
  return {
    apiVersion: 'v1',
    namespace,
    name,
    // `||` (not `??`) on purpose: a state.json with `"version": ""` is as
    // broken as one with `"version": null`, and we want both to render as
    // "unknown" rather than leave the header badge blank.
    version: state.version || 'unknown',
    dependencies: [],
    hooks: {},
  };
}

/**
 * Always returns a `[namespace, name]` tuple where both halves are
 * non-empty, trimmed strings. Any input that doesn't yield a usable
 * identifier — non-string, empty, whitespace-only, or missing the slash
 * separator — collapses to `['unknown', ...]` rather than producing a
 * blank segment that would render as whitespace in the Header.
 */
function parseShardIdentifier(raw: unknown): [string, string] {
  if (typeof raw !== 'string') return ['unknown', 'unknown'];
  const parts = raw
    .split('/')
    .map(s => s.trim())
    .filter(s => s.length > 0);
  if (parts.length === 0) return ['unknown', 'unknown'];
  if (parts.length === 1) return [parts[0]!, 'unknown'];
  return [parts[0]!, parts[1]!];
}

/**
 * Relative-time formatter matching the spec examples ("3 weeks ago",
 * "just now", "over a year ago"). Unit-tested at bucket edges.
 *
 * Future-dated inputs (clock skew) collapse to "just now" rather than
 * producing nonsense like "-3 minutes ago". Same posture as update-check's
 * clock-skew handling.
 */
export function relativeTimeAgo(fromIso: string, nowMs: number): string {
  const fromMs = Date.parse(fromIso);
  if (!Number.isFinite(fromMs)) return 'unknown';

  const diffMs = nowMs - fromMs;
  if (diffMs < 60_000) return 'just now';

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;

  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;

  const years = Math.floor(days / 365);
  if (years === 1) return 'over a year ago';
  return `${years} years ago`;
}

