/**
 * Schema migration runner.
 *
 * Applies declared migrations to `shard-values.yaml` when a shard version
 * changes. See docs/IMPLEMENTATION.md §4.10.
 *
 * Selection rule: a migration with `from_version = X` describes the shape
 * change that happened in version X. It must be applied when upgrading from
 * something strictly below X to something at-or-above X. So the filter is
 * `currentVersion < m.from_version <= targetVersion` (semver-aware). That
 * way a jump from 3.5.0 → 4.0.0 picks up a 3.7.0 migration exactly once,
 * and re-running the same update is a no-op.
 *
 * All four change types are best-effort: they warn rather than throw on
 * anomalies (missing keys, transform exceptions) so a single migration
 * quirk cannot block the upgrade. Real breakage surfaces later when zod
 * validates the migrated values against the new schema.
 */

import semver from 'semver';
import type {
  Migration,
  MigrationChange,
  MigrationResult,
} from '../runtime/types.js';
import { ShardMindError, assertNever } from '../runtime/types.js';

export function applyMigrations(
  values: Record<string, unknown>,
  currentVersion: string,
  targetVersion: string,
  migrations: Migration[],
): MigrationResult {
  assertSemver(currentVersion, 'currentVersion');
  assertSemver(targetVersion, 'targetVersion');

  const applicable = selectApplicable(migrations, currentVersion, targetVersion);

  const next: Record<string, unknown> = { ...values };
  const applied: MigrationChange[] = [];
  const warnings: string[] = [];

  for (const migration of applicable) {
    for (const change of migration.changes) {
      const outcome = applyChange(next, change, migration.from_version);
      if (outcome.applied) applied.push(change);
      if (outcome.warning) warnings.push(outcome.warning);
    }
  }

  return { values: next, applied, warnings };
}

export function selectApplicable(
  migrations: Migration[],
  currentVersion: string,
  targetVersion: string,
): Migration[] {
  return migrations
    .filter((m) => {
      if (!semver.valid(m.from_version)) return false;
      return (
        semver.gt(m.from_version, currentVersion) &&
        semver.lte(m.from_version, targetVersion)
      );
    })
    .sort((a, b) => semver.compare(a.from_version, b.from_version));
}

interface ChangeOutcome {
  applied: boolean;
  warning: string | null;
}

function applyChange(
  values: Record<string, unknown>,
  change: MigrationChange,
  fromVersion: string,
): ChangeOutcome {
  switch (change.type) {
    case 'rename': {
      if (!(change.old in values)) {
        return {
          applied: false,
          warning: `[${fromVersion}] rename: source key '${change.old}' not present; skipped.`,
        };
      }
      // Refuse to clobber an existing value at the target key. Silent
      // overwrite would lose user data that arrived through a separate
      // path (e.g. a concurrent migration chain or a manual edit).
      // Warn and skip; the old key stays put so nothing is destroyed.
      if (change.new in values) {
        return {
          applied: false,
          warning:
            `[${fromVersion}] rename: target key '${change.new}' already has a value; ` +
            `kept both. Remove one manually if the collision was unintended.`,
        };
      }
      values[change.new] = values[change.old];
      delete values[change.old];
      return { applied: true, warning: null };
    }
    case 'added': {
      if (change.key in values) {
        return { applied: false, warning: null };
      }
      values[change.key] = change.default;
      return { applied: true, warning: null };
    }
    case 'removed': {
      if (!(change.key in values)) {
        return { applied: false, warning: null };
      }
      delete values[change.key];
      return {
        applied: true,
        warning: `[${fromVersion}] removed: key '${change.key}' dropped from values.`,
      };
    }
    case 'type_changed': {
      if (!(change.key in values)) {
        return {
          applied: false,
          warning: `[${fromVersion}] type_changed: key '${change.key}' not present; skipped.`,
        };
      }
      const before = values[change.key];
      try {
        values[change.key] = evalTransform(change.transform, before);
        return { applied: true, warning: null };
      } catch (err) {
        return {
          applied: false,
          warning: `[${fromVersion}] type_changed: transform for '${change.key}' threw (${
            err instanceof Error ? err.message : String(err)
          }); kept original value.`,
        };
      }
    }
    default:
      return assertNever(change);
  }
}

/**
 * Evaluate a migration transform expression.
 *
 * `transform` is a JavaScript expression evaluated with `value` bound to
 * the pre-migration value of the key. Authors write expressions like
 * `value ? "enabled" : "disabled"` or `Number(value)`. We intentionally
 * use `Function(...)` over `eval` so the expression runs in a clean
 * scope, not the caller's lexical environment.
 *
 * Not a security sandbox. Shard authors can already ship arbitrary code
 * (hooks, templates), so the threat model is "buggy transform" not
 * "hostile transform." Consequence: do not call this with untrusted
 * migration specs.
 */
function evalTransform(expression: string, value: unknown): unknown {
  const fn = new Function('value', `return (${expression});`);
  return fn(value);
}

function assertSemver(version: string, label: string): void {
  if (!semver.valid(version)) {
    throw new ShardMindError(
      `Invalid semver ${label}: '${version}'`,
      'MIGRATION_INVALID_VERSION',
      'Migration selection requires both currentVersion and targetVersion to be valid semver strings.',
    );
  }
}
