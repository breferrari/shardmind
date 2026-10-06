/**
 * state.json is validated on read (#343): `ShardState` / `FileState` are the
 * file's contract. Spec: docs/IMPLEMENTATION.md §4.7 (The persisted contract).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { readState, writeState } from '../../source/core/state.js';
import { loadState } from '../../source/runtime/state.js';
import { makeShardState } from '../helpers/index.js';

let vault: string;

beforeEach(async () => {
  vault = path.join(os.tmpdir(), `shardmind-state-schema-${crypto.randomUUID()}`);
  await fsp.mkdir(path.join(vault, '.shardmind'), { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(vault, { recursive: true, force: true });
});

const valid = (): Record<string, unknown> =>
  JSON.parse(
    JSON.stringify(
      makeShardState({
        files: { 'Home.md': { template: 'Home.md.njk', rendered_hash: 'a'.repeat(64), ownership: 'managed' } },
      }),
    ),
  ) as Record<string, unknown>;

async function writeRaw(value: unknown): Promise<void> {
  await fsp.writeFile(path.join(vault, '.shardmind', 'state.json'), JSON.stringify(value), 'utf-8');
}

async function corruptMessage(value: unknown): Promise<string> {
  await writeRaw(value);
  try {
    await readState(vault);
  } catch (err) {
    expect(err).toMatchObject({ code: 'STATE_CORRUPT' });
    return (err as Error).message;
  }
  throw new Error('expected STATE_CORRUPT');
}

describe('readState validates state.json (#343)', () => {
  it('reads a valid state as before', async () => {
    await writeRaw(valid());
    const state = await readState(vault);
    expect(state!.files['Home.md']!.ownership).toBe('managed');
  });

  const REQUIRED = ['shard', 'source', 'version', 'tarball_sha256', 'installed_at', 'updated_at', 'values_hash', 'modules', 'files'];

  for (const field of REQUIRED) {
    it(`a missing ${field} is STATE_CORRUPT naming it`, async () => {
      const s = valid();
      delete s[field];
      expect(await corruptMessage(s)).toContain(field);
    });
  }

  it('a wrongly typed field is STATE_CORRUPT naming it', async () => {
    expect(await corruptMessage({ ...valid(), version: 6 })).toContain('version');
    expect(await corruptMessage({ ...valid(), files: [] })).toContain('files');
  });

  it('a schema_version that is not an integer is STATE_CORRUPT', async () => {
    expect(await corruptMessage({ ...valid(), schema_version: 2.5 })).toContain('schema_version');
    expect(await corruptMessage({ ...valid(), schema_version: '2' })).toContain('schema_version');
  });

  it('a bad file entry is named by its path', async () => {
    const files = (over: Record<string, unknown>) => ({
      ...valid(),
      files: { 'Home.md': { template: 'Home.md.njk', rendered_hash: 'a'.repeat(64), ownership: 'managed', ...over } },
    });
    expect(await corruptMessage(files({ ownership: 'user' }))).toContain('files["Home.md"].ownership');
    expect(await corruptMessage(files({ rendered_hash: undefined }))).toContain('files["Home.md"].rendered_hash');
    expect(await corruptMessage(files({ template: 3 }))).toContain('files["Home.md"].template');
  });

  it('a module selection other than included / excluded is STATE_CORRUPT', async () => {
    expect(await corruptMessage({ ...valid(), modules: { brain: 'maybe' } })).toContain('modules');
  });

  it('a file entry may have a null template and an iterator_key; the optional fields may be absent or present', async () => {
    const s = valid();
    s['files'] = { 'people/a.md': { template: null, rendered_hash: 'b'.repeat(64), ownership: 'modified', iterator_key: 'a' } };
    s['ref'] = 'main';
    s['resolvedSha'] = 'c'.repeat(40);
    s['bootstrap_fingerprint'] = 'fp';
    await writeRaw(s);
    const state = await readState(vault);
    expect(state!.ref).toBe('main');
    expect(state!.files['people/a.md']!.iterator_key).toBe('a');
  });

  it('a v1 state is migrated forward, then validated', async () => {
    await writeRaw({ ...valid(), schema_version: 1 });
    expect((await readState(vault))!.schema_version).toBe(2);
    await writeRaw({ ...valid(), schema_version: 1, files: { x: { ownership: 'managed' } } });
    await expect(readState(vault)).rejects.toMatchObject({ code: 'STATE_CORRUPT' });
  });

  it('a newer schema_version is STATE_UNSUPPORTED_VERSION, whatever else it holds', async () => {
    await writeRaw({ schema_version: 99, shape: 'unknown' });
    await expect(readState(vault)).rejects.toMatchObject({ code: 'STATE_UNSUPPORTED_VERSION' });
  });

  it('an unknown field, top level or in a file, is kept through a read and a write', async () => {
    const s = valid();
    s['future_field'] = { a: 1 };
    (s['files'] as Record<string, Record<string, unknown>>)['Home.md']!['future_file_field'] = true;
    await writeRaw(s);
    const state = await readState(vault);
    await writeState(vault, state!);
    const back = JSON.parse(await fsp.readFile(path.join(vault, '.shardmind', 'state.json'), 'utf-8')) as Record<string, unknown>;
    expect(back['future_field']).toEqual({ a: 1 });
    expect((back['files'] as Record<string, Record<string, unknown>>)['Home.md']!['future_file_field']).toBe(true);
  });
});

describe('writeState checks the contract before writing (#343)', () => {
  it('refuses a state that breaks it, and writes nothing', async () => {
    const bad = { ...valid(), files: { 'Home.md': { template: null, rendered_hash: 'a', ownership: 'mine' } } };
    await expect(writeState(vault, bad as never)).rejects.toMatchObject({ code: 'STATE_CORRUPT' });
    await expect(fsp.access(path.join(vault, '.shardmind', 'state.json'))).rejects.toThrow();
  });
});

describe('loadState (runtime) validates the same way (#343)', () => {
  it('refuses a state with a bad field, naming it', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(vault);
    await writeRaw({ ...valid(), modules: { brain: 'maybe' } });
    await expect(loadState()).rejects.toMatchObject({ code: 'STATE_CORRUPT', message: expect.stringContaining('modules') });
  });

  it('reads a valid state', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(vault);
    await writeRaw(valid());
    expect((await loadState())!.shard).toBe(valid()['shard']);
  });
});
