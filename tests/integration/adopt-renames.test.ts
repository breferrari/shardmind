/**
 * `adopt --from-version` (#179): a vault cloned from an older release has
 * its files at the old paths; adopt applies the shard's rename migrations
 * from that release, so each file is adopted at its new path. Spec:
 * docs/SHARD-LAYOUT.md §Rename migrations (On adopt); IMPLEMENTATION.md
 * §4.17 / §4.18 Renames.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { parseManifest } from '../../source/core/manifest.js';
import { parseSchema, buildValuesValidator } from '../../source/core/schema.js';
import { readState } from '../../source/core/state.js';
import { defaultModuleSelections, resolveComputedDefaults } from '../../source/core/install-planner.js';
import { runInstall } from '../../source/core/install-executor.js';
import { classifyAdoption } from '../../source/core/adopt-planner.js';
import { runAdopt, type AdoptResolution } from '../../source/core/adopt-executor.js';
import { renamesBetween } from '../../source/core/rename-migrations.js';
import { sha256 } from '../../source/core/fs-utils.js';
import type { ResolvedShard, ShardState } from '../../source/runtime/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MINIMAL_SHARD = path.resolve(__dirname, '../../examples/minimal-shard');

const RESOLVED: ResolvedShard = {
  namespace: 'shardmind',
  name: 'minimal',
  version: '0.2.0',
  source: 'github:shardmind/minimal',
  tarballUrl: 'n/a (local fixture)',
};
const BASE_VALUES = { user_name: 'Alice', org_name: 'Acme Labs', vault_purpose: 'engineering' as const, qmd_enabled: true };
const COPY = 'CLAUDE.md';
const COPY_LINE = 'Static agent-config file for the minimal-shard fixture.';
const MIGRATION = `\nmigrations:\n  - from: "0.1.0"\n    to: "0.2.0"\n    renames:\n      "${COPY}": "AGENTS.md"\n`;

describe('adopt --from-version applies rename migrations (#179)', () => {
  let root: string;
  let vault: string;

  beforeEach(async () => {
    root = path.join(os.tmpdir(), `shardmind-179-${crypto.randomUUID()}`);
    vault = path.join(root, 'vault');
    await fsp.mkdir(vault, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fsp.rm(root, { recursive: true, force: true });
  });

  /** The minimal shard at 0.2.0 with CLAUDE.md moved to AGENTS.md (and `extra` edits). */
  async function shardV2(opts: { migration?: boolean; keepOld?: boolean } = {}): Promise<string> {
    const dir = path.join(root, `shard-${crypto.randomUUID().slice(0, 6)}`);
    await fsp.cp(MINIMAL_SHARD, dir, { recursive: true });
    const manifestPath = path.join(dir, '.shardmind', 'shard.yaml');
    let manifest = (await fsp.readFile(manifestPath, 'utf-8')).replace(/^version: .+$/m, 'version: 0.2.0');
    if (opts.migration !== false) manifest += MIGRATION;
    await fsp.writeFile(manifestPath, manifest, 'utf-8');
    if (opts.keepOld) await fsp.copyFile(path.join(dir, COPY), path.join(dir, 'AGENTS.md'));
    else await fsp.rename(path.join(dir, COPY), path.join(dir, 'AGENTS.md'));
    return dir;
  }

  /** A vault as a clone of 0.1.0 would be: installed, then the engine's files removed. */
  async function cloneOfV1(): Promise<void> {
    const manifest = await parseManifest(path.join(MINIMAL_SHARD, '.shardmind', 'shard.yaml'));
    const schema = await parseSchema(path.join(MINIMAL_SHARD, '.shardmind', 'shard-schema.yaml'));
    const values = buildValuesValidator(schema).parse(resolveComputedDefaults(schema, BASE_VALUES)) as Record<string, unknown>;
    await runInstall({
      vaultRoot: vault,
      manifest,
      schema,
      tempDir: MINIMAL_SHARD,
      resolved: { ...RESOLVED, version: '0.1.0' },
      tarballSha256: 'sha',
      values,
      selections: defaultModuleSelections(schema),
    });
    await fsp.rm(path.join(vault, '.shardmind'), { recursive: true, force: true });
    await fsp.rm(path.join(vault, 'shard-values.yaml'), { force: true });
  }

  async function adopt(
    shardDir: string,
    fromVersion?: string,
    resolve: (userBytes: Buffer) => AdoptResolution = () => 'keep_mine',
    opts: { renames?: Map<string, string>; beforeRun?: () => Promise<void>; classifyOnly?: boolean } = {},
  ) {
    const manifest = await parseManifest(path.join(shardDir, '.shardmind', 'shard.yaml'));
    const schema = await parseSchema(path.join(shardDir, '.shardmind', 'shard-schema.yaml'));
    const selections = defaultModuleSelections(schema);
    const values = buildValuesValidator(schema).parse(resolveComputedDefaults(schema, BASE_VALUES)) as Record<string, unknown>;
    const renames = opts.renames ?? (fromVersion ? renamesBetween(manifest.migrations, fromVersion, manifest.version) : undefined);
    const plan = await classifyAdoption({ vaultRoot: vault, schema, manifest, tempDir: shardDir, values, selections, renames });
    if (opts.classifyOnly) return { plan, result: undefined };
    const resolutions: Record<string, AdoptResolution> = {};
    for (const c of plan.differs) {
      if (c.kind === 'differs') resolutions[c.path] = resolve(c.userContent);
    }
    await opts.beforeRun?.();
    const result = await runAdopt({
      vaultRoot: vault,
      manifest,
      schema,
      tempDir: shardDir,
      resolved: RESOLVED,
      tarballSha256: 'sha-0.2.0',
      values,
      selections,
      plan,
      resolutions,
    });
    return { plan, result };
  }

  const read = (rel: string) => fsp.readFile(path.join(vault, rel), 'utf-8');
  const write = (rel: string, c: string) => fsp.writeFile(path.join(vault, rel), c, 'utf-8');
  const exists = (rel: string) => fsp.access(path.join(vault, rel)).then(() => true, () => false);
  const files = async () => ((await readState(vault)) as ShardState).files;

  it('adopts an unchanged file at its new path and moves it there', async () => {
    await cloneOfV1();
    const before = await read(COPY);
    const { plan, result } = await adopt(await shardV2(), '0.1.0');
    expect(plan.matches.find((c) => c.path === 'AGENTS.md')?.movedFrom).toBe(COPY);
    expect(await exists(COPY)).toBe(false);
    expect(await read('AGENTS.md')).toBe(before);
    expect((await files())['AGENTS.md']?.ownership).toBe('managed');
    expect(result.summary.renamedFiles).toEqual([{ from: COPY, to: 'AGENTS.md' }]);
  });

  it.each([
    ['keep_mine', 'My edit.\n', 'modified'],
    ['use_shard', COPY_LINE, 'managed'],
  ] as const)('with %s, an edited file ends at the new path', async (resolution, expected, ownership) => {
    await cloneOfV1();
    await write(COPY, 'My edit.\n');
    await adopt(await shardV2(), '0.1.0', () => resolution);
    expect(await exists(COPY)).toBe(false);
    expect(await read('AGENTS.md')).toContain(expected);
    expect((await files())['AGENTS.md']?.ownership).toBe(ownership);
    expect((await files())[COPY]).toBeUndefined();
  });

  it('a merge writes the new path and deletes the old one', async () => {
    await cloneOfV1();
    await write(COPY, 'My edit.\n');
    const merged = Buffer.from('Merged bytes.\n');
    await adopt(await shardV2(), '0.1.0', () => ({ kind: 'merged', content: merged, hash: sha256(merged) }));
    expect(await exists(COPY)).toBe(false);
    expect(await read('AGENTS.md')).toBe('Merged bytes.\n');
  });

  it('without --from-version, adopt is unchanged: the new path is installed fresh', async () => {
    await cloneOfV1();
    await write(COPY, 'My edit.\n');
    const { plan, result } = await adopt(await shardV2());
    expect(plan.shardOnly.map((c) => c.path)).toContain('AGENTS.md');
    expect(await read(COPY)).toBe('My edit.\n');
    expect(result.summary.renamedFiles).toEqual([]);
  });

  it('a version no migration applies to is a no-op', async () => {
    await cloneOfV1();
    const { result } = await adopt(await shardV2(), '0.2.0');
    expect(result.summary.renamedFiles).toEqual([]);
    expect(await exists(COPY)).toBe(true);
  });

  it('leaves the rename out when something already sits at the new path', async () => {
    await cloneOfV1();
    await write('AGENTS.md', 'Already mine.\n');
    const { result } = await adopt(await shardV2(), '0.1.0');
    expect(result.summary.renamedFiles).toEqual([]);
    expect(await read('AGENTS.md')).toBe('Already mine.\n');
    expect(await exists(COPY)).toBe(true);
  });

  it('leaves the rename out when the shard still ships the old path', async () => {
    await cloneOfV1();
    const { result } = await adopt(await shardV2({ keepOld: true }), '0.1.0');
    expect(result.summary.renamedFiles).toEqual([]);
    expect(await exists(COPY)).toBe(true);
  });

  it('leaves out two renames into one new path', async () => {
    await cloneOfV1();
    await write('OTHER.md', 'Other.\n');
    const renames = new Map([[COPY, 'AGENTS.md'], ['OTHER.md', 'AGENTS.md']]);
    const { result } = await adopt(await shardV2(), undefined, undefined, { renames });
    expect(result.summary.renamedFiles).toEqual([]);
    expect(await exists(COPY)).toBe(true);
    expect(await exists('OTHER.md')).toBe(true);
  });

  it('leaves the rename out when a file sits where the new path needs a folder', async () => {
    await cloneOfV1();
    const v2 = await shardV2();
    await fsp.mkdir(path.join(v2, 'agents'));
    await fsp.rename(path.join(v2, 'AGENTS.md'), path.join(v2, 'agents', 'AGENTS.md'));
    await write('agents', 'a file, not a folder\n');
    const renames = new Map([[COPY, 'agents/AGENTS.md']]);
    // Windows reports ENOENT, not ENOTDIR, under a file: the folder check catches it.
    const { plan } = await adopt(v2, undefined, undefined, { renames, classifyOnly: true });
    expect(plan.shardOnly.map((c) => c.path)).toContain('agents/AGENTS.md');
    expect([...plan.matches, ...plan.differs].some((c) => c.kind !== 'shard-only' && c.movedFrom !== undefined)).toBe(false);
  });

  it('refuses before any write when a file arrives at the new path after classifying', async () => {
    await cloneOfV1();
    await write(COPY, 'My edit.\n');
    const arrive = () => write('AGENTS.md', 'Arrived meanwhile.\n');
    // Use the shard's writes the new path: only the check before any write
    // keeps it off the file that arrived.
    await expect(adopt(await shardV2(), '0.1.0', () => 'use_shard', { beforeRun: arrive })).rejects.toMatchObject({
      code: 'ADOPT_WRITE_FAILED',
    });
    expect(await read('AGENTS.md')).toBe('Arrived meanwhile.\n');
    expect(await read(COPY)).toBe('My edit.\n');
    expect(await exists('.shardmind/state.json')).toBe(false);
  });

  it('refuses before any write when the old file is hard-linked after classifying (#163)', async () => {
    await cloneOfV1();
    const link = () => fsp.link(path.join(vault, COPY), path.join(root, 'elsewhere.md'));
    await expect(adopt(await shardV2(), '0.1.0', undefined, { beforeRun: link })).rejects.toMatchObject({
      code: 'VAULT_PATH_UNSAFE',
    });
    expect(await exists(COPY)).toBe(true);
    expect(await exists('AGENTS.md')).toBe(false);
  });

  it('refuses to move a hard-linked file from the old path (#163)', async () => {
    await cloneOfV1();
    await fsp.link(path.join(vault, COPY), path.join(root, 'elsewhere.md'));
    await expect(adopt(await shardV2(), '0.1.0')).rejects.toMatchObject({ code: 'VAULT_PATH_UNSAFE' });
    expect(await exists(COPY)).toBe(true);
    expect(await exists('AGENTS.md')).toBe(false);
  });

  it('refuses a link to a folder at the old path as unsafe (#163)', async () => {
    await cloneOfV1();
    await fsp.rm(path.join(vault, COPY));
    await fsp.mkdir(path.join(root, 'target'));
    // A junction on Windows (no privilege needed); a plain symlink elsewhere.
    await fsp.symlink(path.join(root, 'target'), path.join(vault, COPY), 'junction');
    await expect(adopt(await shardV2(), '0.1.0')).rejects.toMatchObject({ code: 'VAULT_PATH_UNSAFE' });
  });

  it('treats a folder at the old path as no file, and installs the new path fresh', async () => {
    await cloneOfV1();
    await fsp.rm(path.join(vault, COPY));
    await fsp.mkdir(path.join(vault, COPY));
    const { plan, result } = await adopt(await shardV2(), '0.1.0');
    expect(plan.shardOnly.map((c) => c.path)).toContain('AGENTS.md');
    expect(result!.summary.renamedFiles).toEqual([]);
    expect((await fsp.stat(path.join(vault, COPY))).isDirectory()).toBe(true);
  });

  it('a failed adopt puts the old file back and removes the new one', async () => {
    await cloneOfV1();
    await write(COPY, 'My edit.\n');
    const v2 = await shardV2();
    const realWrite = fsp.writeFile;
    vi.spyOn(fsp, 'writeFile').mockImplementation(async (file, data, opts) => {
      if (String(file).endsWith('state.json')) throw new Error('disk full');
      return realWrite(file, data, opts as Parameters<typeof realWrite>[2]);
    });
    await expect(adopt(v2, '0.1.0')).rejects.toThrow(/disk full/);
    vi.restoreAllMocks();
    expect(await read(COPY)).toBe('My edit.\n');
    expect(await exists('AGENTS.md')).toBe(false);
  });
});
