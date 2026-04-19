/**
 * Shared factories for building ShardState / FileState objects in tests.
 * Centralizes the boilerplate so tests describe only the fields that matter
 * to the scenario under test, not the surrounding required scaffolding.
 */

import type { FileState, ShardState } from '../../source/runtime/types.js';

const PLACEHOLDER_HASH = 'x'.repeat(64);

export function makeShardState(overrides: Partial<ShardState> = {}): ShardState {
  return {
    schema_version: 1,
    shard: 'test/shard',
    source: 'github:test/shard',
    version: '0.1.0',
    tarball_sha256: PLACEHOLDER_HASH,
    installed_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
    values_hash: PLACEHOLDER_HASH,
    modules: {},
    files: {},
    ...overrides,
  };
}

/** Shorthand for drift/state tests that only care about the files map. */
export function makeStateWithFiles(files: Record<string, FileState>): ShardState {
  return makeShardState({ files });
}

export function makeFileState(overrides: Partial<FileState> = {}): FileState {
  return {
    template: 'templates/unspecified.md.njk',
    rendered_hash: PLACEHOLDER_HASH,
    ownership: 'managed',
    ...overrides,
  };
}
