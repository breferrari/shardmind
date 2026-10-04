/**
 * `--json` output — the machine-readable surface (#139 findings 3, 4, 5).
 *
 * Every `--json` run emits exactly one JSON document on stdout and nothing
 * else. That is the contract: a caller can `JSON.parse(stdout)` without
 * stripping banners, spinners, or ANSI. Human prose and this surface never
 * mix — a command is either rendering a TUI or emitting a document.
 *
 * Why stdout is written directly instead of rendered through Ink: Ink wraps
 * its output at the terminal width (80 columns when there is no TTY, which is
 * exactly the agent case), and a wrapped JSON document is a corrupt one. The
 * `--json` commands render `null` so Ink's frame is empty, and the document
 * goes out through `emitJson`.
 *
 * `schemaVersion` is the compatibility handle. Consumers should refuse a
 * `schemaVersion` they do not know rather than guess: additive fields will not
 * bump it, but a removal or a reshape will.
 */

import { describeError } from './bug-report.js';
import type {
  StatusEnvironmentReport,
  StatusFrontmatterSummary,
  StatusModuleSummary,
  StatusReport,
  StatusWarning,
  UpdateStatus,
} from '../runtime/types.js';
import { movedFromOf, type AdoptClassification, type AdoptPlan } from './adopt-planner.js';
import { emptyUpdatePlanCounts, type UpdateAction, type UpdatePlan } from './update-planner.js';

/** Bumped only on a breaking reshape, never for additive fields. */
export const JSON_SCHEMA_VERSION = 1;

export type JsonCommand = 'status' | 'adopt' | 'update' | 'validate';

export interface JsonErrorPayload {
  /** Stable `ErrorCode` when the failure was a `ShardMindError`, else null. */
  readonly code: string | null;
  readonly message: string;
  /** Remediation text; null when the error carried none. */
  readonly hint: string | null;
  /** The stack of a bug in shardmind (#225); null for a known or environment error. */
  readonly stack: string | null;
}

export interface JsonEnvelope {
  readonly schemaVersion: number;
  readonly command: JsonCommand;
  /** False when the command failed; pair with a non-zero exit code. */
  readonly ok: boolean;
  /** Present only when `ok` is false. */
  readonly error?: JsonErrorPayload;
  /** Command-specific body. Absent on failure. */
  readonly result?: unknown;
}

/**
 * The `--json` command a run is for, from its arguments: the first that is
 * not a flag, when it names one, else `status` (the root command). For a
 * crash report that has only `process.argv` to go on (#225).
 */
export function jsonCommandOf(argv: readonly string[]): JsonCommand {
  const first = argv.find((arg) => !arg.startsWith('-'));
  return first === 'adopt' || first === 'update' || first === 'validate' ? first : 'status';
}

export function jsonSuccess(command: JsonCommand, result: unknown): JsonEnvelope {
  return { schemaVersion: JSON_SCHEMA_VERSION, command, ok: true, result };
}

export function jsonFailure(command: JsonCommand, error: unknown): JsonEnvelope {
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    command,
    ok: false,
    error: toJsonError(error),
  };
}

function toJsonError(error: unknown): JsonErrorPayload {
  // The version only reaches the report link, which --json does not carry.
  const d = describeError(error, undefined);
  // `code` stays a registry code or null: an environment error's errno code
  // is in its message, and its hint says what to do.
  if (d.kind === 'bug') return { code: null, message: d.message, hint: null, stack: d.stack };
  return { code: d.kind === 'known' ? d.code : null, message: d.message, hint: d.hint, stack: null };
}

let emitted = false;

/**
 * Write the document and a single trailing newline. Pretty-printed on
 * purpose: these documents are read by humans debugging an agent at least as
 * often as by the agent, and the size difference is irrelevant next to a
 * tarball download.
 */
export function emitJson(
  envelope: JsonEnvelope,
  write: (chunk: string) => void = (chunk) => void process.stdout.write(chunk),
): void {
  write(`${JSON.stringify(envelope, null, 2)}\n`);
  emitted = true;
}

/**
 * True once this process has written a document. A crash after that (a late
 * rejection) must not append a second one: the caller parses stdout whole.
 */
export function jsonEmitted(): boolean {
  return emitted;
}

// ---------------------------------------------------------------------------
// Per-file plans (#139 finding 5)
//
// The summary counts a human reads (`99 exact / 33 customized / 13 missing`)
// never say WHICH files, and give no mine-vs-theirs signal — so an agent can't
// safely pick a bulk `--mode` and falls back to the most conservative one plus
// a hand audit. These serializers surface the per-file classification the
// planners already compute.
//
// Content buffers are deliberately NOT serialized. A plan document is a
// decision aid, not a transport for the vault: hashes identify, byte counts
// give magnitude, and anything needing the actual bytes should read the file.
// ---------------------------------------------------------------------------


