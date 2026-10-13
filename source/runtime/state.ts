/**
 * Read-only vault-state access for hook scripts and other downstream
 * tooling that imports from `shardmind/runtime`. Zero dependencies on
 * Ink, React, or Pastel so the bundled runtime stays tiny.
 *
 * The write path (readState/writeState/initShardDir/cacheTemplates/
 * cacheManifest) lives in `source/core/state.ts`. Keep the split
 * intentional: hooks must never mutate engine state.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ShardState } from './types.js';
import { ShardMindError } from './types.js';
import { SHARDMIND_DIR, STATE_FILE } from './vault-paths.js';
import { isEnoent } from './errno.js';
import {
  newerStateError,
  parseShardState,
  parseVaultState,
  shardStateOf,
  SINGLE_SHARD_SCHEMA_VERSION,
  STATE_CORRUPT_HINT,
  STATE_SCHEMA_VERSION,
} from './state-schema.js';

const MAX_DEPTH = 20;

/**
 * Find the current vault by walking up from `process.cwd()` looking
 * for a `.shardmind/` directory. Stops at the filesystem root or after
 * 20 hops, whichever comes first.
 *
 * Hook scripts rarely call this directly — {@link loadState} and
 * {@link loadValues} use it internally — but it's exported for tools
 * that need the absolute vault path (e.g., to write derived files).
 *
 * @returns Absolute path to the vault root.
 * @throws ShardMindError `VAULT_NOT_FOUND` if no `.shardmind/` is found in the ancestor chain.
 *
 * @example
 * ```ts
 * import { resolveVaultRoot } from 'shardmind/runtime';
 * import path from 'node:path';
 *
 * const vault = resolveVaultRoot();
 * const logPath = path.join(vault, 'hook.log');
 * ```
 */
export function resolveVaultRoot(): string {
  let dir = process.cwd();

  for (let i = 0; i < MAX_DEPTH; i++) {
    const shardmindDir = path.join(dir, SHARDMIND_DIR);
    if (fs.existsSync(shardmindDir) && fs.statSync(shardmindDir).isDirectory()) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new ShardMindError(
    'Not inside a ShardMind vault',
    'VAULT_NOT_FOUND',
    'Run this command from inside a vault initialized with shardmind install.',
  );
}

/**
 * Load the current vault's `state.json`.
 *
 * Returns `null` if the vault exists but has never been installed
 * (no state file). Throws on I/O errors or corrupted JSON.
 *
 * A vault can hold several shards (#395): the base first, then each
 * overlay. Without an argument this returns the base shard's state; with
 * `{ shard: '<namespace>/<name>' }`, that shard's, or `null` when the vault
 * holds no shard of that name. A schema-1 or -2 file returns as it is; a
 * shard of a schema-3 file returns as a one-shard state, at schema 2.
 *
 * @returns The parsed `ShardState`, or `null` if state.json is absent.
 * @throws ShardMindError `VAULT_NOT_FOUND` if no vault in the ancestor chain.
 * @throws ShardMindError `STATE_READ_FAILED` on I/O errors.
 * @throws ShardMindError `STATE_CORRUPT` if state.json is not valid JSON, or does not match the `ShardState` contract (#343).
 * @throws ShardMindError `STATE_UNSUPPORTED_VERSION` if a newer ShardMind wrote it (#368).
 *
 * @example
 * ```ts
 * import { loadState } from 'shardmind/runtime';
 *
 * const state = await loadState();
 * if (state) console.log(`Installed: ${state.shard}@${state.version}`);
 * ```
 */
export async function loadState(opts: { shard?: string } = {}): Promise<ShardState | null> {
  const vaultRoot = resolveVaultRoot();
  const filePath = path.join(vaultRoot, STATE_FILE);

  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf-8');
  } catch (err) {
    if (isEnoent(err)) return null;
    throw new ShardMindError(
      `Cannot read state.json: ${filePath}`,
      'STATE_READ_FAILED',
      err instanceof Error ? err.message : String(err),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ShardMindError(`Corrupt state.json: ${filePath}`, 'STATE_CORRUPT', STATE_CORRUPT_HINT);
  }
  // The version first, as the engine reads it (#368): a hook can run a
  // vendored runtime older than the engine that wrote this file, and a newer
  // state is refused as such, not misread as corrupt. An older one (v1) has
  // the current shape, so the contract check reads it as it is.
  const rawVersion = parsed && typeof parsed === 'object' ? (parsed as { schema_version?: unknown }).schema_version : undefined;
  if (typeof rawVersion !== 'number' || !Number.isInteger(rawVersion)) {
    throw new ShardMindError(
      `Corrupt state.json: ${filePath}: schema_version: missing, or not an integer`,
      'STATE_CORRUPT',
      STATE_CORRUPT_HINT,
    );
  }
  const version = rawVersion;
  if (version > STATE_SCHEMA_VERSION) throw newerStateError(version);
  // Below the first schema there is nothing to read it as: unsupported, as
  // the engine's readState answers (no migration reaches it).
  if (version < 1) {
    throw new ShardMindError(
      `Unsupported state schema_version: ${version}`,
      'STATE_UNSUPPORTED_VERSION',
      `This version of shardmind reads schema_version 1 to ${STATE_SCHEMA_VERSION}.`,
    );
  }
  // The same contract the engine reads with (#343). Schema 1 and 2 hold one
  // shard, the base; schema 3 lists them (#395).
  if (version < STATE_SCHEMA_VERSION) {
    const state = parseShardState(parsed, filePath);
    return opts.shard === undefined || state.shard === opts.shard ? state : null;
  }
  // A shard of a schema-3 file comes back as a one-shard state, at schema 2,
  // as the engine reads it: a flat `ShardState` never claims schema 3's shape.
  const { shards } = parseVaultState(parsed, filePath);
  const entry = opts.shard === undefined ? shards[0] : shards.find((s) => s.shard === opts.shard);
  return entry ? shardStateOf(entry, SINGLE_SHARD_SCHEMA_VERSION) : null;
}

/**
 * Return the IDs of modules that were `'included'` at install time.
 *
 * Convenience over {@link loadState} for the common "which features
 * are active" check inside a hook or utility script. Takes the same
 * `{ shard }` (#395): the base shard's modules by default.
 *
 * @returns Array of included module IDs. Empty if the vault has no state, or no such shard.
 *
 * @example
 * ```ts
 * import { getIncludedModules } from 'shardmind/runtime';
 *
 * if ((await getIncludedModules()).includes('brain')) {
 *   // run brain-specific setup
 * }
 * ```
 */
export async function getIncludedModules(opts: { shard?: string } = {}): Promise<string[]> {
  const state = await loadState(opts);
  if (!state) return [];

  return Object.entries(state.modules)
    .filter(([, status]) => status === 'included')
    .map(([id]) => id);
}

/**
 * `shard` when it names one of the vault's overlays (#396), not its base:
 * the reader then looks at the overlay's own files (`overlayValuesFile`,
 * `overlayDir`). Null for no name or the base shard's: read the base's.
 */
export async function overlayName(shard: string | undefined): Promise<string | null> {
  if (shard === undefined) return null;
  const base = await loadState();
  return base?.shard === shard ? null : shard;
}
