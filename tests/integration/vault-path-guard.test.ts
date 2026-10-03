/**
 * Install, update and adopt refuse a vault path a write would send
 * elsewhere (#163): each pipeline meets a symlink at a path it writes,
 * and must refuse with VAULT_PATH_UNSAFE before touching anything, so the
 * link's target outside the vault is never created or changed. The
 * per-shape cases live in `tests/unit/vault-path-guard.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { parseManifest } from '../../source/core/manifest.js';
import { parseSchema, buildValuesValidator } from '../../source/core/schema.js';
import { readState } from '../../source/core/state.js';
import { detectDrift } from '../../source/core/drift.js';
import { applyMigrations } from '../../source/core/migrator.js';
import { planUpdate, mergeModuleSelections } from '../../source/core/update-planner.js';
import { runUpdate } from '../../source/core/update-executor.js';
import { defaultModuleSelections, resolveComputedDefaults } from '../../source/core/install-planner.js';
import { runInstall } from '../../source/core/install-executor.js';
import { classifyAdoption } from '../../source/core/adopt-planner.js';
import { runAdopt } from '../../source/core/adopt-executor.js';
import { buildRenderContext } from '../../source/core/renderer.js';
import type { ResolvedShard, ShardState } from '../../source/runtime/types.js';
import { symlinksWork } from '../helpers/fs-capabilities.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MINIMAL_SHARD = path.resolve(__dirname, '../../examples/minimal-shard');

const RESOLVED: ResolvedShard = {
  namespace: 'shardmind',
  name: 'minimal',
  version: '0.1.0',
  source: 'github:shardmind/minimal',
  tarballUrl: 'n/a (local fixture)',
};

const VALUES = {
  user_name: 'Alice',
  org_name: 'Acme Labs',
  vault_purpose: 'engineering' as const,
  qmd_enabled: true,
};

const canSymlink = await symlinksWork();

async function loadShard(dir: string) {
  const manifest = await parseManifest(path.join(dir, '.shardmind', 'shard.yaml'));
  const schema = await parseSchema(path.join(dir, '.shardmind', 'shard-schema.yaml'));
  const selections = defaultModuleSelections(schema);
  const values = buildValuesValidator(schema).parse(resolveComputedDefaults(schema, VALUES)) as Record<string, unknown>;
  return { manifest, schema, selections, values };
}

async function install(vault: string, shardDir = MINIMAL_SHARD, dryRun = false, extraValues: Record<string, unknown> = {}) {
  const { manifest, schema, selections, values: base } = await loadShard(shardDir);
  const values = { ...base, ...extraValues };
  return runInstall({
    dryRun,
    vaultRoot: vault,
    manifest,
    schema,
    tempDir: shardDir,
    resolved: { ...RESOLVED, version: manifest.version },
    tarballSha256: 'sha',
    values,
    selections,
  });
}

describe.skipIf(!canSymlink)('install, update and adopt refuse a linked vault path (#163)', () => {
  let root: string;
  let vault: string;
  let outside: string;

  beforeEach(async () => {
    root = path.join(os.tmpdir(), `shardmind-guard-int-${crypto.randomUUID()}`);
    vault = path.join(root, 'vault');
    outside = path.join(root, 'outside');
    await fsp.mkdir(vault, { recursive: true });
    await fsp.mkdir(outside, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('install refuses a dangling symlink at a planned path and writes nothing', async () => {
    const target = path.join(outside, 'created-outside.md');
    await fsp.symlink(target, path.join(vault, 'Home.md'));
    await expect(install(vault)).rejects.toMatchObject({ code: 'VAULT_PATH_UNSAFE' });
    await expect(fsp.stat(target)).rejects.toThrow();
    expect(await readState(vault)).toBeNull();
    expect(await fsp.readdir(vault)).toEqual(['Home.md']);
  });

  it('install checks the path an _each template expands to, not the template name', async () => {
    const shard = path.join(root, 'shard-each');
    await fsp.cp(MINIMAL_SHARD, shard, { recursive: true });
    await fsp.mkdir(path.join(shard, 'people'), { recursive: true });
    await fsp.writeFile(path.join(shard, 'people', '_each.md.njk'), '# {{ item.name }}\n');
    await fsp.mkdir(path.join(vault, 'people'));
    const target = path.join(outside, 'alice-outside.md');
    await fsp.symlink(target, path.join(vault, 'people', 'alice.md'));
    await expect(install(vault, shard, false, { people: [{ name: 'alice' }] })).rejects.toMatchObject({
      code: 'VAULT_PATH_UNSAFE',
    });
    await expect(fsp.stat(target)).rejects.toThrow();
  });

  it('a dry-run install refuses too, so the preview matches the run', async () => {
    const target = path.join(outside, 'created-outside.md');
    await fsp.symlink(target, path.join(vault, 'Home.md'));
    await expect(install(vault, MINIMAL_SHARD, true)).rejects.toMatchObject({ code: 'VAULT_PATH_UNSAFE' });
    await expect(fsp.stat(target)).rejects.toThrow();
  });

  // Installs 0.1.0, then plans 0.2.0 (Home.md changed). `linkHome` runs
  // before or after planning: the planner and the executor both check.
  async function updateWithLinkedHome(linkHome: 'before-plan' | 'after-plan') {
    await install(vault);
    const target = path.join(outside, 'precious.md');
    await fsp.copyFile(path.join(vault, 'Home.md'), target);
    // Same bytes, so drift still calls it managed and the update would
    // overwrite it in place, through the link.
    const link = async () => {
      await fsp.rm(path.join(vault, 'Home.md'));
      await fsp.symlink(target, path.join(vault, 'Home.md'));
    };
    if (linkHome === 'before-plan') await link();

    const newShard = path.join(root, 'shard-0.2.0');
    await fsp.cp(MINIMAL_SHARD, newShard, { recursive: true });
    const manifestPath = path.join(newShard, '.shardmind', 'shard.yaml');
    await fsp.writeFile(manifestPath, (await fsp.readFile(manifestPath, 'utf-8')).replace(/^version: .*$/m, 'version: 0.2.0'));
    await fsp.appendFile(path.join(newShard, 'Home.md.njk'), '\nNew in 0.2.0.\n');

    const state = (await readState(vault)) as ShardState;
    const oldValues = parseYaml(await fsp.readFile(path.join(vault, 'shard-values.yaml'), 'utf-8')) as Record<string, unknown>;
    const { manifest: newManifest, schema: newSchema } = await loadShard(newShard);
    const migration = applyMigrations(oldValues, state.version, newManifest.version, newSchema.migrations);
    const selections = mergeModuleSelections(state.modules, newSchema, {});
    const run = async () => {
      const plan = await planUpdate({
        vault: { root: vault, state, drift: await detectDrift(vault, state) },
        values: { old: oldValues, new: migration.values },
        newShard: {
          schema: newSchema,
          selections,
          tempDir: newShard,
          renderContext: buildRenderContext(newManifest, migration.values, selections),
        },
        removedFileDecisions: {},
      });
      if (linkHome === 'after-plan') await link();
      return runUpdate({
        vaultRoot: vault,
        plan,
        conflictResolutions: {},
        currentState: state,
        newManifest,
        newSchema,
        newValues: migration.values,
        newSelections: selections,
        resolved: { ...RESOLVED, version: '0.2.0' },
        tarballSha256: 'sha-0.2.0',
        newTempDir: newShard,
      });
    };
    return { target, run };
  }

  it.each(['before-plan', 'after-plan'] as const)(
    'update refuses a managed file the user replaced with a symlink (%s), and leaves its target alone',
    async (when) => {
      const { target, run } = await updateWithLinkedHome(when);
      const before = await fsp.readFile(target, 'utf-8');
      const stateBefore = await fsp.readFile(path.join(vault, '.shardmind', 'state.json'), 'utf-8');
      await expect(run()).rejects.toMatchObject({ code: 'VAULT_PATH_UNSAFE' });
      expect(await fsp.readFile(target, 'utf-8')).toBe(before);
      expect(await fsp.readFile(path.join(vault, '.shardmind', 'state.json'), 'utf-8')).toBe(stateBefore);
    },
  );

  it('update names a symlink to a folder at a new path as unsafe, not as a directory in the way', async () => {
    await install(vault);
    const newShard = path.join(root, 'shard-0.2.0-add');
    await fsp.cp(MINIMAL_SHARD, newShard, { recursive: true });
    const manifestPath = path.join(newShard, '.shardmind', 'shard.yaml');
    await fsp.writeFile(manifestPath, (await fsp.readFile(manifestPath, 'utf-8')).replace(/^version: .*$/m, 'version: 0.2.0'));
    await fsp.writeFile(path.join(newShard, 'Added.md'), 'new in 0.2.0\n');
    await fsp.symlink(outside, path.join(vault, 'Added.md'), 'dir');
    const state = (await readState(vault)) as ShardState;
    const oldValues = parseYaml(await fsp.readFile(path.join(vault, 'shard-values.yaml'), 'utf-8')) as Record<string, unknown>;
    const { manifest: newManifest, schema: newSchema } = await loadShard(newShard);
    const selections = mergeModuleSelections(state.modules, newSchema, {});
    await expect(
      planUpdate({
        vault: { root: vault, state, drift: await detectDrift(vault, state) },
        values: { old: oldValues, new: oldValues },
        newShard: {
          schema: newSchema,
          selections,
          tempDir: newShard,
          renderContext: buildRenderContext(newManifest, oldValues, selections),
        },
        removedFileDecisions: {},
      }),
    ).rejects.toMatchObject({ code: 'VAULT_PATH_UNSAFE' });
  });

  it.each(['before-plan', 'after-plan'] as const)(
    'adopt refuses a dangling symlink at a shard path (%s) and writes nothing',
    async (when) => {
      const target = path.join(outside, 'created-outside.md');
      const link = () => fsp.symlink(target, path.join(vault, 'Home.md'));
      if (when === 'before-plan') await link();
      const { manifest, schema, selections, values } = await loadShard(MINIMAL_SHARD);
      const run = async () => {
        const plan = await classifyAdoption({ vaultRoot: vault, schema, manifest, tempDir: MINIMAL_SHARD, values, selections });
        if (when === 'after-plan') await link();
        return runAdopt({
          vaultRoot: vault,
          manifest,
          schema,
          tempDir: MINIMAL_SHARD,
          resolved: RESOLVED,
          tarballSha256: 'sha',
          values,
          selections,
          plan,
          resolutions: {},
        });
      };
      await expect(run()).rejects.toMatchObject({ code: 'VAULT_PATH_UNSAFE' });
      await expect(fsp.stat(target)).rejects.toThrow();
      expect(await readState(vault)).toBeNull();
    },
  );
});
