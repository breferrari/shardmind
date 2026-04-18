import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { parseManifest } from '../../source/core/manifest.js';
import { parseSchema, buildValuesValidator } from '../../source/core/schema.js';
import { readState } from '../../source/core/state.js';
import {
  planOutputs,
  resolveComputedDefaults,
  defaultModuleSelections,
  detectCollisions,
} from '../../source/core/install-planner.js';
import {
  runInstall,
  rollbackInstall,
  backupCollisions,
} from '../../source/core/install-executor.js';
import type { ResolvedShard, ShardState } from '../../source/runtime/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
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

describe('install pipeline (against examples/minimal-shard)', () => {
  let vault: string;

  beforeEach(async () => {
    vault = path.join(os.tmpdir(), `shardmind-install-${crypto.randomUUID()}`);
    await fsp.mkdir(vault, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(vault, { recursive: true, force: true });
  });

  it('installs with all modules included and writes the full output tree', async () => {
    const manifest = await parseManifest(path.join(MINIMAL_SHARD, 'shard.yaml'));
    const schema = await parseSchema(path.join(MINIMAL_SHARD, 'shard-schema.yaml'));

    const selections = defaultModuleSelections(schema);
    const validator = buildValuesValidator(schema);
    const values = validator.parse(resolveComputedDefaults(schema, VALUES));

    const result = await runInstall({
      vaultRoot: vault,
      manifest,
      schema,
      tempDir: MINIMAL_SHARD,
      resolved: RESOLVED,
      tarballSha256: 'deadbeef',
      values,
      selections,
    });

    expect(result.fileCount).toBeGreaterThan(0);

    // state.json exists and looks right
    const state = (await readState(vault)) as ShardState;
    expect(state).not.toBeNull();
    expect(state.schema_version).toBe(1);
    expect(state.shard).toBe('shardmind/minimal');
    expect(state.version).toBe('0.1.0');
    expect(state.tarball_sha256).toBe('deadbeef');
    expect(state.modules).toEqual(selections);
    expect(Object.keys(state.files).length).toBe(result.fileCount);

    // shard-values.yaml written, parseable, round-trips the values
    const valuesYaml = await fsp.readFile(path.join(vault, 'shard-values.yaml'), 'utf-8');
    expect(valuesYaml).toContain('user_name: Alice');
    expect(valuesYaml).toContain('vault_purpose: engineering');

    // Home.md rendered with substituted values
    const home = await fsp.readFile(path.join(vault, 'Home.md'), 'utf-8');
    expect(home).toContain('Welcome to your vault, Alice.');
    expect(home).toContain('Vault entry point for Acme Labs');

    // brain module file exists (required module)
    const northStar = await fsp.readFile(path.join(vault, 'brain/North Star.md'), 'utf-8');
    expect(northStar).toContain('Goals and focus areas for Alice');

    // extras module files exist (included by default): its command renders to .claude/commands/
    await expect(
      fsp.access(path.join(vault, '.claude/commands/example-command.md')),
    ).resolves.toBeUndefined();

    // Cached state artifacts
    await expect(fsp.access(path.join(vault, '.shardmind/state.json'))).resolves.toBeUndefined();
    await expect(fsp.access(path.join(vault, '.shardmind/shard.yaml'))).resolves.toBeUndefined();
    await expect(fsp.access(path.join(vault, '.shardmind/shard-schema.yaml'))).resolves.toBeUndefined();
    await expect(fsp.access(path.join(vault, '.shardmind/templates'))).resolves.toBeUndefined();
  });

  it('excludes files for modules marked excluded', async () => {
    const manifest = await parseManifest(path.join(MINIMAL_SHARD, 'shard.yaml'));
    const schema = await parseSchema(path.join(MINIMAL_SHARD, 'shard-schema.yaml'));

    const selections = defaultModuleSelections(schema);
    selections['extras'] = 'excluded';

    const validator = buildValuesValidator(schema);
    const values = validator.parse(resolveComputedDefaults(schema, VALUES));

    await runInstall({
      vaultRoot: vault,
      manifest,
      schema,
      tempDir: MINIMAL_SHARD,
      resolved: RESOLVED,
      tarballSha256: 'deadbeef',
      values,
      selections,
    });

    const state = (await readState(vault)) as ShardState;
    expect(state.modules['extras']).toBe('excluded');

    // extras command should not exist
    await expect(
      fsp.access(path.join(vault, '.claude/commands/example-command.md')),
    ).rejects.toThrow();
    // brain/ still exists (required)
    await expect(fsp.access(path.join(vault, 'brain'))).resolves.toBeUndefined();
  });

  it('records sha256 hash per file in state', async () => {
    const manifest = await parseManifest(path.join(MINIMAL_SHARD, 'shard.yaml'));
    const schema = await parseSchema(path.join(MINIMAL_SHARD, 'shard-schema.yaml'));
    const selections = defaultModuleSelections(schema);
    const validator = buildValuesValidator(schema);
    const values = validator.parse(resolveComputedDefaults(schema, VALUES));

    await runInstall({
      vaultRoot: vault,
      manifest,
      schema,
      tempDir: MINIMAL_SHARD,
      resolved: RESOLVED,
      tarballSha256: 'deadbeef',
      values,
      selections,
    });

    const state = (await readState(vault)) as ShardState;
    const home = state.files['Home.md'];
    expect(home).toBeDefined();
    expect(home?.ownership).toBe('managed');
    expect(home?.rendered_hash).toMatch(/^[a-f0-9]{64}$/);

    // Hash matches the file on disk
    const diskContent = await fsp.readFile(path.join(vault, 'Home.md'));
    const diskHash = crypto.createHash('sha256').update(diskContent).digest('hex');
    expect(home?.rendered_hash).toBe(diskHash);
  });

  it('dry-run does not write any files', async () => {
    const manifest = await parseManifest(path.join(MINIMAL_SHARD, 'shard.yaml'));
    const schema = await parseSchema(path.join(MINIMAL_SHARD, 'shard-schema.yaml'));
    const selections = defaultModuleSelections(schema);
    const validator = buildValuesValidator(schema);
    const values = validator.parse(resolveComputedDefaults(schema, VALUES));

    await runInstall({
      vaultRoot: vault,
      manifest,
      schema,
      tempDir: MINIMAL_SHARD,
      resolved: RESOLVED,
      tarballSha256: 'deadbeef',
      values,
      selections,
      dryRun: true,
    });

    await expect(fsp.access(path.join(vault, 'Home.md'))).rejects.toThrow();
    await expect(fsp.access(path.join(vault, '.shardmind'))).rejects.toThrow();
  });

  it('planOutputs reports per-module file counts', async () => {
    const schema = await parseSchema(path.join(MINIMAL_SHARD, 'shard-schema.yaml'));
    const selections = defaultModuleSelections(schema);
    const { moduleFileCounts, outputs } = await planOutputs(schema, MINIMAL_SHARD, selections);

    expect(outputs.length).toBeGreaterThan(0);
    expect(moduleFileCounts['brain']).toBeGreaterThan(0);
    // extras contributes a command and a partial; the partial has no output file on its own
    expect(moduleFileCounts['extras']).toBeGreaterThanOrEqual(1);
  });

  it('collision detection flags pre-existing files at planned output paths', async () => {
    await fsp.writeFile(path.join(vault, 'Home.md'), 'user content', 'utf-8');

    const schema = await parseSchema(path.join(MINIMAL_SHARD, 'shard-schema.yaml'));
    const selections = defaultModuleSelections(schema);
    const { outputs } = await planOutputs(schema, MINIMAL_SHARD, selections);
    const collisions = await detectCollisions(vault, outputs.map((o) => o.outputPath));

    expect(collisions.length).toBeGreaterThan(0);
    expect(collisions.some((c) => c.outputPath === 'Home.md')).toBe(true);
  });

  it('backupCollisions renames existing files out of the way', async () => {
    await fsp.writeFile(path.join(vault, 'Home.md'), 'user content', 'utf-8');

    const schema = await parseSchema(path.join(MINIMAL_SHARD, 'shard-schema.yaml'));
    const selections = defaultModuleSelections(schema);
    const { outputs } = await planOutputs(schema, MINIMAL_SHARD, selections);
    const collisions = await detectCollisions(vault, outputs.map((o) => o.outputPath));

    const backups = await backupCollisions(collisions);
    expect(backups.length).toBeGreaterThan(0);
    await expect(fsp.access(path.join(vault, 'Home.md'))).rejects.toThrow();
    await expect(fsp.access(backups[0]!.backupPath)).resolves.toBeUndefined();
  });

  it('refuses to install when shard-values.yaml already exists', async () => {
    await fsp.writeFile(path.join(vault, 'shard-values.yaml'), 'user_name: Old\n', 'utf-8');

    const manifest = await parseManifest(path.join(MINIMAL_SHARD, 'shard.yaml'));
    const schema = await parseSchema(path.join(MINIMAL_SHARD, 'shard-schema.yaml'));
    const selections = defaultModuleSelections(schema);
    const validator = buildValuesValidator(schema);
    const values = validator.parse(resolveComputedDefaults(schema, VALUES));

    await expect(
      runInstall({
        vaultRoot: vault,
        manifest,
        schema,
        tempDir: MINIMAL_SHARD,
        resolved: RESOLVED,
      tarballSha256: 'deadbeef',
        values,
        selections,
      }),
    ).rejects.toMatchObject({ code: 'VALUES_FILE_COLLISION' });
  });

  it('planOutputs reports alwaysIncludedFileCount for module-null files', async () => {
    const schema = await parseSchema(path.join(MINIMAL_SHARD, 'shard-schema.yaml'));
    const selections = defaultModuleSelections(schema);
    const { alwaysIncludedFileCount } = await planOutputs(schema, MINIMAL_SHARD, selections);
    // minimal-shard: CLAUDE.md.njk and Home.md.njk have no module (no paths match)
    expect(alwaysIncludedFileCount).toBeGreaterThanOrEqual(2);
  });

  it('rollback restores backed-up files', async () => {
    const original = path.join(vault, 'Home.md');
    await fsp.writeFile(original, 'user content', 'utf-8');

    const manifest = await parseManifest(path.join(MINIMAL_SHARD, 'shard.yaml'));
    const schema = await parseSchema(path.join(MINIMAL_SHARD, 'shard-schema.yaml'));
    const selections = defaultModuleSelections(schema);
    const validator = buildValuesValidator(schema);
    const values = validator.parse(resolveComputedDefaults(schema, VALUES));
    const { outputs } = await planOutputs(schema, MINIMAL_SHARD, selections);
    const collisions = await detectCollisions(vault, outputs.map((o) => o.outputPath));
    const backups = await backupCollisions(collisions);

    const result = await runInstall({
      vaultRoot: vault,
      manifest,
      schema,
      tempDir: MINIMAL_SHARD,
      resolved: RESOLVED,
      tarballSha256: 'deadbeef',
      values,
      selections,
    });

    // Simulate a post-install failure and roll back
    await rollbackInstall(vault, result.writtenPaths, backups);

    const restored = await fsp.readFile(original, 'utf-8');
    expect(restored).toBe('user content');
  });

  it('rollback removes all written files and the .shardmind directory', async () => {
    const manifest = await parseManifest(path.join(MINIMAL_SHARD, 'shard.yaml'));
    const schema = await parseSchema(path.join(MINIMAL_SHARD, 'shard-schema.yaml'));
    const selections = defaultModuleSelections(schema);
    const validator = buildValuesValidator(schema);
    const values = validator.parse(resolveComputedDefaults(schema, VALUES));

    const result = await runInstall({
      vaultRoot: vault,
      manifest,
      schema,
      tempDir: MINIMAL_SHARD,
      resolved: RESOLVED,
      tarballSha256: 'deadbeef',
      values,
      selections,
    });

    await rollbackInstall(vault, result.writtenPaths);

    // All originally-written files are gone
    for (const p of result.writtenPaths) {
      await expect(fsp.access(path.join(vault, p))).rejects.toThrow();
    }
    // .shardmind/ is gone
    await expect(fsp.access(path.join(vault, '.shardmind'))).rejects.toThrow();
  });
});
