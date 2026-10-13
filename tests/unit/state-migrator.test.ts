import { describe, it, expect } from 'vitest';
import { canMigrate, migrateState } from '../../source/core/state-migrator.js';
import type { ShardState } from '../../source/runtime/types.js';

describe('canMigrate (#395)', () => {
  it('follows the chain from each supported version to the newest', () => {
    expect(canMigrate(1, 3)).toBe(true);
    expect(canMigrate(2, 3)).toBe(true);
    expect(canMigrate(3, 3)).toBe(true);
  });

  it('is false where no rule starts, and never goes down', () => {
    expect(canMigrate(0, 3)).toBe(false);
    expect(canMigrate(3, 2)).toBe(false);
    expect(canMigrate(4, 3)).toBe(false);
  });

  it('agrees with migrateState', () => {
    for (const [from, to] of [[0, 3], [1, 3], [2, 3], [3, 2]] as const) {
      expect(canMigrate(from, to)).toBe(migrateState({ schema_version: from }, from, to) !== null);
    }
  });
});

describe('migrateState', () => {
  it('returns null when no migration rule exists for the source version', () => {
    const result = migrateState({ schema_version: 99 }, 99, 2);
    expect(result).toBeNull();
  });

  it('returns null for future versions with no downward migration', () => {
    // No 2 → 1 rule is registered; downgrading is unsupported.
    const result = migrateState({ schema_version: 2 }, 2, 1);
    expect(result).toBeNull();
  });

  describe('v1 → v2 (bootstrap_fingerprint, #102)', () => {
    it('stamps schema_version 2 and preserves all existing fields', () => {
      const v1 = {
        schema_version: 1,
        shard: 'acme/obs-mind',
        source: 'github:acme/obs-mind',
        version: '6.0.0',
        tarball_sha256: 'a'.repeat(64),
        installed_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        values_hash: 'b'.repeat(64),
        modules: { core: 'included' as const },
        files: { 'Home.md': { template: null, rendered_hash: 'c'.repeat(64), ownership: 'managed' as const } },
      };
      const migrated = migrateState(v1, 1, 2) as ShardState | null;
      expect(migrated).not.toBeNull();
      expect(migrated!.schema_version).toBe(2);
      // Every prior field survives untouched.
      expect(migrated!.shard).toBe('acme/obs-mind');
      expect(migrated!.version).toBe('6.0.0');
      expect(migrated!.modules).toEqual({ core: 'included' });
      expect(migrated!.files['Home.md']).toEqual(v1.files['Home.md']);
    });

    it('leaves bootstrap_fingerprint absent (additive optional field)', () => {
      const migrated = migrateState({ schema_version: 1, files: {} }, 1, 2) as ShardState | null;
      expect(migrated!.schema_version).toBe(2);
      expect(migrated!.bootstrap_fingerprint).toBeUndefined();
    });

    it('does not mutate the input object', () => {
      const v1 = { schema_version: 1, files: {} };
      migrateState(v1, 1, 2);
      expect(v1.schema_version).toBe(1);
    });
  });
});
