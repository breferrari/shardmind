/**
 * state.json schema migration framework.
 *
 * `readState` delegates to `migrateState` whenever the version in the
 * on-disk file differs from the engine's current `STATE_SCHEMA_VERSION`.
 * Migration rules are encoded as an ordered chain: each step takes the
 * previous shape and returns the next, stopping when the version matches.
 *
 * The first real rule lands with the hook lifecycle split (#102): v2 adds
 * the optional `bootstrap_fingerprint` field. The migration is a pure
 * version bump — the field is optional, so an absent value is already the
 * correct "never bootstrapped under a fingerprint" state; we only stamp the
 * new `schema_version` so `readState`'s version loop terminates and
 * `writeState`'s exact-version guard accepts the result.
 *
 * Usage pattern when adding a migration:
 *
 *   const migrations: StateMigration[] = [
 *     { fromVersion: 2, toVersion: 3, apply: (s) => ({ ...s, shards: [...] }) },
 *   ];
 */

import type { ShardState } from '../runtime/types.js';

export interface StateMigration {
  fromVersion: number;
  toVersion: number;
  apply: (state: unknown) => unknown;
}

const migrations: StateMigration[] = [
  {
    fromVersion: 1,
    toVersion: 2,
    // Additive: `bootstrap_fingerprint` is optional. Stamp the version so the
    // migrate loop advances and the migrated object passes writeState's guard.
    apply: (state) => ({ ...(state as Record<string, unknown>), schema_version: 2 }),
  },
];

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
