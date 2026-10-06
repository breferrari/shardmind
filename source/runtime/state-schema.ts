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
import type { ShardState } from './types.js';
import { ShardMindError } from './types.js';

const FileStateSchema = z.looseObject({
  template: z.string().nullable(),
  rendered_hash: z.string(),
  ownership: z.enum(['managed', 'modified']),
  iterator_key: z.string().optional(),
});

const ShardStateSchema = z.looseObject({
  schema_version: z.number().int(),
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
});

/**
 * Current on-disk `state.json` schema version. Bumped 1 → 2 with the hook
 * lifecycle split (#102): v2 adds the optional `bootstrap_fingerprint`
 * field. The bump is additive — `state-migrator.ts` forward-migrates v1
 * with a field-supplying rule. Exported so the install / update / adopt
 * executors stamp the same version they read.
 */
export const STATE_SCHEMA_VERSION = 2;

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

/** `files["Home.md"].ownership`: a vault path or module id in brackets, a field name after a dot. */
function fieldPath(segments: readonly PropertyKey[]): string {
  let out = '';
  segments.forEach((segment, i) => {
    const keyed = i === 1 && (segments[0] === 'files' || segments[0] === 'modules');
    if (typeof segment === 'number') out += `[${segment}]`;
    else if (keyed) out += `[${JSON.stringify(String(segment))}]`;
    else out += out === '' ? String(segment) : `.${String(segment)}`;
  });
  return out === '' ? '(root)' : out;
}
