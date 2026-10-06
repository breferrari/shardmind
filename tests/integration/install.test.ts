import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import type { PathLike } from 'node:fs';
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
import { runInstall } from '../../source/core/install-executor.js';
import { beginTransaction, type VaultTransaction } from '../../source/core/vault-transaction.js';
import { runHook } from '../../source/core/hook.js';
import type { ResolvedShard, ShardState } from '../../source/runtime/types.js';
import { makeShardSource } from '../helpers/make-shard-source.js';

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
    expect(state.schema_version).toBe(2);
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

  it('records ref + resolvedSha when ResolvedShard.ref is set (ref install)', async () => {
    // `ref` and `resolvedSha` are only persisted when the user
    // installed via `github:owner/repo#<ref>`. The install-machine
    // sources them from `ResolvedShard.ref`; here we simulate that
    // resolve outcome and assert the round-trip into `state.json`.
    const manifest = await parseManifest(path.join(MINIMAL_SHARD, '.shardmind', 'shard.yaml'));
    const schema = await parseSchema(path.join(MINIMAL_SHARD, '.shardmind', 'shard-schema.yaml'));
    const selections = defaultModuleSelections(schema);
    const validator = buildValuesValidator(schema);
    const values = validator.parse(resolveComputedDefaults(schema, VALUES));

    const SHA = 'a'.repeat(40);
    const refResolved: ResolvedShard = {
      ...RESOLVED,
      version: SHA.slice(0, 7),
      ref: { name: 'main', commit: SHA },
    };

    await runInstall({
      vaultRoot: vault,
      manifest,
      schema,
      tempDir: MINIMAL_SHARD,
      resolved: refResolved,
      tarballSha256: 'deadbeef',
      values,
      selections,
    });

    const state = (await readState(vault)) as ShardState;
    expect(state.ref).toBe('main');
    expect(state.resolvedSha).toBe(SHA);
    // `state.version` always tracks `manifest.version`, never the SHA —
    // so semver-aware migrations keep working for ref installs.
    expect(state.version).toBe('0.1.0');

    // Round-trip through JSON to confirm no `null` is emitted for
    // missing optional fields elsewhere — the spread-on-presence guard
    // in install-executor.ts depends on `JSON.stringify` not stamping
    // `undefined` keys, but the persistence path is what we actually
    // care about.
    const onDisk = await fsp.readFile(path.join(vault, '.shardmind/state.json'), 'utf-8');
    expect(onDisk).toContain('"ref": "main"');
    expect(onDisk).toContain(`"resolvedSha": "${SHA}"`);
  });

  it('omits ref + resolvedSha for tag installs', async () => {
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
      resolved: RESOLVED, // No `ref` field.
      tarballSha256: 'deadbeef',
      values,
      selections,
    });

    const state = (await readState(vault)) as ShardState;
    expect(state.ref).toBeUndefined();
    expect(state.resolvedSha).toBeUndefined();
    // The persisted JSON has no `ref` / `resolvedSha` keys at all —
    // not `null`, not `undefined`. Pre-#76 readers stay happy.
    const onDisk = await fsp.readFile(path.join(vault, '.shardmind/state.json'), 'utf-8');
    expect(onDisk).not.toContain('"ref"');
    expect(onDisk).not.toContain('"resolvedSha"');
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

  describe('_each templates (#214)', () => {
    async function eachShard(): Promise<string> {
      const dir = path.join(os.tmpdir(), `shardmind-each-${crypto.randomUUID()}`);
      return makeShardSource(dir, { 'people/_each.md.njk': '# {{ item.name }}\n' });
    }

    it('planOutputs with values lists the paths an _each template expands to', async () => {
      const shard = await eachShard();
      try {
        const schema = await parseSchema(path.join(MINIMAL_SHARD, '.shardmind', 'shard-schema.yaml'));
        const selections = defaultModuleSelections(schema);
        const values = { people: [{ name: 'Alice', slug: 'alice' }, { name: 'Bob/Ops.' }] };
        const { outputs } = await planOutputs(schema, shard, selections, values);
        const paths = outputs.map((o) => o.outputPath).sort();
        // Bob/Ops. has no slug: the name, sanitized as renderEach does.
        expect(paths).toEqual(['people/Bob-Ops.md', 'people/alice.md']);
      } finally {
        await fsp.rm(shard, { recursive: true, force: true });
      }
    });

    it('alternative modules: both selected is refused, either one alone plans cleanly (#240)', async () => {
      const dir = path.join(os.tmpdir(), `shardmind-alt-${crypto.randomUUID()}`);
      const shard = await makeShardSource(dir, {
        'alt/start.md': 'simple\n',
        'alt/Start.md.njk': 'fancy\n',
      });
      try {
        const base = await parseSchema(path.join(MINIMAL_SHARD, '.shardmind', 'shard-schema.yaml'));
        const schema = {
          ...base,
          modules: {
            ...base.modules,
            simple: { label: 'Simple', paths: ['alt/start.md'], removable: true },
            fancy: { label: 'Fancy', paths: ['alt/Start.md.njk'], removable: true },
          },
        } as typeof base;
        const both = { ...defaultModuleSelections(schema), simple: 'included', fancy: 'included' } as const;
        await expect(planOutputs(schema, shard, both, {})).rejects.toMatchObject({ code: 'OUTPUT_PATH_CLASH' });
        for (const only of ['simple', 'fancy'] as const) {
          const selections = { ...both, [only === 'simple' ? 'fancy' : 'simple']: 'excluded' } as const;
          const { outputs } = await planOutputs(schema, shard, selections, {});
          expect(outputs.filter((o) => o.outputPath.toLowerCase() === 'alt/start.md')).toHaveLength(1);
        }
      } finally {
        await fsp.rm(dir, { recursive: true, force: true });
      }
    });

    it('planOutputs refuses a static file and an _each expansion that name one file (#240)', async () => {
      const dir = path.join(os.tmpdir(), `shardmind-each-${crypto.randomUUID()}`);
      const shard = await makeShardSource(dir, {
        'people/_each.md.njk': '# {{ item }}\n',
        'people/alice.md': 'a static page\n',
      });
      try {
        const schema = await parseSchema(path.join(MINIMAL_SHARD, '.shardmind', 'shard-schema.yaml'));
        await expect(
          planOutputs(schema, shard, defaultModuleSelections(schema), { people: ['Alice'] }),
        ).rejects.toMatchObject({ code: 'OUTPUT_PATH_CLASH' });
      } finally {
        await fsp.rm(shard, { recursive: true, force: true });
      }
    });

    it('planOutputs refuses two items that name the same file, before anything is written (#234)', async () => {
      const shard = await eachShard();
      try {
        const schema = await parseSchema(path.join(MINIMAL_SHARD, '.shardmind', 'shard-schema.yaml'));
        const values = { people: [{ name: 'Alice' }, { name: 'alice' }] };
        await expect(
          planOutputs(schema, shard, defaultModuleSelections(schema), values),
        ).rejects.toMatchObject({ code: 'RENDER_ITERATOR_NAME_CLASH' });
        expect(await fsp.readdir(vault)).toEqual([]);
      } finally {
        await fsp.rm(shard, { recursive: true, force: true });
      }
    });

    it('planOutputs without values keeps the template path (module review, before values exist)', async () => {
      const shard = await eachShard();
      try {
        const schema = await parseSchema(path.join(MINIMAL_SHARD, '.shardmind', 'shard-schema.yaml'));
        const { outputs } = await planOutputs(schema, shard, defaultModuleSelections(schema));
        expect(outputs.map((o) => o.outputPath)).toEqual(['people/_each.md']);
      } finally {
        await fsp.rm(shard, { recursive: true, force: true });
      }
    });

    it('detectCollisions finds a user file at an _each-expanded path, so it gets backed up', async () => {
      const shard = await eachShard();
      try {
        await fsp.mkdir(path.join(vault, 'people'), { recursive: true });
        await fsp.writeFile(path.join(vault, 'people', 'alice.md'), 'my own notes on alice\n', 'utf-8');
        const schema = await parseSchema(path.join(MINIMAL_SHARD, '.shardmind', 'shard-schema.yaml'));
        const values = { people: [{ name: 'Alice', slug: 'alice' }] };
        const { outputs } = await planOutputs(schema, shard, defaultModuleSelections(schema), values);
        const collisions = await detectCollisions(vault, outputs.map((o) => o.outputPath));
        expect(collisions.map((c) => c.outputPath)).toEqual(['people/alice.md']);
      } finally {
        await fsp.rm(shard, { recursive: true, force: true });
      }
    });
  });

  it('moves each planned collision out of the way (#301)', async () => {
    await fsp.writeFile(path.join(vault, 'Home.md'), 'user content', 'utf-8');

    const schema = await parseSchema(path.join(MINIMAL_SHARD, '.shardmind', 'shard-schema.yaml'));
    const selections = defaultModuleSelections(schema);
    const { outputs } = await planOutputs(schema, MINIMAL_SHARD, selections);
    const collisions = await detectCollisions(vault, outputs.map((o) => o.outputPath));

    const tx = await beginTransaction(vault, { kind: 'install', noPriorInstall: true });
    const backups = [];
    for (const c of collisions) backups.push(await tx.recordSetAside(c.absolutePath, true));
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

  /** The minimal shard installed on a transaction, as `runInstallTransaction` runs it. */
  async function installOn(tx: VaultTransaction) {
    const manifest = await parseManifest(path.join(MINIMAL_SHARD, '.shardmind', 'shard.yaml'));
    const schema = await parseSchema(path.join(MINIMAL_SHARD, '.shardmind', 'shard-schema.yaml'));
    const selections = defaultModuleSelections(schema);
    const values = buildValuesValidator(schema).parse(resolveComputedDefaults(schema, VALUES));
    return runInstall({
      vaultRoot: vault, manifest, schema, tempDir: MINIMAL_SHARD, resolved: RESOLVED,
      tarballSha256: 'deadbeef', values, selections, tx,
    });
  }
  const beginInstall = () => beginTransaction(vault, { kind: 'install', noPriorInstall: true });

  it('rollback restores backed-up files', async () => {
    const original = path.join(vault, 'Home.md');
    await fsp.writeFile(original, 'user content', 'utf-8');
    const tx = await beginInstall();
    await tx.recordSetAside(original, true);
    await installOn(tx);

    // Simulate a failure after install and roll back
    expect(await tx.rollback()).toEqual([]);

    expect(await fsp.readFile(original, 'utf-8')).toBe('user content');
  });

  it("rollback reports a written file it could not remove, never a folder that is the user's (#247)", async () => {
    const tx = await beginInstall();
    await tx.recordWrite('Locked.md');
    await fsp.writeFile(path.join(vault, 'Locked.md'), 'shard content', 'utf-8');
    await tx.recordWrite('Theirs.md');
    // A folder the user put at a recorded file path during the run.
    await fsp.mkdir(path.join(vault, 'Theirs.md', 'inside'), { recursive: true });
    const lockedAbs = path.join(vault, 'Locked.md');
    const realRm = fsp.rm;
    const spy = vi.spyOn(fsp, 'rm').mockImplementation(async (p, o) => {
      if (p === lockedAbs) throw Object.assign(new Error('simulated EBUSY'), { code: 'EBUSY' });
      return realRm(p, o);
    });
    try {
      const failures = await tx.rollback();
      expect(failures).toEqual([{ path: 'Locked.md', reason: 'unlink failed: simulated EBUSY' }]);
    } finally {
      spy.mockRestore();
    }
    expect((await fsp.stat(path.join(vault, 'Theirs.md'))).isDirectory()).toBe(true);
  });

  it('rollback reports a folder it created that rmdir refuses for another reason than holding files (#258)', async () => {
    const tx = await beginInstall();
    await tx.recordWrite('made/Note.md');
    await fsp.mkdir(path.join(vault, 'made'));
    const madeAbs = path.join(vault, 'made');
    const realRmdir = fsp.rmdir;
    const spy = vi.spyOn(fsp, 'rmdir').mockImplementation(async (p: PathLike) => {
      if (p === madeAbs) throw Object.assign(new Error('simulated EBUSY'), { code: 'EBUSY' });
      return realRmdir(p);
    });
    try {
      const failures = await tx.rollback();
      expect(failures).toEqual([{ path: 'made', reason: 'remove failed: simulated EBUSY' }]);
    } finally {
      spy.mockRestore();
    }
  });

  it('rollback removes all written files and the .shardmind directory', async () => {
    const tx = await beginInstall();
    const result = await installOn(tx);

    expect(await tx.rollback()).toEqual([]);

    // All originally-written files are gone
    for (const p of result.writtenPaths) {
      await expect(fsp.access(path.join(vault, p))).rejects.toThrow();
    }
    // .shardmind/ is gone: the install created it, and it is empty again
    await expect(fsp.access(path.join(vault, '.shardmind'))).rejects.toThrow();
    expect(await fsp.readdir(vault)).toEqual([]);
  });

  describe('rollback removes only what the install made (#215)', () => {
    it("keeps the user's .shardmind/ file and an empty folder they made", async () => {
      await fsp.mkdir(path.join(vault, '.shardmind'), { recursive: true });
      await fsp.writeFile(path.join(vault, '.shardmind', 'boundary-ignore'), 'archive/\n', 'utf-8');
      await fsp.mkdir(path.join(vault, 'brain'), { recursive: true });
      const tx = await beginInstall();
      await installOn(tx);

      expect(await tx.rollback()).toEqual([]);

      expect((await fsp.readdir(vault)).sort()).toEqual(['.shardmind', 'brain']);
      expect(await fsp.readdir(path.join(vault, '.shardmind'))).toEqual(['boundary-ignore']);
      expect(await fsp.readdir(path.join(vault, 'brain'))).toEqual([]);
    });

    it('leaves a folder the user put at a planned file path', async () => {
      const tx = await beginInstall();
      await installOn(tx);
      // Simulate a folder that appeared at a recorded file path.
      await fsp.unlink(path.join(vault, 'Home.md'));
      await fsp.mkdir(path.join(vault, 'Home.md'));
      await fsp.writeFile(path.join(vault, 'Home.md', 'mine.txt'), 'mine\n', 'utf-8');
      await tx.rollback();
      expect(await fsp.readFile(path.join(vault, 'Home.md', 'mine.txt'), 'utf-8')).toBe('mine\n');
    });
  });
});

