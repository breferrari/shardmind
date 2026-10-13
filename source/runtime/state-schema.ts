/**
 * The `state.json` contract, checked on every read (#343). Spec:
 * docs/IMPLEMENTATION.md §4.7 (The persisted contract).
 *
 * `ShardState` and `FileState` (`types.ts`) are the file's contract; these
 * schemas say the same thing at runtime. Shared by the engine's `readState`
 * and the runtime's `loadState`, which is why it lives here: `runtime/`
 * cannot import from `core/`. A field neither knows is kept, so an additive
 * field from a newer minor version survives a read and the next write.
 */

import { z } from 'zod';
import type { ShardEntry, ShardState, VaultState } from './types.js';
import { ShardMindError } from './types.js';

const FileStateSchema = z.looseObject({
  template: z.string().nullable(),
  rendered_hash: z.string(),
  ownership: z.enum(['managed', 'modified']),
  iterator_key: z.string().optional(),
});

const ShardEntryShape = {
  shard: z.string(),
  source: z.string(),
  version: z.string(),
  tarball_sha256: z.string(),
  installed_at: z.string(),
  updated_at: z.string(),
  values_hash: z.string(),
  modules: z.record(z.string(), z.enum(['included', 'excluded'])),
  files: z.record(z.string(), FileStateSchema),
  ref: z.string().optional(),
  resolvedSha: z.string().optional(),
  bootstrap_fingerprint: z.string().optional(),
  bootstrap_pending: z.literal(true).optional(),
};

const ShardStateSchema = z.looseObject({ schema_version: z.number().int(), ...ShardEntryShape });

/**
 * Schema 3 (#395): the vault's shards, the base first. No two name the same
 * shard: each is addressed by its `shard`, by update and by `loadState`.
 */
const VaultStateSchema = z
  .looseObject({
    schema_version: z.number().int(),
    shards: z.array(z.looseObject(ShardEntryShape)).min(1),
  })
  .superRefine((state, ctx) => {
    const seen = new Set<string>();
    state.shards.forEach((entry, i) => {
      if (seen.has(entry.shard)) {
        ctx.addIssue({ code: 'custom', path: ['shards', i, 'shard'], message: `${entry.shard} is listed twice` });
      }
      seen.add(entry.shard);
    });
  });

/**
 * The newest `state.json` schema this engine reads. Bumped 1 → 2 with the
 * hook lifecycle split (#102): v2 adds the optional `bootstrap_fingerprint`
 * field. Bumped 2 → 3 with composition (#395): v3 lists the vault's shards
 * (`VaultState`). `state-migrator.ts` forward-migrates each older version.
 */
export const STATE_SCHEMA_VERSION = 3;

/**
 * The schema a vault with one shard is written at (#395): it stays at 2,
 * byte for byte, and only the first overlay rewrites the file at 3. The
 * install / update / adopt executors stamp it on the `ShardState` they write.
 */
export const SINGLE_SHARD_SCHEMA_VERSION = 2;

/** A state.json from a newer ShardMind (#344): its schema version, and the newest this engine reads. */
export interface NewerState {
  stateSchemaVersion: number;
  supportedSchemaVersion: number;
}

/**
 * `STATE_UNSUPPORTED_VERSION` for a state.json above this engine's schema:
 * a newer ShardMind wrote it. The two numbers ride on the error, read back
 * by `newerStateOf` from the code and those fields. Not a subclass:
 * `ShardMindError`'s `instanceof` is a brand check every subclass inherits,
 * so `instanceof` could not tell a subclass from its parent.
 */
export function newerStateError(stateSchemaVersion: number): ShardMindError {
  const err = new ShardMindError(
    `This vault's state.json was written by a newer ShardMind (state schema ${stateSchemaVersion}; this ShardMind reads up to ${STATE_SCHEMA_VERSION})`,
    'STATE_UNSUPPORTED_VERSION',
    'Upgrade ShardMind to manage it: npm install -g shardmind@latest',
  );
  const newer: NewerState = { stateSchemaVersion, supportedSchemaVersion: STATE_SCHEMA_VERSION };
  return Object.assign(err, newer);
}

