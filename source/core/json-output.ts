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

import { ShardMindError } from '../runtime/types.js';
import type { AdoptClassification, AdoptPlan } from './adopt-planner.js';
import type { UpdateAction, UpdatePlan } from './update-planner.js';

/** Bumped only on a breaking reshape, never for additive fields. */
export const JSON_SCHEMA_VERSION = 1;

export type JsonCommand = 'status' | 'adopt' | 'update';

export interface JsonErrorPayload {
  /** Stable `ErrorCode` when the failure was a `ShardMindError`, else null. */
  readonly code: string | null;
  readonly message: string;
  /** Remediation text; null when the error carried none. */
  readonly hint: string | null;
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
  if (error instanceof ShardMindError) {
    return {
      code: error.code,
      message: error.message,
      hint: error.hint ?? null,
    };
  }
  if (error instanceof Error) {
    return { code: null, message: error.message, hint: null };
  }
  return { code: null, message: String(error), hint: null };
}

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
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

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
}

function updateFile(action: UpdateAction): UpdatePlanFile {
  const base = { path: action.path, action: action.kind };
  switch (action.kind) {
    case 'noop':
      return { ...base, reason: action.reason };
    case 'overwrite':
    case 'auto_merge':
    case 'add':
    case 'restore_missing':
      return { ...base, shardHash: action.renderedHash };
    case 'conflict':
      return {
        ...base,
        shardHash: action.newContentHash,
        userHash: action.theirsHash,
        ...(action.preexisting === undefined ? {} : { preexisting: action.preexisting }),
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
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}
