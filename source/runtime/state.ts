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
import { newerStateError, parseShardState, STATE_CORRUPT_HINT, STATE_SCHEMA_VERSION } from './state-schema.js';

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
export async function loadState(): Promise<ShardState | null> {
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
  const version = parsed && typeof parsed === 'object' ? (parsed as { schema_version?: unknown }).schema_version : undefined;
  if (!Number.isInteger(version)) {
    throw new ShardMindError(
      `Corrupt state.json: ${filePath}: schema_version: missing, or not an integer`,
      'STATE_CORRUPT',
      STATE_CORRUPT_HINT,
    );
  }
  if ((version as number) > STATE_SCHEMA_VERSION) throw newerStateError(version as number);
  // Below the first schema there is nothing to read it as: unsupported, as
  // the engine's readState answers (no migration reaches it).
  if ((version as number) < 1) {
    throw new ShardMindError(
      `Unsupported state schema_version: ${version as number}`,
      'STATE_UNSUPPORTED_VERSION',
      `This version of shardmind reads schema_version 1 to ${STATE_SCHEMA_VERSION}.`,
    );
  }
  // The same contract the engine reads with (#343).
  return parseShardState(parsed, filePath);
}

/**
 * Return the IDs of modules that were `'included'` at install time.
 *
 * Convenience over {@link loadState} for the common "which features
 * are active" check inside a hook or utility script.
 *
 * @returns Array of included module IDs. Empty if the vault has no state.
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
export async function getIncludedModules(): Promise<string[]> {
  const state = await loadState();
  if (!state) return [];

  return Object.entries(state.modules)
    .filter(([, status]) => status === 'included')
    .map(([id]) => id);
}
