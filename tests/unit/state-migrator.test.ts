import { describe, it, expect } from 'vitest';
import { migrateState } from '../../source/core/state-migrator.js';

describe('migrateState', () => {
  it('returns null when no migration rule exists for the source version', () => {
    const result = migrateState({ schema_version: 99 }, 99, 1);
    expect(result).toBeNull();
  });

  it('returns null for future versions with no downward migration', () => {
    // v0.1 has no rules registered; anything other than trivial cases returns null
    const result = migrateState({ schema_version: 2 }, 2, 1);
    expect(result).toBeNull();
  });

  // When v0.2 lands with its first migration, add a test that exercises
  // the 1 → 2 chain here (input shape v1, expected output shape v2).
});
