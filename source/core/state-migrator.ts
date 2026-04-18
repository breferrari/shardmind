/**
 * state.json schema migration framework.
 *
 * `readState` delegates to `migrateState` whenever the version in the
 * on-disk file differs from the engine's current `STATE_SCHEMA_VERSION`.
 * Migration rules are encoded as an ordered chain: each step takes the
 * previous shape and returns the next, stopping when the version matches.
 *
 * v0.1 has no rules because no shape evolution has happened yet. The
 * framework is here so v0.2 (shard composition, multi-shard vaults,
 * etc.) can slot rules in without a breaking format change.
 *
 * Usage pattern when adding a migration:
 *
 *   const migrations: StateMigration[] = [
 *     { fromVersion: 1, toVersion: 2, apply: (s) => ({ ...s, shards: [...] }) },
 *   ];
 */

import type { ShardState } from '../runtime/types.js';

export interface StateMigration {
  fromVersion: number;
  toVersion: number;
  apply: (state: unknown) => unknown;
}

const migrations: StateMigration[] = [];

/**
 * Migrate an on-disk state object up to the target version.
 * Returns null if no migration chain exists from the current version
 * (caller should throw STATE_UNSUPPORTED_VERSION).
 */
export function migrateState(
  state: unknown,
  fromVersion: number,
  targetVersion: number,
): ShardState | null {
  let current: unknown = state;
  let version = fromVersion;

  while (version !== targetVersion) {
    const step = migrations.find((m) => m.fromVersion === version);
    if (!step) return null;
    current = step.apply(current);
    version = step.toVersion;
  }

  return current as ShardState;
}