/**
 * Hook integration: verify that a full install followed by a real
 * bootstrap hook execution produces the expected combined effect —
 * files rendered AND hook-produced artifacts present. The unit tests in
 * `tests/unit/hook.test.ts` cover executeHook in isolation; this test
 * pins the timing contract (state.json already on disk when the hook
 * fires) and the end-to-end shape the command machine orchestrates.
 *
 * Each test builds a throwaway shard copy with a hooks/ directory so
 * the minimal-shard fixture stays hook-file-free (its shard.yaml
 * declares a hook for contract-testing purposes, but no file on disk).
 */
describe('install + bootstrap hook integration', () => {
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

  it('runs the bootstrap hook after state.json is written', async () => {
    // Hook writes a marker AND a side-file containing the serialized
    // BootstrapContext it received — asserts the full ctx shape round-trips.
    await fsp.writeFile(
      path.join(shardDir, 'hooks', 'bootstrap.ts'),
      `
        import { writeFile } from 'node:fs/promises';
        import { join } from 'node:path';
        export default async function (ctx) {
          // Assert state.json exists BEFORE the hook runs — this is the
          // point-of-no-return contract that the command machine relies on.
          const { access } = await import('node:fs/promises');
          await access(join(ctx.vaultRoot, '.shardmind', 'state.json'));
          await writeFile(join(ctx.vaultRoot, 'bootstrap-marker.txt'), 'ran');
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

    const hookResult = await runHook(
      shardDir,
      manifest.hooks.bootstrap?.script,
      {
        slot: 'bootstrap',
        vaultRoot: vault,
        values,
        modules: selections,
        shard: { name: manifest.name, version: manifest.version },
        valuesAreDefaults: false,
        removedFiles: [],
      },
    );
    expect(hookResult.kind).toBe('ran');
    if (hookResult.kind !== 'ran') throw new Error('narrowing');
    expect(hookResult.exitCode).toBe(0);

    // Marker confirms hook side effects landed.
    const marker = await fsp.readFile(path.join(vault, 'bootstrap-marker.txt'), 'utf-8');
    expect(marker).toBe('ran');

    // BootstrapContext fields round-tripped through the subprocess. The hook
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
      path.join(shardDir, 'hooks', 'bootstrap.ts'),
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

    const hookResult = await runHook(shardDir, manifest.hooks.bootstrap?.script, {
      slot: 'bootstrap',
      vaultRoot: vault,
      values,
      modules: selections,
      shard: { name: manifest.name, version: manifest.version },
      valuesAreDefaults: false,
      removedFiles: [],
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
