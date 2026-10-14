/**
 * Adopt stays single-shard (#406): a vault holding several shards is a
 * managed vault, refused like any other. Spec: ARCHITECTURE §10.5a.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { assertAdoptable } from '../../source/core/adopt-executor.js';
import { writeVaultState } from '../../source/core/state.js';
import type { ShardEntry } from '../../source/runtime/types.js';
import { makeShardState } from '../helpers/index.js';

let vault: string;

beforeEach(async () => {
  vault = path.join(os.tmpdir(), `shardmind-adopt-composed-${crypto.randomUUID()}`);
  await fsp.mkdir(vault, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(vault, { recursive: true, force: true });
});

const entry = (shard: string): ShardEntry => {
  const { schema_version: _v, ...rest } = makeShardState({ shard });
  return rest;
};

describe('adopt into a vault holding several shards (#406)', () => {
  it('is refused as a managed vault, with ADOPT_EXISTING_INSTALL', async () => {
    await writeVaultState(vault, { schema_version: 3, shards: [entry('acme/base'), entry('acme/research')] });
    await expect(assertAdoptable(vault)).rejects.toMatchObject({ code: 'ADOPT_EXISTING_INSTALL' });
  });
});
