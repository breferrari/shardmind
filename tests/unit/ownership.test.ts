/**
 * One owner per file on update (R2, #407): `ownedPaths` with `except`, the
 * shard being updated, whose own files and values file are its to write.
 * Spec: docs/IMPLEMENTATION.md §4.30 step 6.6; ARCHITECTURE §10.5.
 */

import { describe, it, expect } from 'vitest';
import { ownedPaths, ownerOf, ownedConflicts } from '../../source/core/ownership.js';
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

describe('ownedPaths with except (#407)', () => {
  it("leaves out the updated overlay's own files and values file, keeps the base's", () => {
    const owned = ownedPaths(vault, { except: 1 });
    expect(ownerOf('research/Index.md', owned)).toBeNull();
    expect(ownerOf('shard-values.acme.research.yaml', owned)).toBeNull();
    expect(ownerOf('Home.md', owned)).toBe('acme/base');
    expect(ownerOf('shard-values.yaml', owned)).toContain('acme/base');
  });

  it("leaves out the updated base's own files and values file, keeps the overlay's", () => {
    const owned = ownedPaths(vault, { except: 0 });
    expect(ownerOf('Home.md', owned)).toBeNull();
    expect(ownerOf('brain/North Star.md', owned)).toBeNull();
    expect(ownerOf('shard-values.yaml', owned)).toBeNull();
    expect(ownerOf('research/Index.md', owned)).toBe('acme/research');
    expect(ownerOf('RESEARCH/index.md', owned)).toBe('acme/research');
    expect(ownerOf('shard-values.acme.research.yaml', owned)).toContain('acme/research');
  });

  it('still keeps .shardmind/ for the engine', () => {
    expect(ownerOf('.shardmind/shards/acme/research/shard.yaml', ownedPaths(vault, { except: 1 }))).toContain('ShardMind');
  });

  it("counts the other shard's folders and files above a path", () => {
    const owned = ownedPaths(vault, { except: 0 });
    // A file at a folder the overlay keeps files in would move them aside.
    expect(ownerOf('research', owned)).toContain('acme/research');
    // A path under the overlay's file needs that file to be a folder.
    expect(ownerOf('research/Index.md/x.md', owned)).toContain('acme/research');
  });
});

describe('ownedConflicts (#407)', () => {
  it('names every owned path with its owner, in the order given', () => {
    const owned = ownedPaths(vault, { except: 1 });
    expect(ownedConflicts(owned, ['research/New.md', 'home.md', 'research/Index.md', '.shardmind/x'])).toEqual([
      { rel: 'home.md', owner: 'acme/base' },
      { rel: '.shardmind/x', owner: 'ShardMind (the engine folder)' },
    ]);
  });
});