/** The two schema numbers of a `newerStateError`, or null for any other error. */
export function newerStateOf(err: unknown): NewerState | null {
  if (!(err instanceof ShardMindError) || err.code !== 'STATE_UNSUPPORTED_VERSION') return null;
  const { stateSchemaVersion, supportedSchemaVersion } = err as Partial<NewerState>;
  if (typeof stateSchemaVersion !== 'number' || typeof supportedSchemaVersion !== 'number') return null;
  return { stateSchemaVersion, supportedSchemaVersion };
}

/** What to do about a `STATE_CORRUPT` state.json, wherever it is found. */
export const STATE_CORRUPT_HINT =
  'Restore .shardmind/state.json from version control, or reinstall over it with `shardmind install <shard> . --force`, which answers the values again.';

/**
 * `value` as a `ShardState`, or `STATE_CORRUPT` naming the first field that
 * does not match. The return type keeps the schema honest: a required field
 * added to `ShardState` and not here fails typecheck.
 */
export function parseShardState(value: unknown, filePath: string): ShardState {
  const result = ShardStateSchema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0]!;
  throw new ShardMindError(
    `Corrupt state.json: ${filePath}: ${fieldPath(issue.path)}: ${issue.message}`,
    'STATE_CORRUPT',
    STATE_CORRUPT_HINT,
  );
}

/**
 * `value` as a `VaultState` (#395), or `STATE_CORRUPT` naming the first
 * field that does not match, by its path inside `shards`
 * (`shards[1].files["Home.md"].ownership`).
 */
export function parseVaultState(value: unknown, filePath: string): VaultState {
  const result = VaultStateSchema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0]!;
  throw new ShardMindError(
    `Corrupt state.json: ${filePath}: ${fieldPath(issue.path)}: ${issue.message}`,
    'STATE_CORRUPT',
    STATE_CORRUPT_HINT,
  );
}

/**
 * A shard's entry as a `ShardState` at `schemaVersion` (#395): what the
 * one-shard readers return, and what a one-shard vault is written as.
 * `schema_version` stays first, so the written bytes keep their order, and
 * an entry's own stray `schema_version` (unknown fields are kept) is
 * dropped, never left to override it.
 */
export function shardStateOf(entry: ShardEntry, schemaVersion: number): ShardState {
  return { schema_version: schemaVersion, ...withoutSchemaVersion(entry) };
}

/** An entry without a stray `schema_version` of its own (#395): the file carries it once. */
export function withoutSchemaVersion(entry: ShardEntry): ShardEntry {
  const { schema_version: _stray, ...rest } = entry as ShardEntry & { schema_version?: unknown };
  return rest;
}

/**
 * The only shard of a vault, for a command that handles one (#395). A vault
 * with several is `STATE_UNSUPPORTED_VERSION`: never read as its base alone,
 * whose next write would drop the overlays. Not a `newerStateError`: no newer
 * ShardMind wrote it, so it carries no schema numbers.
 */
export function soleShard(state: VaultState): ShardEntry {
  if (state.shards.length > 1) {
    throw new ShardMindError(
      `This vault holds several shards (${state.shards.length}); this command handles a vault with one`,
      'STATE_UNSUPPORTED_VERSION',
      'Manage it with a ShardMind that updates each shard of a composed vault; this one updates a vault with one shard.',
    );
  }
  return state.shards[0]!;
}

/**
 * `shards[1].files["Home.md"].ownership`: a list index in brackets, a vault
 * path or module id (the key under a `files` or `modules` field) quoted in
 * brackets, a field name after a dot.
 */
function fieldPath(segments: readonly PropertyKey[]): string {
  let out = '';
  let keyedNext = false;
  for (const segment of segments) {
    const keyed = keyedNext;
    keyedNext = false;
    if (typeof segment === 'number') out += `[${segment}]`;
    else if (keyed) out += `[${JSON.stringify(String(segment))}]`;
    else {
      out += out === '' ? String(segment) : `.${String(segment)}`;
      keyedNext = segment === 'files' || segment === 'modules';
    }
  }
  return out === '' ? '(root)' : out;
}
