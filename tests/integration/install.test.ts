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
import { runPostInstallHook } from '../../source/core/hook.js';
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
    const manifest = await parseManifest(path.join(MINIMAL_SHARD, '.shardmind', 'shard.yaml'));
    const schema = await parseSchema(path.join(MINIMAL_SHARD, '.shardmind', 'shard-schema.yaml'));

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
    const manifest = await parseManifest(path.join(MINIMAL_SHARD, '.shardmind', 'shard.yaml'));
    const schema = await parseSchema(path.join(MINIMAL_SHARD, '.shardmind', 'shard-schema.yaml'));

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
    const manifest = await parseManifest(path.join(MINIMAL_SHARD, '.shardmind', 'shard.yaml'));
    const schema = await parseSchema(path.join(MINIMAL_SHARD, '.shardmind', 'shard-schema.yaml'));
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
    const manifest = await parseManifest(path.join(MINIMAL_SHARD, '.shardmind', 'shard.yaml'));
    const schema = await parseSchema(path.join(MINIMAL_SHARD, '.shardmind', 'shard-schema.yaml'));
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
    const schema = await parseSchema(path.join(MINIMAL_SHARD, '.shardmind', 'shard-schema.yaml'));
    const selections = defaultModuleSelections(schema);
    const { moduleFileCounts, outputs } = await planOutputs(schema, MINIMAL_SHARD, selections);

    expect(outputs.length).toBeGreaterThan(0);
    expect(moduleFileCounts['brain']).toBeGreaterThan(0);
    // extras contributes a command and a partial; the partial has no output file on its own
    expect(moduleFileCounts['extras']).toBeGreaterThanOrEqual(1);
  });

  it('collision detection flags pre-existing files at planned output paths', async () => {
    await fsp.writeFile(path.join(vault, 'Home.md'), 'user content', 'utf-8');

    const schema = await parseSchema(path.join(MINIMAL_SHARD, '.shardmind', 'shard-schema.yaml'));
    const selections = defaultModuleSelections(schema);
    const { outputs } = await planOutputs(schema, MINIMAL_SHARD, selections);
    const collisions = await detectCollisions(vault, outputs.map((o) => o.outputPath));

    expect(collisions.length).toBeGreaterThan(0);
    expect(collisions.some((c) => c.outputPath === 'Home.md')).toBe(true);
  });

  it('backupCollisions renames existing files out of the way', async () => {
    await fsp.writeFile(path.join(vault, 'Home.md'), 'user content', 'utf-8');

    const schema = await parseSchema(path.join(MINIMAL_SHARD, '.shardmind', 'shard-schema.yaml'));
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

    const manifest = await parseManifest(path.join(MINIMAL_SHARD, '.shardmind', 'shard.yaml'));
    const schema = await parseSchema(path.join(MINIMAL_SHARD, '.shardmind', 'shard-schema.yaml'));
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
    const schema = await parseSchema(path.join(MINIMAL_SHARD, '.shardmind', 'shard-schema.yaml'));
    const selections = defaultModuleSelections(schema);
    const { alwaysIncludedFileCount } = await planOutputs(schema, MINIMAL_SHARD, selections);
    // minimal-shard: CLAUDE.md (static), Home.md.njk, .claude/settings.json.njk
    // all sit outside any module's `paths`/`commands`/`agents` claim.
    expect(alwaysIncludedFileCount).toBeGreaterThanOrEqual(2);
  });

  it('rollback restores backed-up files', async () => {
    const original = path.join(vault, 'Home.md');
    await fsp.writeFile(original, 'user content', 'utf-8');

    const manifest = await parseManifest(path.join(MINIMAL_SHARD, '.shardmind', 'shard.yaml'));
    const schema = await parseSchema(path.join(MINIMAL_SHARD, '.shardmind', 'shard-schema.yaml'));
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
    const manifest = await parseManifest(path.join(MINIMAL_SHARD, '.shardmind', 'shard.yaml'));
    const schema = await parseSchema(path.join(MINIMAL_SHARD, '.shardmind', 'shard-schema.yaml'));
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

/**
 * Hook integration: verify that a full install followed by a real
 * post-install hook execution produces the expected combined effect —
 * files rendered AND hook-produced artifacts present. The unit tests in
 * `tests/unit/hook.test.ts` cover executeHook in isolation; this test
 * pins the timing contract (state.json already on disk when the hook
 * fires) and the end-to-end shape the command machine orchestrates.
 *
 * Each test builds a throwaway shard copy with a hooks/ directory so
 * the minimal-shard fixture stays hook-file-free (its shard.yaml
 * declares a hook for contract-testing purposes, but no file on disk).
 */
describe('install + post-install hook integration', () => {
  let vault: string;
  let shardDir: string;

  beforeEach(async () => {
    vault = path.join(os.tmpdir(), `shardmind-install-hook-${crypto.randomUUID()}`);
    shardDir = path.join(os.tmpdir(), `shardmind-shard-${crypto.randomUUID()}`);
    await fsp.mkdir(vault, { recursive: true });
    await copyDir(MINIMAL_SHARD, shardDir);
    await fsp.mkdir(path.join(shardDir, 'hooks'), { recursive: true });
  });

  afterEach(async () => {
    // Windows: a child process that was SIGTERM'd mid-hook may still hold
    // a handle on `cwd: vault` for a few milliseconds after the parent's
    // promise resolves. `{ maxRetries, retryDelay }` tolerates that
    // window instead of flaking the test with EBUSY. Mirrors the
    // convention the unit-hook tests adopted in the harden round.
    const rmOpts = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };
    await fsp.rm(vault, rmOpts);
    await fsp.rm(shardDir, rmOpts);
  });

  it('runs the post-install hook after state.json is written', async () => {
    // Hook writes a marker AND a side-file containing the serialized
    // HookContext it received — asserts the full ctx shape round-trips.
    await fsp.writeFile(
      path.join(shardDir, 'hooks', 'post-install.ts'),
      `
        import { writeFile } from 'node:fs/promises';
        import { join } from 'node:path';
        export default async function (ctx) {
          // Assert state.json exists BEFORE the hook runs — this is the
          // point-of-no-return contract that the command machine relies on.
          const { access } = await import('node:fs/promises');
          await access(join(ctx.vaultRoot, '.shardmind', 'state.json'));
          await writeFile(join(ctx.vaultRoot, 'post-install-marker.txt'), 'ran');
          await writeFile(
            join(ctx.vaultRoot, '.hook-ctx.json'),
            JSON.stringify(ctx),
          );
        }
      `,
      'utf-8',
    );

    const manifest = await parseManifest(path.join(shardDir, '.shardmind', 'shard.yaml'));
    const schema = await parseSchema(path.join(shardDir, '.shardmind', 'shard-schema.yaml'));
    const selections = defaultModuleSelections(schema);
    const validator = buildValuesValidator(schema);
    const values = validator.parse(resolveComputedDefaults(schema, VALUES));

    await runInstall({
      vaultRoot: vault,
      manifest,
      schema,
      tempDir: shardDir,
      resolved: RESOLVED,
      tarballSha256: 'deadbeef',
      values,
      selections,
    });

    const hookResult = await runPostInstallHook(
      shardDir,
      manifest,
      {
        vaultRoot: vault,
        values,
        modules: selections,
        shard: { name: manifest.name, version: manifest.version },
      },
    );
    expect(hookResult.kind).toBe('ran');
    if (hookResult.kind !== 'ran') throw new Error('narrowing');
    expect(hookResult.exitCode).toBe(0);

    // Marker confirms hook side effects landed.
    const marker = await fsp.readFile(path.join(vault, 'post-install-marker.txt'), 'utf-8');
    expect(marker).toBe('ran');

    // HookContext fields round-tripped through the subprocess. The hook
    // asserted state.json existed at call time; its own write of
    // .hook-ctx.json completing without throwing proves that.
    const echoed = JSON.parse(await fsp.readFile(path.join(vault, '.hook-ctx.json'), 'utf-8'));
    expect(echoed.vaultRoot).toBe(vault);
    expect(echoed.shard).toEqual({ name: manifest.name, version: manifest.version });
    expect(echoed.modules).toEqual(selections);
  }, 30_000);

  it('surfaces a thrown hook as failed but leaves install output intact', async () => {
    // Non-fatal hook contract: the install succeeded (state.json + files
    // on disk), the hook's throw surfaces as a `failed`-shape result, and
    // NO rollback happens. Matches Helm semantics.
    await fsp.writeFile(
      path.join(shardDir, 'hooks', 'post-install.ts'),
      `
        export default async function () {
          throw new Error('hook bombed');
        }
      `,
      'utf-8',
    );

    const manifest = await parseManifest(path.join(shardDir, '.shardmind', 'shard.yaml'));
    const schema = await parseSchema(path.join(shardDir, '.shardmind', 'shard-schema.yaml'));
    const selections = defaultModuleSelections(schema);
    const validator = buildValuesValidator(schema);
    const values = validator.parse(resolveComputedDefaults(schema, VALUES));

    await runInstall({
      vaultRoot: vault,
      manifest,
      schema,
      tempDir: shardDir,
      resolved: RESOLVED,
      tarballSha256: 'deadbeef',
      values,
      selections,
    });

    const hookResult = await runPostInstallHook(shardDir, manifest, {
      vaultRoot: vault,
      values,
      modules: selections,
      shard: { name: manifest.name, version: manifest.version },
    });
    // A thrown hook exits 1 — the runner catches, writes stack to stderr,
    // and exits non-zero. We surface that as `ran` with the exit code so
    // the Summary treats it as a warning (not a spawn failure).
    expect(hookResult.kind).toBe('ran');
    if (hookResult.kind !== 'ran') throw new Error('narrowing');
    expect(hookResult.exitCode).toBe(1);
    expect(hookResult.stderr).toContain('hook bombed');

    // Install output is fully present — state.json, values.yaml, rendered files.
    const state = (await readState(vault)) as ShardState;
    expect(state).not.toBeNull();
    expect(state.version).toBe('0.1.0');
    await expect(fsp.access(path.join(vault, 'Home.md'))).resolves.toBeUndefined();
    await expect(
      fsp.access(path.join(vault, 'shard-values.yaml')),
    ).resolves.toBeUndefined();
  }, 30_000);
});

// Local copy helper — the minimal-shard tree is small and this keeps the
// test file self-contained; `tests/e2e/helpers/tarball.ts` has a richer
// version with symlink detection that this test doesn't need.
async function copyDir(src: string, dst: string): Promise<void> {
  await fsp.mkdir(dst, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) await copyDir(from, to);
    else if (entry.isFile()) await fsp.copyFile(from, to);
  }
}
