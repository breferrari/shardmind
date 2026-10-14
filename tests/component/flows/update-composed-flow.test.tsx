/**
 * Layer 1: `<Update>` on a vault holding several shards (#407). Each
 * shard's questions come in turn, headed with its name, and the run ends in
 * one block per shard. Spec: ARCHITECTURE §10.5 ("Several shards");
 * IMPLEMENTATION §4.30 step 6.10.
 *
 * Spawn-free: the vault is built in-process by the install and add flows,
 * and no shard declares a hook.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { cleanup } from 'ink-testing-library';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { setupFlowSuite, mountUpdate, buildCustomTarball, allFrames } from './helpers.js';
import { tick, waitFor, ENTER, ARROW_DOWN } from '../helpers.js';
import { resetSigintRollbackForTests } from '../../../source/commands/hooks/shared.js';
import { runInstallFlow, type InstallFlowIO } from '../../../source/core/flows/install.js';
import { runAddFlow, type AddFlowIO } from '../../../source/core/flows/add.js';
import { resolveInstallDestination } from '../../../source/core/install-destination.js';
import type { VaultState } from '../../../source/runtime/types.js';

const BASE = 'flowcompose/base';
const OVERLAY = 'flowcompose/research';
const OVERLAY_SCHEMA = {
  schema_version: 1,
  values: { topic: { type: 'string', message: 'Topic', default: 'physics', group: 'setup' } },
  groups: [{ id: 'setup', label: 'Setup' }],
};

describe('update across shards — Layer 1 (#407)', () => {
  const getCtx = setupFlowSuite({
    shards: {
      [BASE]: { versions: {} as Record<string, string>, latest: '0.1.0' },
      [OVERLAY]: { versions: {} as Record<string, string>, latest: '1.0.0' },
    },
  });
  const tarballs: Record<string, string> = {};
  let tarDir: string;
  let vault: string;

  beforeAll(async () => {
    tarDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'shardmind-composed-l1-'));
    for (const version of ['0.1.0', '0.2.0']) {
      tarballs[`base-${version}`] = await buildCustomTarball({
        version,
        prefix: `l1-base-${version}`,
        manifestOverrides: { name: 'base', namespace: 'flowcompose', hooks: {} },
        // Each release retitles CLAUDE.md, so a user's own title conflicts.
        mutate: async (dir) => {
          const file = path.join(dir, 'CLAUDE.md');
          await fsp.writeFile(file, (await fsp.readFile(file, 'utf-8')).replace('# Minimal Shard', `# Minimal Shard ${version}`));
        },
        outDir: tarDir,
      });
    }
    for (const [version, line] of [['1.0.0', 'On {{ topic }}.'], ['2.0.0', 'On {{ topic }}, v2.']] as const) {
      tarballs[`overlay-${version}`] = await buildCustomTarball({
        version,
        prefix: `l1-overlay-${version}`,
        schema: OVERLAY_SCHEMA,
        manifestOverrides: { name: 'research', namespace: 'flowcompose', hooks: {} },
        mutate: async (dir) => {
          for (const entry of await fsp.readdir(dir)) {
            if (entry !== '.shardmind') await fsp.rm(path.join(dir, entry), { recursive: true, force: true });
          }
          await fsp.mkdir(path.join(dir, 'research'));
          await fsp.writeFile(path.join(dir, 'research', 'Papers.md.njk'), `# Papers\n\n${line}\n`);
        },
        outDir: tarDir,
      });
    }
  }, 60_000);

  const serve = (slug: string, version: string, tarball: string) => {
    getCtx().stub.setVersion(slug, version, tarball);
    getCtx().stub.setLatest(slug, version);
  };
  const io = () =>
    ({
      hooks: { setPhase: () => {}, onStdout: () => {}, onStderr: () => {} },
      lock: () => ({ release: () => {} }),
      onCleanup: () => {},
      newRunAbort: () => new AbortController(),
      onRun: () => {},
      onCommitted: () => {},
      onHookAbort: () => {},
      phase: () => {},
      progress: () => {},
      ask: () => Promise.reject(new Error('the setup answers no prompt')),
    }) as InstallFlowIO & AddFlowIO;

  beforeEach(async () => {
    serve(BASE, '0.1.0', tarballs['base-0.1.0']!);
    serve(OVERLAY, '1.0.0', tarballs['overlay-1.0.0']!);
    vault = await fsp.mkdtemp(path.join(os.tmpdir(), 'shardmind-composed-l1-vault-'));
    const shared = { valuesFile: undefined, yes: true, defaults: true, dryRun: false, skipHooks: false, interactive: false, engineVersion: undefined };
    await runInstallFlow(
      { ...shared, shardRef: `github:${BASE}`, force: false, destination: await resolveInstallDestination(vault, `github:${BASE}`, '.') },
      io(),
    );
    await runAddFlow({ ...shared, shardRef: `github:${OVERLAY}`, vaultRoot: vault }, io());
  }, 60_000);

  afterEach(async () => {
    cleanup();
    resetSigintRollbackForTests();
    process.exitCode = undefined;
    await fsp.rm(vault, { recursive: true, force: true });
  });

  const state = async () => JSON.parse(await fsp.readFile(path.join(vault, '.shardmind', 'state.json'), 'utf-8')) as VaultState;

  it("asks each shard's conflict in turn, headed with its name, and reports both", async () => {
    // A conflict in each shard: the user's line where each release changes it.
    const claude = path.join(vault, 'CLAUDE.md');
    await fsp.writeFile(claude, (await fsp.readFile(claude, 'utf-8')).replace(/^# Minimal Shard.*$/m, '# My vault'));
    await fsp.writeFile(path.join(vault, 'research', 'Papers.md'), '# Papers\n\nOn physics, my notes.\n');
    serve(BASE, '0.2.0', tarballs['base-0.2.0']!);
    serve(OVERLAY, '2.0.0', tarballs['overlay-2.0.0']!);

    const r = mountUpdate({ vaultRoot: vault });
    const keepMine = async () => {
      r.stdin.write(ARROW_DOWN);
      await tick(40);
      r.stdin.write(ENTER);
    };
    await waitFor(r.lastFrame, (f) => f.includes('CLAUDE.md') && /\(1 of 1\)/.test(f), 30_000);
    expect(r.lastFrame()).toContain(BASE);
    await keepMine();
    // The second shard's first conflict: a new mount, its own name above it.
    await waitFor(r.lastFrame, (f) => f.includes('research/Papers.md') && /\(1 of 1\)/.test(f), 30_000);
    expect(r.lastFrame()).toContain(OVERLAY);
    await keepMine();

    const frames = allFrames(r);
    await waitFor(frames, (f) => /Updated 1\.0\.0 → 2\.0\.0/.test(f), 30_000);
    expect(frames()).toMatch(/Updated 0\.1\.0 → 0\.2\.0/);
    const after = await state();
    expect(after.shards.map((s) => [s.shard, s.version])).toEqual([[BASE, '0.2.0'], [OVERLAY, '2.0.0']]);
    expect(after.shards[0]!.files['CLAUDE.md']?.ownership).toBe('modified');
    expect(after.shards[1]!.files['research/Papers.md']?.ownership).toBe('modified');
    expect(await fsp.readFile(path.join(vault, 'research', 'Papers.md'), 'utf-8')).toBe('# Papers\n\nOn physics, my notes.\n');
    expect(process.exitCode).toBeUndefined();
  }, 60_000);

  it('`update <shard>` updates that one alone', async () => {
    serve(BASE, '0.2.0', tarballs['base-0.2.0']!);
    serve(OVERLAY, '2.0.0', tarballs['overlay-2.0.0']!);
    const r = mountUpdate({ vaultRoot: vault, shard: OVERLAY, options: { yes: true } });
    const frames = allFrames(r);
    await waitFor(frames, (f) => /Updated 1\.0\.0 → 2\.0\.0/.test(f), 30_000);
    expect(frames()).not.toContain(BASE);
    expect((await state()).shards.map((s) => s.version)).toEqual(['0.1.0', '2.0.0']);
  }, 60_000);

  it("a shard's failure shows its error and the shards before it updated, and exits 1", async () => {
    serve(BASE, '0.2.0', tarballs['base-0.2.0']!);
    serve(OVERLAY, '2.0.0', tarballs['overlay-2.0.0']!);
    // The overlay's values file gone: its update cannot load its values.
    await fsp.rm(path.join(vault, 'shard-values.flowcompose.research.yaml'));
    const r = mountUpdate({ vaultRoot: vault, options: { yes: true } });
    const frames = allFrames(r);
    await waitFor(frames, (f) => f.includes('VALUES_READ_FAILED'), 30_000);
    await tick(150);
    expect(frames()).toMatch(/Updated 0\.1\.0 → 0\.2\.0/);
    expect(frames()).toContain('shard-values.flowcompose.research.yaml');
    expect(process.exitCode).toBe(1);
    expect((await state()).shards.map((s) => s.version)).toEqual(['0.2.0', '1.0.0']);
  }, 60_000);
});
