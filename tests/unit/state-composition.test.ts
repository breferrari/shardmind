/**
 * state.json schema 3: several shards in one vault (#395). Spec:
 * docs/ARCHITECTURE.md §8.3, docs/IMPLEMENTATION.md §4.7 (Several shards).
 *
 * A one-shard vault stays at schema 2 byte for byte; the engine reads every
 * vault as a list of shards; a command that handles one shard refuses a vault
 * with several; the runtime's loadState reads the base, or a named shard.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  newerStateOf,
  readState,
  readVaultState,
  writeState,
  writeVaultState,
  SINGLE_SHARD_SCHEMA_VERSION,
  STATE_SCHEMA_VERSION,
} from '../../source/core/state.js';
import { migrateState } from '../../source/core/state-migrator.js';
import { getIncludedModules, loadState } from '../../source/runtime/state.js';
import type { ShardEntry, VaultState } from '../../source/runtime/types.js';
import { makeShardState } from '../helpers/index.js';

let vault: string;
const statePath = (): string => path.join(vault, '.shardmind', 'state.json');

beforeEach(async () => {
  vault = path.join(os.tmpdir(), `shardmind-state-composition-${crypto.randomUUID()}`);
  await fsp.mkdir(path.join(vault, '.shardmind'), { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(vault, { recursive: true, force: true });
});

/** A schema-2 state as plain JSON, with a file. */
const v2 = (shard = 'acme/base'): Record<string, unknown> =>
  JSON.parse(
    JSON.stringify(
      makeShardState({
        shard,
        source: `github:${shard}`,
        files: { 'Home.md': { template: 'Home.md.njk', rendered_hash: 'a'.repeat(64), ownership: 'managed' } },
      }),
    ),
  ) as Record<string, unknown>;

/** `v2` as a `shards[]` entry: everything but `schema_version`. */
const entry = (shard = 'acme/base'): ShardEntry => {
  const { schema_version: _drop, ...rest } = v2(shard);
  return rest as unknown as ShardEntry;
};

async function writeRaw(value: unknown, text?: string): Promise<void> {
  await fsp.writeFile(statePath(), text ?? JSON.stringify(value, null, 2) + '\n', 'utf-8');
}

const composed = (): VaultState => ({ schema_version: 3, shards: [entry('acme/base'), entry('acme/overlay')] });

describe('schema numbers (#395)', () => {
  it('reads up to schema 3, and writes one shard at schema 2', () => {
    expect(STATE_SCHEMA_VERSION).toBe(3);
    expect(SINGLE_SHARD_SCHEMA_VERSION).toBe(2);
  });
});

describe('the v2 → v3 rule (#395)', () => {
  it('moves every field but schema_version into shards[0], unknown ones included', () => {
    const state: Record<string, unknown> = { ...v2(), future_field: { a: 1 } };
    const migrated = migrateState(state, 2, 3) as unknown as VaultState & Record<string, unknown>;
    const { schema_version: _drop, ...rest } = state;
    expect(migrated).toEqual({ schema_version: 3, shards: [rest] });
    expect(Object.keys(migrated)).toEqual(['schema_version', 'shards']);
  });

  it('chains from v1', () => {
    const migrated = migrateState({ ...v2(), schema_version: 1 }, 1, 3) as unknown as VaultState;
    expect(migrated.schema_version).toBe(3);
    expect(migrated.shards).toHaveLength(1);
    expect(migrated.shards[0]!.shard).toBe('acme/base');
  });

  it('does not mutate its input', () => {
    const state = v2();
    migrateState(state, 2, 3);
    expect(state['schema_version']).toBe(2);
    expect(state).not.toHaveProperty('shards');
  });
});

