/**
 * The install flow on its own (#302): no Ink, a scripted `io`. What it asks,
 * in what order, what it reports, and how a run ends. The Ink adapter on top
 * is covered by install-flow.test.tsx.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

import { setupFlowSuite, makeVaultDir, cleanupVault, SHARD_SLUG, SHARD_REF, STUB_SHA, DEFAULT_VALUES } from './helpers.js';
import {
  runInstallFlow,
  type InstallFlowInput,
  type InstallFlowIO,
  type InstallQuestion,
} from '../../../source/core/flows/install.js';
import { FlowCancelled } from '../../../source/core/flows/cancelled.js';
import { createInstalledVault } from '../../e2e/helpers/vault.js';

describe('install flow, UI-free (#302)', () => {
  const getCtx = setupFlowSuite({ shards: { [SHARD_SLUG]: { versions: {} as Record<string, string>, latest: '0.1.0' } } });

  function pinShard(): void {
    const { stub, fixtures } = getCtx();
    stub.setRef(SHARD_SLUG, 'v0.1.0', STUB_SHA, fixtures.byVersion['0.1.0']!);
  }

  /** A scripted io: answers each question from `answer`, and records what it saw. */
  function scriptedIO(answer: (q: InstallQuestion) => unknown) {
    const asked: InstallQuestion[] = [];
    const phases: string[] = [];
    let committed = false;
    const io: InstallFlowIO = {
      ask: async (q) => {
        asked.push(q);
        return answer(q) as never;
      },
      phase: (p) => phases.push(p.kind === 'loading' ? `loading: ${p.message.split(' ')[0]}` : p.kind),
      progress: () => {},
      hooks: { setPhase: () => {}, onStdout: () => {}, onStderr: () => {} },
      lock: () => {
        phases.push('lock');
        return { release: () => phases.push('unlock') };
      },
      onCleanup: () => {},
      newRunAbort: () => new AbortController(),
      onRun: () => {},
      onCommitted: () => {
        committed = true;
      },
      onHookAbort: () => {},
    };
    return { io, asked, phases, committed: () => committed };
  }

  /** A values file beside the vault, removed by the test's finally. */
  function valuesFileFor(vault: string): string {
    const file = `${vault}-values.yaml`;
    fsSync.writeFileSync(file, stringifyYaml(DEFAULT_VALUES));
    return file;
  }

  const input = (vault: string, extra: Partial<InstallFlowInput> = {}): InstallFlowInput => ({
    shardRef: `${SHARD_REF}#v0.1.0`,
    valuesFile: undefined,
    yes: false,
    defaults: false,
    force: false,
    dryRun: false,
    interactive: true,
    destination: { root: vault, folder: null, create: [] },
    engineVersion: undefined,
    ...extra,
  });

  it('in place: locks, asks for the values, installs, commits', async () => {
    pinShard();
    const vault = await makeVaultDir('install-core-fresh');
    try {
      const s = scriptedIO((q) => (q.kind === 'values' ? { values: DEFAULT_VALUES, selections: {} } : 'backup'));
      const result = await runInstallFlow(input(vault), s.io);
      expect(result.kind).toBe('done');
      expect(s.asked.map((q) => q.kind)).toEqual(['values']);
      expect(s.phases).toEqual(['lock', 'loading: Resolving', 'loading: Downloading', 'loading: Parsing', 'loading: Checking', 'installing']);
      expect(s.committed()).toBe(true);
      await expect(fs.access(path.join(vault, '.shardmind', 'state.json'))).resolves.toBeUndefined();
    } finally {
      await cleanupVault(vault);
    }
  }, 60_000);

  it('into a folder it makes: no lock while planning; the transaction takes it, and the caller releases it', async () => {
    pinShard();
    const cwd = await makeVaultDir('install-core-new');
    const root = path.join(cwd, 'demo');
    try {
      const s = scriptedIO(() => {
        throw new Error('asked');
      });
      const result = await runInstallFlow(input(root, { defaults: true, destination: { root, folder: 'demo', create: [root] } }), s.io);
      expect(result.folder).toBe('demo');
      // Taken once the folder existed, at write time; the caller releases it when its run ends.
      expect(s.phases.indexOf('lock')).toBeGreaterThan(s.phases.indexOf('installing'));
      expect(s.asked).toEqual([]);
    } finally {
      await cleanupVault(cwd);
    }
  }, 60_000);

  it.each([
    ['cancel', /cancelled at existing-install gate/],
    ['update', /Run `shardmind update`/],
  ] as const)('the gate answered %s ends the run with FlowCancelled, the install untouched', async (choice, reason) => {
    pinShard();
    const { stub } = getCtx();
    const vault = await createInstalledVault({ stub, shardRef: `${SHARD_REF}#v0.1.0`, values: DEFAULT_VALUES, prefix: 'install-core-gate' });
    try {
      const before = await fs.readFile(path.join(vault.root, '.shardmind', 'state.json'), 'utf-8');
      const s = scriptedIO((q) => (q.kind === 'gate' ? choice : 'asked past the gate'));
      const err = await runInstallFlow(input(vault.root), s.io).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FlowCancelled);
      expect((err as FlowCancelled).reason).toMatch(reason);
      expect(s.asked.map((q) => q.kind)).toEqual(['gate']);
      expect(await fs.readFile(path.join(vault.root, '.shardmind', 'state.json'), 'utf-8')).toBe(before);
    } finally {
      await vault.cleanup();
    }
  }, 60_000);

  it('a headless --values run with a file of the user\'s in the way backs it up, never asking (#302)', async () => {
    pinShard();
    const vault = await makeVaultDir('install-core-headless-collision');
    try {
      await fs.writeFile(path.join(vault, 'Home.md'), 'my own home\n');
      const s = scriptedIO(() => {
        throw new Error('asked without a terminal');
      });
      const result = await runInstallFlow(input(vault, { interactive: false, valuesFile: valuesFileFor(vault) }), s.io);
      expect(s.asked).toEqual([]);
      expect(result.backups.map((b) => path.basename(b.originalPath))).toEqual(['Home.md']);
    } finally {
      await fs.rm(`${vault}-values.yaml`, { force: true });
      await cleanupVault(vault);
    }
  }, 60_000);

  it('the collision review answered cancel ends the run with FlowCancelled, nothing written', async () => {
    pinShard();
    const vault = await makeVaultDir('install-core-collision-cancel');
    try {
      await fs.writeFile(path.join(vault, 'Home.md'), 'my own home\n');
      const s = scriptedIO((q) => (q.kind === 'values' ? { values: DEFAULT_VALUES, selections: {} } : 'cancel'));
      const err = await runInstallFlow(input(vault), s.io).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FlowCancelled);
      expect(s.asked.map((q) => q.kind)).toEqual(['values', 'collision']);
      expect(await fs.readdir(vault)).toEqual(['Home.md']);
    } finally {
      await cleanupVault(vault);
    }
  }, 60_000);

  it('a run superseded while it downloaded goes no further: FlowCancelled, nothing asked or written', async () => {
    pinShard();
    const vault = await makeVaultDir('install-core-superseded');
    try {
      const stop = new AbortController();
      stop.abort();
      const s = scriptedIO(() => {
        throw new Error('asked');
      });
      await expect(runInstallFlow(input(vault, { stop: stop.signal }), s.io)).rejects.toBeInstanceOf(FlowCancelled);
      expect(s.asked).toEqual([]);
      expect(await fs.readdir(vault)).toEqual([]);
    } finally {
      await cleanupVault(vault);
    }
  }, 60_000);
});
