/**
 * Where an overlay shard keeps its own files (#396): its cache, its values
 * file, its hook logs, and the runtime readers given `{ shard }`. Spec:
 * docs/SHARD-LAYOUT.md §Overlay shards, IMPLEMENTATION §5.2 / §5.4.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { hookLogRelPath, overlayDir, overlayValuesFile } from '../../source/runtime/vault-paths.js';
import { loadValues } from '../../source/runtime/values.js';
import { loadSchema } from '../../source/runtime/schema.js';
import { writeVaultState } from '../../source/core/state.js';
import type { ShardEntry } from '../../source/runtime/types.js';
import { makeShardState } from '../helpers/index.js';

describe('overlay paths (#396)', () => {
  it('an overlay cache sits under .shardmind/shards/<namespace>/<name>', () => {
    expect(overlayDir('acme/research').split(path.sep).join('/')).toBe('.shardmind/shards/acme/research');
  });

  it('an overlay values file is shard-values.<namespace>.<name>.yaml at the vault root', () => {
    expect(overlayValuesFile('acme/research')).toBe('shard-values.acme.research.yaml');
  });

  it("an overlay's hook log sits under .shardmind/logs/<namespace>/<name>; the base's stays where it was", () => {
    expect(hookLogRelPath('bootstrap', 'acme/research')).toBe('.shardmind/logs/acme/research/bootstrap.log');
    expect(hookLogRelPath('bootstrap')).toBe('.shardmind/logs/bootstrap.log');
  });

  it('refuses a shard name that is not <namespace>/<name>', () => {
    for (const bad of ['acme', 'acme/', '/research', 'acme/research/x', '../x', 'acme/..']) {
      expect(() => overlayDir(bad), bad).toThrow();
      expect(() => overlayValuesFile(bad), bad).toThrow();
    }
  });
});

describe('the runtime reads an overlay with { shard } (#396)', () => {
  let vault: string;

  beforeEach(async () => {
    vault = path.join(os.tmpdir(), `shardmind-overlay-paths-${crypto.randomUUID()}`);
    await fsp.mkdir(path.join(vault, '.shardmind', 'shards', 'acme', 'research'), { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(vault);
    const entry = (shard: string): ShardEntry => {
      const { schema_version: _v, ...rest } = makeShardState({ shard, source: `github:${shard}` });
      return rest;
    };
    await writeVaultState(vault, { schema_version: 3, shards: [entry('acme/base'), entry('acme/research')] });
    await fsp.writeFile(path.join(vault, 'shard-values.yaml'), 'who: base\n');
    await fsp.writeFile(path.join(vault, 'shard-values.acme.research.yaml'), 'who: overlay\n');
    const schema = (who: string) => `schema_version: 1\nvalues:\n  who:\n    type: string\n    message: ${who}\n    default: x\ngroups: []\n`;
    await fsp.writeFile(path.join(vault, '.shardmind', 'shard-schema.yaml'), schema('base'));
    await fsp.writeFile(path.join(vault, '.shardmind', 'shards', 'acme', 'research', 'shard-schema.yaml'), schema('overlay'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fsp.rm(vault, { recursive: true, force: true });
  });

  it("loadValues reads the base's by default, and a named overlay's", async () => {
    expect(await loadValues()).toEqual({ who: 'base' });
    expect(await loadValues({ shard: 'acme/research' })).toEqual({ who: 'overlay' });
    expect(await loadValues({ shard: 'acme/base' })).toEqual({ who: 'base' });
  });

  it("loadSchema reads the base's by default, and a named overlay's cached one", async () => {
    expect((await loadSchema()).values['who']!.message).toBe('base');
    expect((await loadSchema({ shard: 'acme/research' })).values['who']!.message).toBe('overlay');
    expect((await loadSchema({ shard: 'acme/base' })).values['who']!.message).toBe('base');
  });

  it('a shard the vault does not hold is refused, naming it, as loadState({ shard }) finds none', async () => {
    for (const read of [loadValues, loadSchema]) {
      await expect(read({ shard: 'acme/missing' })).rejects.toMatchObject({
        code: 'ARGS_INVALID',
        message: expect.stringContaining('acme/missing'),
      });
    }
  });
});