describe('readVaultState / writeVaultState (#395)', () => {
  it('reads a schema-2 vault as one shard', async () => {
    await writeRaw(v2());
    const state = await readVaultState(vault);
    expect(state).toEqual({ schema_version: 3, shards: [entry()] });
  });

  it('reads a v1 vault as one shard', async () => {
    await writeRaw({ ...v2(), schema_version: 1 });
    expect((await readVaultState(vault))!.shards[0]!.shard).toBe('acme/base');
  });

  it('returns null when state.json does not exist', async () => {
    expect(await readVaultState(vault)).toBeNull();
  });

  it('writes one shard back at schema 2, byte for byte', async () => {
    const original = JSON.stringify({ ...v2(), future_field: true }, null, 2) + '\n';
    await writeRaw(null, original);
    await writeVaultState(vault, (await readVaultState(vault))!);
    expect(await fsp.readFile(statePath(), 'utf-8')).toBe(original);
  });

  it('writes several shards at schema 3, and reads them back in order', async () => {
    await writeVaultState(vault, composed());
    const raw = JSON.parse(await fsp.readFile(statePath(), 'utf-8')) as VaultState;
    expect(raw.schema_version).toBe(3);
    expect(raw.shards.map((s) => s.shard)).toEqual(['acme/base', 'acme/overlay']);
    expect(await readVaultState(vault)).toEqual(composed());
  });

  it('refuses to write a vault state that breaks the contract, and writes nothing', async () => {
    const bad = { schema_version: 3, shards: [] } as VaultState;
    await expect(writeVaultState(vault, bad)).rejects.toMatchObject({ code: 'STATE_CORRUPT' });
    await expect(fsp.access(statePath())).rejects.toThrow();
  });

  it('keeps an unknown field of an entry through a read and a write', async () => {
    const state = composed();
    (state.shards[1] as unknown as Record<string, unknown>)['future_field'] = 7;
    await writeVaultState(vault, state);
    await writeVaultState(vault, (await readVaultState(vault))!);
    const raw = JSON.parse(await fsp.readFile(statePath(), 'utf-8')) as { shards: Record<string, unknown>[] };
    expect(raw.shards[1]!['future_field']).toBe(7);
  });

  it('reads a CRLF-saved schema-3 file', async () => {
    await writeRaw(null, JSON.stringify(composed(), null, 2).replace(/\n/g, '\r\n') + '\r\n');
    expect((await readVaultState(vault))!.shards).toHaveLength(2);
  });
});

describe('a schema-3 file that breaks the contract is STATE_CORRUPT, naming the field (#395)', () => {
  const corrupt = async (value: unknown): Promise<string> => {
    await writeRaw(value);
    const err = await readVaultState(vault).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'STATE_CORRUPT' });
    return (err as Error).message;
  };

  it('a missing shards list', async () => {
    expect(await corrupt({ schema_version: 3 })).toContain('shards');
  });

  it('a shards value that is not a list', async () => {
    expect(await corrupt({ schema_version: 3, shards: { 0: entry() } })).toContain('shards');
  });

  it('an empty shards list', async () => {
    expect(await corrupt({ schema_version: 3, shards: [] })).toContain('shards');
  });

  it('an entry that is not an object', async () => {
    expect(await corrupt({ schema_version: 3, shards: [entry(), 'acme/overlay'] })).toContain('shards[1]');
  });

  it('a bad field inside an entry, by its full path', async () => {
    const bad = entry('acme/overlay') as unknown as Record<string, Record<string, Record<string, unknown>>>;
    bad['files']!['Home.md']!['ownership'] = 'mine';
    expect(await corrupt({ schema_version: 3, shards: [entry(), bad] })).toContain('shards[1].files["Home.md"].ownership');
  });

  it('a file whose path is "files" is still named as a key', async () => {
    const bad = entry() as unknown as Record<string, Record<string, Record<string, unknown>>>;
    bad['files'] = { files: { template: null, rendered_hash: 'a', ownership: 'mine' } };
    expect(await corrupt({ schema_version: 3, shards: [bad] })).toContain('shards[0].files["files"].ownership');
  });

  it('two entries naming the same shard', async () => {
    expect(await corrupt({ schema_version: 3, shards: [entry(), entry()] })).toContain('shards[1].shard');
  });
});

describe('readState / writeState handle a vault with one shard (#395)', () => {
  it('a schema-2 vault reads and writes back byte for byte', async () => {
    const original = JSON.stringify(v2(), null, 2) + '\n';
    await writeRaw(null, original);
    const state = await readState(vault);
    expect(state!.schema_version).toBe(2);
    await writeState(vault, state!);
    expect(await fsp.readFile(statePath(), 'utf-8')).toBe(original);
  });

  it('a schema-3 file with one shard reads as that shard, at schema 2', async () => {
    await writeRaw({ schema_version: 3, shards: [entry()] });
    expect(await readState(vault)).toEqual(v2());
  });

  it('a vault with several shards is refused, never read as its base alone', async () => {
    await writeVaultState(vault, composed());
    const err = await readState(vault).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'STATE_UNSUPPORTED_VERSION' });
    expect((err as Error).message).toContain('several shards');
    expect((err as { hint?: string }).hint).toContain('each shard');
    expect((err as { hint?: string }).hint).not.toMatch(/#\d+/);
    // No released ShardMind manages it yet: the hint promises no upgrade that does.
    expect((err as { hint?: string }).hint).not.toContain('npm install');
    // Not a newer ShardMind's file: no schema numbers to report.
    expect(newerStateOf(err)).toBeNull();
  });

  it('writeState refuses a state that is not at schema 2', async () => {
    const state = makeShardState({ schema_version: 3 });
    await expect(writeState(vault, state)).rejects.toMatchObject({ code: 'STATE_UNSUPPORTED_VERSION' });
  });

  it('a schema 4 is a newer ShardMind, reading up to 3', async () => {
    await writeRaw({ schema_version: 4, vaults: [] });
    const err = await readState(vault).catch((e: unknown) => e);
    expect(newerStateOf(err)).toEqual({ stateSchemaVersion: 4, supportedSchemaVersion: 3 });
    expect(newerStateOf(await readVaultState(vault).catch((e: unknown) => e))).toEqual({
      stateSchemaVersion: 4,
      supportedSchemaVersion: 3,
    });
  });
});

