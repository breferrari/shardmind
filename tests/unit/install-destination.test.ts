/**
 * Where `shardmind install <shard> [folder]` installs (#333). Spec:
 * docs/IMPLEMENTATION.md §4.31, ARCHITECTURE §10.6.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveInstallDestination } from '../../source/core/install-destination.js';
import { shardNameOf } from '../../source/core/registry.js';
import { ShardMindError } from '../../source/runtime/types.js';

let cwd: string;
beforeEach(async () => {
  cwd = path.join(os.tmpdir(), `shardmind-destination-${crypto.randomUUID()}`);
  await fsp.mkdir(cwd, { recursive: true });
});
afterEach(async () => {
  await fsp.rm(cwd, { recursive: true, force: true });
});

async function refusal(promise: Promise<unknown>): Promise<ShardMindError> {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ShardMindError);
  return err as ShardMindError;
}

describe('shardNameOf: the default folder is the <name> of the ref as written', () => {
  it.each([
    ['breferrari/wiki-mind', 'wiki-mind'],
    ['github:breferrari/wiki-mind', 'wiki-mind'],
    ['breferrari/wiki-mind@1.2.3', 'wiki-mind'],
    ['github:breferrari/wiki-mind@v1.2.3', 'wiki-mind'],
    ['github:breferrari/wiki-mind#main', 'wiki-mind'],
    ['github:breferrari/wiki-mind#feature/x', 'wiki-mind'],
    ['  breferrari/obsidian-mind  ', 'obsidian-mind'],
  ])('%s → %s', (ref, name) => {
    expect(shardNameOf(ref)).toBe(name);
  });

  it('a malformed ref is REGISTRY_INVALID_REF, with no network', () => {
    expect(() => shardNameOf('not a ref')).toThrow(expect.objectContaining({ code: 'REGISTRY_INVALID_REF' }));
  });
});

describe('resolveInstallDestination (#333)', () => {
  it('no folder: a new folder named after the shard, to create', async () => {
    const dest = await resolveInstallDestination(cwd, 'github:acme/wiki-mind#main');
    expect(dest).toEqual({ root: path.join(cwd, 'wiki-mind'), display: 'wiki-mind', inPlace: false, create: [path.join(cwd, 'wiki-mind')] });
  });

  it('an explicit name is used', async () => {
    const dest = await resolveInstallDestination(cwd, 'acme/wiki-mind', 'my-wiki');
    expect(dest.root).toBe(path.join(cwd, 'my-wiki'));
    expect(dest.display).toBe('my-wiki');
    expect(dest.create).toEqual([path.join(cwd, 'my-wiki')]);
  });

  it('a nested path creates every missing level, outermost first', async () => {
    await fsp.mkdir(path.join(cwd, 'a'));
    const dest = await resolveInstallDestination(cwd, 'acme/wiki-mind', 'a/b/c');
    expect(dest.root).toBe(path.join(cwd, 'a', 'b', 'c'));
    expect(dest.create).toEqual([path.join(cwd, 'a', 'b'), path.join(cwd, 'a', 'b', 'c')]);
  });

  it('a name with a space and Unicode', async () => {
    const dest = await resolveInstallDestination(cwd, 'acme/wiki-mind', 'Mon coffre ü');
    expect(dest.root).toBe(path.join(cwd, 'Mon coffre ü'));
    expect(dest.create).toEqual([path.join(cwd, 'Mon coffre ü')]);
  });

  it('`.` is the current folder, in place, with no check: even a full folder', async () => {
    await fsp.writeFile(path.join(cwd, 'Home.md'), '# mine\n');
    expect(await resolveInstallDestination(cwd, 'acme/wiki-mind', '.')).toEqual({ root: cwd, display: '.', inPlace: true, create: [] });
  });

  it('a path that resolves to the current folder is in place too', async () => {
    await fsp.mkdir(path.join(cwd, 'sub'));
    expect((await resolveInstallDestination(cwd, 'acme/wiki-mind', 'sub/..')).inPlace).toBe(true);
  });

  it('an existing empty folder is installed into, with nothing to create', async () => {
    await fsp.mkdir(path.join(cwd, 'wiki-mind'));
    const dest = await resolveInstallDestination(cwd, 'acme/wiki-mind');
    expect(dest).toMatchObject({ root: path.join(cwd, 'wiki-mind'), inPlace: false, create: [] });
  });

  it('a non-empty folder is INSTALL_DESTINATION_NOT_EMPTY, naming it and suggesting another name or `.`', async () => {
    await fsp.mkdir(path.join(cwd, 'wiki-mind'));
    await fsp.writeFile(path.join(cwd, 'wiki-mind', 'notes.md'), 'x');
    const err = await refusal(resolveInstallDestination(cwd, 'acme/wiki-mind'));
    expect(err.code).toBe('INSTALL_DESTINATION_NOT_EMPTY');
    expect(err.message).toContain('wiki-mind');
    expect(err.hint).toContain('.');
  });

  it('a folder holding only a hidden file is not empty', async () => {
    await fsp.mkdir(path.join(cwd, 'wiki-mind'));
    await fsp.writeFile(path.join(cwd, 'wiki-mind', '.DS_Store'), '');
    expect((await refusal(resolveInstallDestination(cwd, 'acme/wiki-mind'))).code).toBe('INSTALL_DESTINATION_NOT_EMPTY');
  });

  it('a file at the path is refused', async () => {
    await fsp.writeFile(path.join(cwd, 'wiki-mind'), 'x');
    expect((await refusal(resolveInstallDestination(cwd, 'acme/wiki-mind'))).code).toBe('INSTALL_DESTINATION_NOT_EMPTY');
  });

  it('a file at a parent level is refused, naming that level', async () => {
    await fsp.writeFile(path.join(cwd, 'a'), 'x');
    const err = await refusal(resolveInstallDestination(cwd, 'acme/wiki-mind', 'a/b'));
    expect(err.code).toBe('INSTALL_DESTINATION_NOT_EMPTY');
    expect(err.message).toContain('a');
  });

  it('an absolute folder is taken as is', async () => {
    const abs = path.join(cwd, 'elsewhere');
    const dest = await resolveInstallDestination(os.tmpdir(), 'acme/wiki-mind', abs);
    expect(dest).toMatchObject({ root: abs, display: abs, create: [abs] });
  });

  it('a malformed ref is refused before anything else, as without a folder', async () => {
    expect((await refusal(resolveInstallDestination(cwd, 'nope'))).code).toBe('REGISTRY_INVALID_REF');
  });
});