export interface AdoptPlanFile {
  readonly path: string;
  /**
   * `matches`   — vault bytes already equal the shard's render.
   * `differs`   — the file exists in both and diverges; the only bucket a
   *               `--mode` actually decides.
   * `shard-only`— the shard would add it; the vault has nothing there.
   */
  readonly classification: 'matches' | 'differs' | 'shard-only';
  readonly shardHash: string;
  /** Present only for `differs` — the user's on-disk bytes. */
  readonly userHash?: string;
  readonly shardBytes?: number;
  readonly userBytes?: number;
  readonly binary?: boolean;
  readonly volatile: boolean;
  /** The old path the user's file sits at and moves from (`--from-version`, #179). */
  readonly movedFrom?: string;
}

function adoptFile(
  entry: AdoptClassification,
  classification: AdoptPlanFile['classification'],
): AdoptPlanFile {
  const base = {
    path: entry.path,
    classification,
    shardHash: entry.shardHash,
    volatile: entry.volatile,
    ...(movedFromOf(entry) === undefined ? {} : { movedFrom: movedFromOf(entry) }),
  };
  if (entry.kind === 'differs') {
    return {
      ...base,
      userHash: entry.userHash,
      shardBytes: entry.shardContent.byteLength,
      userBytes: entry.userContent.byteLength,
      binary: entry.isBinary,
    };
  }
  if (entry.kind === 'shard-only') {
    return { ...base, shardBytes: entry.shardContent.byteLength };
  }
  return base;
}

export interface AdoptPlanResult {
  readonly dryRun: boolean;
  /** The `--mode` the caller supplied, or null when none was given. */
  readonly mode: string | null;
  readonly counts: {
    readonly matches: number;
    readonly differs: number;
    readonly shardOnly: number;
    readonly totalShardFiles: number;
  };
  /** Every file, uncapped — sorted by path so diffs between runs are stable. */
  readonly files: readonly AdoptPlanFile[];
}

export function adoptPlanResult(
  plan: AdoptPlan,
  opts: { dryRun: boolean; mode: string | null },
): AdoptPlanResult {
  const files = [
    ...plan.matches.map((e) => adoptFile(e, 'matches')),
    ...plan.differs.map((e) => adoptFile(e, 'differs')),
    ...plan.shardOnly.map((e) => adoptFile(e, 'shard-only')),
  ].sort((a, b) => byPath(a.path, b.path));

  return {
    dryRun: opts.dryRun,
    mode: opts.mode,
    counts: {
      matches: plan.matches.length,
      differs: plan.differs.length,
      shardOnly: plan.shardOnly.length,
      totalShardFiles: plan.totalShardFiles,
    },
    files,
  };
}

export interface UpdatePlanFile {
  readonly path: string;
  /** The `UpdateAction` kind verbatim — `conflict`, `auto_merge`, `add`, … */
  readonly action: UpdateAction['kind'];
  /**
   * Hash of what the shard produces for this path, where the action produces
   * one. Named to match adopt's `shardHash` rather than the engine-internal
   * `renderedHash`/`theirsHash` pair: one vocabulary across the whole `--json`
   * surface, so a consumer doesn't learn two words for the same concept.
   */
  readonly shardHash?: string;
  /** Hash of the user's on-disk bytes at plan time (conflicts only). */
  readonly userHash?: string;
  /** `noop` only — why nothing happens. */
  readonly reason?: string;
  /** `conflict` only — the shard newly introduces a path the user already has. */
  readonly preexisting?: boolean;
  /** `conflict` only — a whole-file binary conflict, no text regions (#63). */
  readonly binary?: boolean;
  /** The path a rename migration moves this file from (#178). */
  readonly renamedFrom?: string;
}

function updateFile(action: UpdateAction): UpdatePlanFile {
  const base = {
    path: action.path,
    action: action.kind,
    ...(action.renamedFrom === undefined ? {} : { renamedFrom: action.renamedFrom }),
  };
  switch (action.kind) {
    case 'noop':
      return { ...base, reason: action.reason };
    case 'overwrite':
    case 'add':
    case 'restore_missing':
      return { ...base, shardHash: action.renderedHash };
    case 'auto_merge':
      // The new render — what the shard produces and state records — not the
      // merged bytes, which hold the user's lines (#150).
      return { ...base, shardHash: action.baselineHash };
    case 'conflict':
      return {
        ...base,
        shardHash: action.newContentHash,
        userHash: action.theirsHash,
        ...(action.preexisting === undefined ? {} : { preexisting: action.preexisting }),
        ...(action.result.binary ? { binary: true } : {}),
      };
    default:
      // skip_volatile / delete / keep_as_user carry only a path.
      return base;
  }
}

export interface UpdatePlanResult {
  readonly dryRun: boolean;
  readonly counts: UpdatePlan['counts'];
  readonly files: readonly UpdatePlanFile[];
}

export function updatePlanResult(
  plan: UpdatePlan,
  opts: { dryRun: boolean },
): UpdatePlanResult {
  return {
    dryRun: opts.dryRun,
    counts: plan.counts,
    files: plan.actions
      .map(updateFile)
      .sort((a, b) => byPath(a.path, b.path)),
  };
}

