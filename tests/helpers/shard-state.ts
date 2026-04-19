/**
 * Shared ShardState factory for tests. Centralizes the boilerplate
 * so every test can build a valid state object with one call.
 */

import type { FileState, ShardState } from '../../source/runtime/types.js';

export function makeShardState(overrides: Partial<ShardState> = {}): ShardState {
  return {
    schema_version: 1,
    shard: 'test/shard',
    source: 'github:test/shard',
    version: '0.1.0',
    tarball_sha256: 'x'.repeat(64),
    installed_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
    values_hash: 'x'.repeat(64),
    modules: {},
    files: {},
    ...overrides,
  };
}

export function makeStateWithFiles(files: Record<string, FileState>): ShardState {
  return makeShardState({ files });
}
