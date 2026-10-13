/**
 * Which paths an overlay may not write (R2, #396): `ownedPaths`. Spec:
 * docs/IMPLEMENTATION.md §4.30 step 10.4, SHARD-LAYOUT §Overlay shards.
 */

import { describe, it, expect } from 'vitest';
import { ownedPaths } from '../../source/core/flows/add.js';
import type { ShardEntry, VaultState } from '../../source/runtime/types.js';
import { makeShardState, makeFileState } from '../helpers/index.js';

const entry = (shard: string, files: string[]): ShardEntry => {
  const { schema_version: _v, ...rest } = makeShardState({
    shard,
    files: Object.fromEntries(files.map((f) => [f, makeFileState()])),
  });
  return rest;
};

const vault: VaultState = {
  schema_version: 3,
  shards: [entry('acme/base', ['Home.md', 'brain/North Star.md']), entry('acme/research', ['research/Index.md'])],
};

describe('ownedPaths (#396)', () => {
  it("names each shard's files with their owner, keyed case-folded", () => {
    const owned = ownedPaths(vault, 'acme/new');
    expect(owned.get('home.md')).toBe('acme/base');
    expect(owned.get('brain/north star.md')).toBe('acme/base');
    expect(owned.get('research/index.md')).toBe('acme/research');
  });

  it("owns every values file: the base's, each overlay's, and the one the added shard will write", () => {
    const owned = ownedPaths(vault, 'acme/new');
    expect(owned.get('shard-values.yaml')).toContain('acme/base');
    expect(owned.get('shard-values.acme.research.yaml')).toContain('acme/research');
    expect(owned.get('shard-values.acme.new.yaml')).toContain('acme/new');
  });

  it('folds NFD names to NFC, as macOS stores them', () => {
    const nfd = 'Café.md';
    const owned = ownedPaths({ schema_version: 3, shards: [entry('acme/base', [nfd])] }, 'acme/new');
    expect(owned.get('café.md')).toBe('acme/base');
  });
});