/** An up-to-date vault's plan: the same shape, nothing to do (#230). */
export function upToDatePlanResult(opts: { dryRun: boolean }): UpdatePlanResult {
  return { dryRun: opts.dryRun, counts: emptyUpdatePlanCounts(), files: [] };
}

// ---------------------------------------------------------------------------
// Status report (#139) — `shardmind --json`. Spec: ARCHITECTURE §10.3a.
//
// The read-side counterpart of the plans above: is this a managed vault,
// installed vs latest, and which files diverge. Built from a report produced
// with `uncapped: true`, so every list is whole. Relative times ("3 days
// ago") and per-file state bookkeeping are rendering and engine detail, and
// stay out.
// ---------------------------------------------------------------------------

export interface StatusModifiedFile {
  readonly path: string;
  /** `--verbose` only: lines on disk that the shard's render does not have. */
  readonly linesAdded?: number;
  /** `--verbose` only: lines of the shard's render missing on disk. */
  readonly linesRemoved?: number;
  /** `--verbose` only: why the line diff could not run for this file. */
  readonly diffSkipped?: 'no-template' | 'render-failed' | 'read-failed';
}

export type StatusResult =
  | { readonly installed: false }
  | {
      readonly installed: true;
      readonly shard: string;
      readonly source: string;
      readonly version: string;
      /** Only for a `github:owner/repo#<ref>` install. */
      readonly ref?: string;
      readonly resolvedSha?: string;
      readonly installedAt: string;
      readonly updatedAt: string;
      readonly update: UpdateStatus;
      /** Null when drift detection failed: nothing was checked (§10.3a). */
      readonly files: {
        readonly counts: {
          readonly managed: number;
          readonly modified: number;
          readonly volatile: number;
          readonly missing: number;
          readonly orphaned: number;
        };
        readonly modified: readonly StatusModifiedFile[];
        readonly missing: readonly string[];
        readonly orphaned: readonly string[];
      } | null;
      readonly modules: StatusModuleSummary;
      readonly values: {
        /** Null when the cached schema is unavailable, so nothing was validated. */
        readonly valid: boolean | null;
        /** Null with `valid`: without the schema the declared count is unknown. */
        readonly total: number | null;
        readonly invalidKeys: readonly string[];
        readonly fileMissing: boolean;
      };
      /** `--verbose` only; null otherwise. */
      readonly frontmatter: {
        readonly valid: number;
        readonly total: number;
        readonly issues: StatusFrontmatterSummary['issues'];
      } | null;
      /** `--verbose` only; null otherwise. */
      readonly environment: StatusEnvironmentReport | null;
      readonly warnings: readonly StatusWarning[];
    };

/** `report` is null when the directory has no `.shardmind/state.json`. */
export function statusResult(report: StatusReport | null): StatusResult {
  if (report === null) return { installed: false };
  const { state, drift, manifest } = report;
  // Drift lists modified and missing files in state.json key order; the
  // document promises path order (§10.3a). Line counts carry their own path.
  const changes = new Map((drift.modifiedChanges ?? []).map((c) => [c.path, c]));
  const modified = drift.modifiedPaths
    .map((p): StatusModifiedFile => {
      const change = changes.get(p);
      if (!change) return { path: p };
      return 'skipped' in change
        ? { path: p, diffSkipped: change.reason }
        : { path: p, linesAdded: change.linesAdded, linesRemoved: change.linesRemoved };
    })
    .sort((a, b) => byPath(a.path, b.path));
  return {
    installed: true,
    // state.json is read without field validation, so take the identity
    // and version the human header shows: the cached manifest, or one the
    // report synthesized from state with 'unknown' for anything unusable.
    shard: `${manifest.namespace}/${manifest.name}`,
    source: state.source,
    version: manifest.version,
    ...(state.ref === undefined ? {} : { ref: state.ref }),
    ...(state.resolvedSha === undefined ? {} : { resolvedSha: state.resolvedSha }),
    installedAt: state.installed_at,
    updatedAt: state.updated_at,
    update: report.update,
    files: drift.failed
      ? null
      : {
          counts: {
            managed: drift.managed,
            modified: drift.modified,
            volatile: drift.volatile,
            missing: drift.missing,
            orphaned: drift.orphaned,
          },
          modified,
          missing: [...drift.missingPaths].sort(byPath),
          orphaned: [...drift.orphanedPaths].sort(byPath),
        },
    modules: report.modules,
    values: {
      valid: report.values.checked ? report.values.valid : null,
      total: report.values.checked ? report.values.total : null,
      invalidKeys: [...report.values.invalidKeys].sort(byPath),
      fileMissing: report.values.fileMissing,
    },
    frontmatter: report.frontmatter
      ? {
          valid: report.frontmatter.valid,
          total: report.frontmatter.total,
          issues: [...report.frontmatter.issues].sort((a, b) => byPath(a.path, b.path)),
        }
      : null,
    environment: report.environment,
    warnings: report.warnings,
  };
}

/** Code-unit order: every `--json` list sorts by this, so runs diff cleanly. */
function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