describe('the code review of #395', () => {
  it("an entry's stray schema_version never overrides the stamp", async () => {
    const stray = { ...entry(), schema_version: 3 } as unknown as ShardEntry;
    await writeVaultState(vault, { schema_version: 3, shards: [stray] });
    const raw = JSON.parse(await fsp.readFile(statePath(), 'utf-8')) as Record<string, unknown>;
    expect(raw['schema_version']).toBe(2);
    expect((await readState(vault))!.schema_version).toBe(2);
  });

  it('a broken composed file read leniently (status, install --force) degrades instead of being refused as several shards', async () => {
    await writeRaw({ schema_version: 3, shards: [entry(), entry()] });
    const errors: string[] = [];
    const state = await readState(vault, { onContractError: (err) => errors.push(err.message) });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('shards[1].shard');
    expect(state!.shard).toBe('acme/base');
  });

  it('a lenient read of a non-object entry degrades to an empty shard', async () => {
    await writeRaw({ schema_version: 3, shards: ['oops'] });
    const state = await readState(vault, { onContractError: () => {} });
    expect(state).toEqual({ schema_version: 2 });
  });

  it('a schema below 1 is unsupported before its shape is judged, as the runtime answers', async () => {
    await writeRaw({ schema_version: 0 });
    await expect(readState(vault)).rejects.toMatchObject({ code: 'STATE_UNSUPPORTED_VERSION' });
    const errors: unknown[] = [];
    await expect(readState(vault, { onContractError: (e) => errors.push(e) })).rejects.toMatchObject({
      code: 'STATE_UNSUPPORTED_VERSION',
    });
    expect(errors).toEqual([]);
  });
});

describe('the runtime loadState reads schema 3 (#395)', () => {
  beforeEach(() => {
    vi.spyOn(process, 'cwd').mockReturnValue(vault);
  });

  it('returns the base shard as a one-shard state, at schema 2, as the engine reads it', async () => {
    await writeVaultState(vault, composed());
    expect(await loadState()).toEqual({ schema_version: 2, ...entry('acme/base') });
  });

  it('getIncludedModules reads the named shard too', async () => {
    const state = composed();
    state.shards[0]!.modules = { brain: 'included', perf: 'excluded' };
    state.shards[1]!.modules = { papers: 'included' };
    await writeVaultState(vault, state);
    expect(await getIncludedModules()).toEqual(['brain']);
    expect(await getIncludedModules({ shard: 'acme/overlay' })).toEqual(['papers']);
    expect(await getIncludedModules({ shard: 'acme/missing' })).toEqual([]);
  });

  it('returns a named shard', async () => {
    await writeVaultState(vault, composed());
    expect((await loadState({ shard: 'acme/overlay' }))!.shard).toBe('acme/overlay');
    expect((await loadState({ shard: 'acme/base' }))!.shard).toBe('acme/base');
  });

  it('returns null for a shard the vault does not hold, at either schema', async () => {
    await writeVaultState(vault, composed());
    expect(await loadState({ shard: 'acme/missing' })).toBeNull();
    await writeRaw(v2());
    expect(await loadState({ shard: 'acme/missing' })).toBeNull();
    expect((await loadState({ shard: 'acme/base' }))!.schema_version).toBe(2);
  });

  it('returns null with no state.json, named or not', async () => {
    expect(await loadState()).toBeNull();
    expect(await loadState({ shard: 'acme/base' })).toBeNull();
  });

  it('refuses a schema-3 file that breaks the contract, naming the field', async () => {
    await writeRaw({ schema_version: 3, shards: [entry(), { ...entry('acme/overlay'), modules: { x: 'maybe' } }] });
    await expect(loadState()).rejects.toMatchObject({
      code: 'STATE_CORRUPT',
      message: expect.stringContaining('shards[1].modules["x"]'),
    });
  });

  it('a schema 4 is a newer ShardMind, reading up to 3', async () => {
    await writeRaw({ schema_version: 4 });
    expect(newerStateOf(await loadState().catch((e: unknown) => e))).toEqual({
      stateSchemaVersion: 4,
      supportedSchemaVersion: 3,
    });
  });
});
