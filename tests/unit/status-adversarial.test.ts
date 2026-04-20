/**
 * Adversarial tests for the status report builder.
 *
 * These probe inputs that can legitimately appear in a broken / clock-skewed /
 * partially-migrated vault and assert the aggregator produces a usable report
 * instead of throwing. The status command is the one read-only, non-
 * interactive surface users invoke ambiently; a status crash is a much worse
 * UX failure than any missing piece of information.
 *
 * Scope matches the adversarial style set by `merge-adversarial.test.ts` and
 * `update-adversarial.test.ts` — per-test assertions, minimal setup, real FS.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { parseManifest } from '../../source/core/manifest.js';
import { parseSchema, buildValuesValidator } from '../../source/core/schema.js';
import {
  defaultModuleSelections,
  resolveComputedDefaults,
} from '../../source/core/install-planner.js';
import { runInstall } from '../../source/core/install-executor.js';
import { buildStatusReport } from '../../source/core/status.js';
import { readState } from '../../source/core/state.js';
import { SHARDMIND_DIR, CACHED_MANIFEST, STATE_FILE } from '../../source/runtime/vault-paths.js';
import type { ResolvedShard, ShardState } from '../../source/runtime/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MINIMAL_SHARD = path.resolve(__dirname, '../../examples/minimal-shard');

const RESOLVED: ResolvedShard = {
  namespace: 'shardmind',
  name: 'minimal',
  version: '0.1.0',
  source: 'github:breferrari/minimal-shard',
  tarballUrl: 'n/a (local fixture)',
};

const VALUES = {
  user_name: 'Alice',
  org_name: 'Acme Labs',
  vault_purpose: 'engineering' as const,
  qmd_enabled: true,
};

async function installMinimal(vault: string): Promise<void> {
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
    tarballSha256: 'local-fixture',
    values,
    selections,
  });
}

describe('status (adversarial)', () => {
  let vault: string;

  beforeEach(async () => {
    vault = path.join(os.tmpdir(), `shardmind-status-adv-${crypto.randomUUID()}`);
    await fsp.mkdir(vault, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(vault, { recursive: true, force: true });
  });

  it('degrades gracefully when the cached shard.yaml is deleted (synthesizes minimal manifest)', async () => {
    await installMinimal(vault);
    await fsp.rm(path.join(vault, CACHED_MANIFEST));

    const report = await buildStatusReport(vault, {
      verbose: false,
      skipUpdateCheck: true,
    });
    expect(report).not.toBeNull();
    expect(report!.manifest.version).toBe('0.1.0');
    expect(report!.manifest.namespace).toBe('shardmind');
    expect(
      report!.warnings.some(w => w.message.includes('manifest could not be loaded')),
    ).toBe(true);
  });

  it('survives an `installed_at` in the future (clock skew)', async () => {
    await installMinimal(vault);
    const state = (await readState(vault)) as ShardState;
    const future = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
    const withFuture: ShardState = { ...state, installed_at: future, updated_at: future };
    await fsp.writeFile(
      path.join(vault, STATE_FILE),
      JSON.stringify(withFuture, null, 2),
      'utf-8',
    );

    const report = await buildStatusReport(vault, {
      verbose: false,
      skipUpdateCheck: true,
    });
    expect(report!.installedAgo).toBe('just now');
    // When installed_at === updated_at the updatedAgo row should not duplicate.
    expect(report!.updatedAgo).toBeNull();
  });

  it('handles hundreds of orphan files without exploding the path list', async () => {
    await installMinimal(vault);

    // Orphans land in any directory that holds a tracked file. `brain/` is a
    // tracked module dir in minimal-shard — create 200 orphans there.
    const brainDir = path.join(vault, 'brain');
    await fsp.mkdir(brainDir, { recursive: true });
    for (let i = 0; i < 200; i++) {
      await fsp.writeFile(path.join(brainDir, `orphan-${i}.md`), '# orphan\n', 'utf-8');
    }

    const report = await buildStatusReport(vault, {
      verbose: true,
      skipUpdateCheck: true,
    });
    expect(report!.drift.orphaned).toBe(200);
    expect(report!.drift.orphanedPaths.length).toBeLessThanOrEqual(20);
    expect(report!.drift.truncated).toBe(true);
  });

  it('surfaces invalid values.yaml contents without throwing', async () => {
    await installMinimal(vault);
    // Clobber values with a type-wrong field (qmd_enabled should be boolean).
    await fsp.writeFile(
      path.join(vault, 'shard-values.yaml'),
      'user_name: Alice\norg_name: Acme\nvault_purpose: engineering\nqmd_enabled: "this-should-be-bool"\n',
      'utf-8',
    );

    const report = await buildStatusReport(vault, {
      verbose: false,
      skipUpdateCheck: true,
    });
    expect(report!.values.valid).toBe(false);
    expect(report!.values.invalidKeys).toContain('qmd_enabled');
    expect(report!.values.fileMissing).toBe(false);
  });

  it('survives values.yaml that is not a YAML mapping', async () => {
    await installMinimal(vault);
    await fsp.writeFile(path.join(vault, 'shard-values.yaml'), '- just\n- a list\n', 'utf-8');

    const report = await buildStatusReport(vault, {
      verbose: false,
      skipUpdateCheck: true,
    });
    expect(report!.values.fileMissing).toBe(true);
    expect(report).not.toBeNull();
  });

  it('survives a totally empty but extant values.yaml', async () => {
    await installMinimal(vault);
    await fsp.writeFile(path.join(vault, 'shard-values.yaml'), '', 'utf-8');

    const report = await buildStatusReport(vault, {
      verbose: false,
      skipUpdateCheck: true,
    });
    // Empty file parses to null → our loader treats as file-missing.
    expect(report!.values.fileMissing).toBe(true);
  });

  it('reports `unknown` update status for an unsupported source scheme', async () => {
    await installMinimal(vault);
    const state = (await readState(vault)) as ShardState;
    const withExotic: ShardState = { ...state, source: 'file:///path/to/experimental' };
    await fsp.writeFile(
      path.join(vault, STATE_FILE),
      JSON.stringify(withExotic, null, 2),
      'utf-8',
    );

    const report = await buildStatusReport(vault, {
      verbose: false,
      skipUpdateCheck: false,
    });
    expect(report!.update).toMatchObject({
      kind: 'unknown',
      reason: 'unsupported-source',
    });
  });

  it('keeps running when a managed tracked file is a directory (permissions edge)', async () => {
    await installMinimal(vault);

    // Replace a managed file with a directory. `detectDrift` should bucket
    // this without throwing, and status should still render.
    const targetPath = path.join(vault, 'Home.md');
    await fsp.rm(targetPath);
    await fsp.mkdir(targetPath);

    const report = await buildStatusReport(vault, {
      verbose: false,
      skipUpdateCheck: true,
    });
    // Whichever bucket drift places it in, the report is built.
    expect(report).not.toBeNull();
  });

  it('synthesizes a safe manifest when state.shard is null (manual state.json corruption)', async () => {
    await installMinimal(vault);
    await fsp.rm(path.join(vault, CACHED_MANIFEST));
    const state = (await readState(vault)) as ShardState;
    // ShardState.shard is typed string but readState doesn't do field-level
    // runtime validation, so a hand-edited state.json can land here with any
    // shape. synthesizeManifest must not crash on .split() of null.
    const broken = { ...state, shard: null as unknown as string };
    await fsp.writeFile(path.join(vault, STATE_FILE), JSON.stringify(broken), 'utf-8');

    const report = await buildStatusReport(vault, {
      verbose: false,
      skipUpdateCheck: true,
    });
    expect(report).not.toBeNull();
    expect(report!.manifest.namespace).toBe('unknown');
    expect(report!.manifest.name).toBe('unknown');
  });

  it('synthesizes a safe manifest when state.shard is whitespace-only', async () => {
    await installMinimal(vault);
    await fsp.rm(path.join(vault, CACHED_MANIFEST));
    const state = (await readState(vault)) as ShardState;
    const broken: ShardState = { ...state, shard: '   ' };
    await fsp.writeFile(path.join(vault, STATE_FILE), JSON.stringify(broken), 'utf-8');

    const report = await buildStatusReport(vault, {
      verbose: false,
      skipUpdateCheck: true,
    });
    expect(report!.manifest.namespace).toBe('unknown');
    expect(report!.manifest.name).toBe('unknown');
  });

  it('synthesizes a safe manifest when state.shard is an object (malformed from a buggy writer)', async () => {
    await installMinimal(vault);
    await fsp.rm(path.join(vault, CACHED_MANIFEST));
    const state = (await readState(vault)) as ShardState;
    const broken = {
      ...state,
      // Simulate a pathological older-version state.json that stored shard
      // as a structured object instead of "namespace/name".
      shard: { namespace: 'x', name: 'y' } as unknown as string,
    };
    await fsp.writeFile(path.join(vault, STATE_FILE), JSON.stringify(broken), 'utf-8');

    const report = await buildStatusReport(vault, {
      verbose: false,
      skipUpdateCheck: true,
    });
    expect(report).not.toBeNull();
    expect(report!.manifest.namespace).toBe('unknown');
    expect(report!.manifest.name).toBe('unknown');
  });

  it('synthesizes "unknown" for state.version that is the empty string', async () => {
    await installMinimal(vault);
    await fsp.rm(path.join(vault, CACHED_MANIFEST));
    const state = (await readState(vault)) as ShardState;
    const broken: ShardState = { ...state, version: '' };
    await fsp.writeFile(path.join(vault, STATE_FILE), JSON.stringify(broken), 'utf-8');

    const report = await buildStatusReport(vault, {
      verbose: false,
      skipUpdateCheck: true,
    });
    expect(report!.manifest.version).toBe('unknown');
  });

  it('synthesizes a safe manifest when state.shard has no slash', async () => {
    await installMinimal(vault);
    await fsp.rm(path.join(vault, CACHED_MANIFEST));
    const state = (await readState(vault)) as ShardState;
    const broken: ShardState = { ...state, shard: 'solo' };
    await fsp.writeFile(path.join(vault, STATE_FILE), JSON.stringify(broken), 'utf-8');

    const report = await buildStatusReport(vault, {
      verbose: false,
      skipUpdateCheck: true,
    });
    expect(report!.manifest.namespace).toBe('solo');
    expect(report!.manifest.name).toBe('unknown');
  });

  it('handles very long shard identifiers in the synthesized manifest fallback', async () => {
    await installMinimal(vault);
    await fsp.rm(path.join(vault, CACHED_MANIFEST));

    const state = (await readState(vault)) as ShardState;
    const longId = 'x'.repeat(40) + '/' + 'y'.repeat(40);
    const withLong: ShardState = { ...state, shard: longId };
    await fsp.writeFile(
      path.join(vault, STATE_FILE),
      JSON.stringify(withLong, null, 2),
      'utf-8',
    );

    const report = await buildStatusReport(vault, {
      verbose: false,
      skipUpdateCheck: true,
    });
    expect(report!.manifest.namespace.length).toBe(40);
    expect(report!.manifest.name.length).toBe(40);
  });

  it('caps the modified paths list at 20 and marks truncated', async () => {
    await installMinimal(vault);

    // Modify every managed .md file (there are few, but any content tweak
    // flips the hash). To guarantee > 20 modifications, write extra files
    // that would be classified as modified requires them to be in
    // state.files first. Easier: synthesize state with a ton of modified
    // entries.
    const state = (await readState(vault)) as ShardState;
    const fakeFiles: typeof state.files = { ...state.files };
    for (let i = 0; i < 30; i++) {
      const relPath = `brain/modified-${i}.md`;
      fakeFiles[relPath] = {
        template: null,
        rendered_hash: 'deadbeef',
        ownership: 'managed',
      };
      await fsp.mkdir(path.join(vault, 'brain'), { recursive: true });
      await fsp.writeFile(path.join(vault, relPath), `mismatch-${i}`, 'utf-8');
    }
    const withMods: ShardState = { ...state, files: fakeFiles };
    await fsp.writeFile(
      path.join(vault, STATE_FILE),
      JSON.stringify(withMods, null, 2),
      'utf-8',
    );

    const report = await buildStatusReport(vault, {
      verbose: true,
      skipUpdateCheck: true,
    });
    expect(report!.drift.modified).toBe(30);
    expect(report!.drift.modifiedPaths.length).toBe(20);
    expect(report!.drift.truncated).toBe(true);
  });
});
