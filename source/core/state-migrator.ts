/**
 * state.json schema migration framework.
 *
 * `readVaultState` (`state.ts`) delegates to `migrateState` whenever the
 * version in the on-disk file differs from the engine's current
 * `STATE_SCHEMA_VERSION`, after `canMigrate` says a chain reaches it.
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
 * The second (#395) turns schema 2's one shard into schema 3's `shards[0]`.
 * The caller checks the stored shape before migrating; each rule turns a
 * valid shape into a valid one, which its unit test pins, so the result is
 * not checked again.
 */

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
  {
    fromVersion: 2,
    toVersion: 3,
    // Composition (#395): the one shard becomes `shards[0]`, with every field
    // it had but `schema_version`, fields this engine does not know included.
    apply: (state) => {
      const { schema_version: _version, ...entry } = state as Record<string, unknown>;
      return { schema_version: 3, shards: [entry] };
    },
  },
];

/** The rules that lead from `fromVersion` to `targetVersion`, in order, or null when none do. */
function chainOf(fromVersion: number, targetVersion: number): StateMigration[] | null {
  const chain: StateMigration[] = [];
  let version = fromVersion;
  while (version !== targetVersion) {
    const step = migrations.find((m) => m.fromVersion === version);
    if (!step) return null;
    chain.push(step);
    version = step.toVersion;
  }
  return chain;
}

/** Whether a chain of rules leads from `fromVersion` to `targetVersion`. */
export function canMigrate(fromVersion: number, targetVersion: number): boolean {
  return chainOf(fromVersion, targetVersion) !== null;
}

/**
 * Migrate an on-disk state object up to the target version.
 * Returns null if no migration chain exists from the current version
 * (caller should throw STATE_UNSUPPORTED_VERSION; `canMigrate` asks first).
 */
export function migrateState(state: unknown, fromVersion: number, targetVersion: number): unknown {
  const chain = chainOf(fromVersion, targetVersion);
  return chain ? chain.reduce<unknown>((current, step) => step.apply(current), state) : null;
}
