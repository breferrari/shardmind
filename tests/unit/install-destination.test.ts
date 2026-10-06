/**
 * Where `shardmind install <shard> [folder]` installs (#333). Spec:
 * docs/IMPLEMENTATION.md §4.31, ARCHITECTURE §10.6.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveInstallDestination } from '../../source/core/install-destination.js';
import { shardNameOf } from '../../source/core/registry.js';
import { ShardMindError } from '../../source/runtime/types.js';
import { symlinksWork } from '../helpers/fs-capabilities.js';

const canSymlink = await symlinksWork();

let cwd: string;
beforeEach(async () => {
  cwd = path.join(os.tmpdir(), `shardmind-destination-${crypto.randomUUID()}`);
  await fsp.mkdir(cwd, { recursive: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
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
  it.each([
    ['no folder: the shard\'s name', undefined, 'wiki-mind'],
    ['an explicit name', 'my-wiki', 'my-wiki'],
    ['a name with a space and Unicode', 'Mon coffre ü', 'Mon coffre ü'],
  ])('%s: a new folder, to create', async (_case, folder, name) => {
    const dest = await resolveInstallDestination(cwd, 'github:acme/wiki-mind#main', folder);
    expect(dest).toEqual({ root: path.join(cwd, name), folder: name, create: [path.join(cwd, name)] });
  });

  it('a nested path creates every missing level, outermost first', async () => {
    await fsp.mkdir(path.join(cwd, 'a'));
    const dest = await resolveInstallDestination(cwd, 'acme/wiki-mind', 'a/b/c');
    expect(dest.root).toBe(path.join(cwd, 'a', 'b', 'c'));
    expect(dest.create).toEqual([path.join(cwd, 'a', 'b'), path.join(cwd, 'a', 'b', 'c')]);
  });

  it.each([['.'], ['sub/..']])('%s is the current folder, in place, with no check: even a full folder', async (folder) => {
    await fsp.mkdir(path.join(cwd, 'sub'));
    await fsp.writeFile(path.join(cwd, 'Home.md'), '# mine\n');
    expect(await resolveInstallDestination(cwd, 'acme/wiki-mind', folder)).toEqual({ root: cwd, folder: null, create: [] });
  });

  it('an existing empty folder is installed into, with nothing to create', async () => {
    await fsp.mkdir(path.join(cwd, 'wiki-mind'));
    const dest = await resolveInstallDestination(cwd, 'acme/wiki-mind');
    expect(dest).toEqual({ root: path.join(cwd, 'wiki-mind'), folder: 'wiki-mind', create: [] });
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

  it.runIf(canSymlink)('a parent level that is a link to a folder is that folder (macOS /tmp, a synced folder)', async () => {
    await fsp.mkdir(path.join(cwd, 'real'));
    await fsp.symlink(path.join(cwd, 'real'), path.join(cwd, 'linked'), 'junction');
    const dest = await resolveInstallDestination(cwd, 'acme/wiki-mind', 'linked/vault');
    expect(dest.create).toEqual([path.join(cwd, 'linked', 'vault')]);
  });

  it.runIf(canSymlink)('a link to nothing at the path is refused when planning, not taken for a folder to make', async () => {
    await fsp.symlink(path.join(cwd, 'gone'), path.join(cwd, 'wiki-mind'), 'junction');
    const err = await refusal(resolveInstallDestination(cwd, 'acme/wiki-mind'));
    expect(err.code).toBe('INSTALL_DESTINATION_NOT_EMPTY');
    expect(err.message).toContain('is a link to nothing');
    expect(err.hint).toMatch(/Check the path/);
  });

  it('a level it cannot read (a link loop, no permission, an unreachable share) is refused, naming the error', async () => {
    vi.spyOn(fsp, 'stat').mockRejectedValue(Object.assign(new Error('ELOOP'), { code: 'ELOOP' }));
    const err = await refusal(resolveInstallDestination(cwd, 'acme/wiki-mind', 'loop/vault'));
    expect(err.code).toBe('INSTALL_DESTINATION_NOT_EMPTY');
    expect(err.message).toContain('cannot be reached (ELOOP)');
  });

  it('a path whose drive or share does not exist is refused, not walked forever', async () => {
    // Every level is missing, the top included: an unmapped drive (`Q:\\vault`).
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    vi.spyOn(fsp, 'stat').mockRejectedValue(enoent);
    vi.spyOn(fsp, 'lstat').mockRejectedValue(enoent);
    const err = await refusal(resolveInstallDestination(cwd, 'acme/wiki-mind', 'vault'));
    expect(err.code).toBe('INSTALL_DESTINATION_NOT_EMPTY');
    expect(err.message).toContain('does not exist');
    expect(err.hint).toMatch(/Check the path/);
  });

  it('the refusal points at `cd` before `.`, and at update for a vault', async () => {
    await fsp.mkdir(path.join(cwd, 'wiki-mind'));
    await fsp.writeFile(path.join(cwd, 'wiki-mind', 'x.md'), 'x');
    const err = await refusal(resolveInstallDestination(cwd, 'acme/wiki-mind'));
    expect(err.hint).toMatch(/`cd` into it/);
    expect(err.hint).toContain('shardmind update');
  });

  it('an absolute folder is taken as is', async () => {
    const abs = path.join(cwd, 'elsewhere');
    const dest = await resolveInstallDestination(os.tmpdir(), 'acme/wiki-mind', abs);
    expect(dest).toEqual({ root: abs, folder: abs, create: [abs] });
  });

  it.each([[undefined], ['my-wiki'], ['.']])('a malformed ref is refused before anything else (folder %s)', async (folder) => {
    expect((await refusal(resolveInstallDestination(cwd, 'nope', folder))).code).toBe('REGISTRY_INVALID_REF');
  });
});

describe('no folder, inside an existing vault (#337)', () => {
  async function shardmindVault(at: string): Promise<void> {
    await fsp.mkdir(path.join(at, '.shardmind'), { recursive: true });
    await fsp.writeFile(path.join(at, '.shardmind', 'state.json'), '{}');
  }

  it.each([
    ['a shardmind vault', shardmindVault],
    ['an Obsidian vault', (at: string) => fsp.mkdir(path.join(at, '.obsidian'), { recursive: true })],
  ] as const)('%s in the current folder is refused, naming it, with both ways out', async (_kind, makeVault) => {
    await makeVault(cwd);
    const err = await refusal(resolveInstallDestination(cwd, 'acme/wiki-mind'));
    expect(err.code).toBe('INSTALL_INSIDE_VAULT');
    expect(err.message).toContain(cwd);
    expect(err.hint).toContain('shardmind install <shard> my-vault');
    expect(err.hint).toContain('shardmind install <shard> .');
  });

  it('a vault two levels above is refused, naming that vault', async () => {
    await shardmindVault(cwd);
    const deep = path.join(cwd, 'notes', 'inbox');
    await fsp.mkdir(deep, { recursive: true });
    const err = await refusal(resolveInstallDestination(deep, 'acme/wiki-mind'));
    expect(err.code).toBe('INSTALL_INSIDE_VAULT');
    expect(err.message).toContain(cwd);
    expect(err.message).not.toContain(deep);
  });

  it.each([['.'], ['my-wiki']])('an explicit folder (%s) skips the check', async (folder) => {
    await shardmindVault(cwd);
    await fsp.mkdir(path.join(cwd, '.obsidian'));
    const dest = await resolveInstallDestination(cwd, 'acme/wiki-mind', folder);
    expect(dest.root).toBe(path.resolve(cwd, folder));
  });

  it('.obsidian as a file, or .shardmind/ without state.json, is not a vault', async () => {
    await fsp.writeFile(path.join(cwd, '.obsidian'), 'not a folder');
    await fsp.mkdir(path.join(cwd, '.shardmind'));
    const dest = await resolveInstallDestination(cwd, 'acme/wiki-mind');
    expect(dest.root).toBe(path.join(cwd, 'wiki-mind'));
  });
});
