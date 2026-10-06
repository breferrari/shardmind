/**
 * The adopt flow on its own (#302): no Ink, a scripted `io`. What it asks,
 * in what order, what it reports, and how a run ends. The Ink adapter on top
 * is covered by adopt-flow.test.tsx.
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

import { setupFlowSuite, makeVaultDir, cleanupVault, SHARD_SLUG, SHARD_REF, STUB_SHA, DEFAULT_VALUES } from './helpers.js';
import {
  runAdoptFlow,
  adoptRolledBack,
  type AdoptFlowInput,
  type AdoptFlowIO,
  type AdoptQuestion,
} from '../../../source/core/flows/adopt.js';
import { FlowCancelled } from '../../../source/core/flows/cancelled.js';

describe('adopt flow, UI-free (#302)', () => {
  const getCtx = setupFlowSuite({ shards: { [SHARD_SLUG]: { versions: {} as Record<string, string>, latest: '0.1.0' } } });

  function pinShard(): void {
    const { stub, fixtures } = getCtx();
    stub.setRef(SHARD_SLUG, 'v0.1.0', STUB_SHA, fixtures.byVersion['0.1.0']!);
  }

  /** A scripted io: answers each question from `answer`, and records what it saw. */
  function scriptedIO(answer: (q: AdoptQuestion) => unknown) {
    const asked: AdoptQuestion[] = [];
    const phases: string[] = [];
    let committed = false;
    let cleanups = 0;
    const io: AdoptFlowIO = {
      ask: async (q) => {
        asked.push(q);
        return answer(q) as never;
      },
      phase: (p) => phases.push(p.kind === 'loading' ? `loading: ${p.message.split(' ')[0]}` : p.kind),
      progress: () => {},
      hooks: { setPhase: () => {}, onStdout: () => {}, onStderr: () => {} },
      takeLock: () => phases.push('lock'),
      onCleanup: () => {
        cleanups++;
      },
      newRunAbort: () => new AbortController(),
      onRun: () => {},
      onCommitted: () => {
        committed = true;
      },
      onHookAbort: () => {},
    };
    return { io, asked, phases, committed: () => committed, cleanups: () => cleanups };
  }

  async function vaultWith(files: Record<string, string>): Promise<string> {
    const vault = await makeVaultDir('adopt-core-flow');
    for (const [rel, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(vault, rel)), { recursive: true });
      await fs.writeFile(path.join(vault, rel), content);
    }
    return vault;
  }

  const input = (vault: string, extra: Partial<AdoptFlowInput> = {}): AdoptFlowInput => ({
    shardRef: `${SHARD_REF}#v0.1.0`,
    valuesFile: undefined,
    yes: false,
    mode: undefined,
    fromVersion: undefined,
    dryRun: false,
    json: false,
    interactive: true,
    vaultRoot: vault,
    engineVersion: undefined,
    ...extra,
  });

  it('asks for the values, then the mode, then each file under decide-per-file, in order', async () => {
    pinShard();
    const vault = await vaultWith({ 'Home.md': 'mine\n', 'CLAUDE.md': 'mine too\n' });
    try {
      const s = scriptedIO((q) =>
        q.kind === 'values' ? { values: DEFAULT_VALUES, selections: {} } : q.kind === 'mode' ? 'decide-per-file' : 'keep_mine',
      );
      const result = await runAdoptFlow(input(vault), s.io);
      expect(result.kind).toBe('done');
      const perFile = s.asked.filter((q) => q.kind === 'per-file');
      expect(s.asked[0]!.kind).toBe('values');
      expect(s.asked[1]!.kind).toBe('mode');
      expect(perFile.length).toBeGreaterThanOrEqual(2);
      expect(perFile.map((q) => (q.kind === 'per-file' ? q.currentIndex : -1))).toEqual(perFile.map((_, i) => i));
      expect(s.phases).toEqual(['lock', 'loading: Resolving', 'loading: Downloading', 'loading: Parsing', 'planning', 'executing']);
      expect(s.committed()).toBe(true);
      expect(await fs.readFile(path.join(vault, 'Home.md'), 'utf-8')).toBe('mine\n');
    } finally {
      await cleanupVault(vault);
    }
  }, 60_000);

  it('--json --dry-run returns the plan before any mode, never asks, takes no lock', async () => {
    pinShard();
    const vault = await vaultWith({ 'Home.md': 'mine\n' });
    try {
      const valuesFile = path.join(vault, 'values.yaml');
      await fs.writeFile(valuesFile, stringifyYaml(DEFAULT_VALUES));
      const s = scriptedIO(() => {
        throw new Error('asked');
      });
      const result = await runAdoptFlow(input(vault, { json: true, dryRun: true, interactive: false, valuesFile }), s.io);
      expect(result.kind).toBe('plan');
      if (result.kind === 'plan') expect(result.plan.differs.map((c) => c.path)).toContain('Home.md');
      expect(s.asked).toEqual([]);
      expect(s.phases).not.toContain('lock');
      await expect(fs.access(path.join(vault, '.shardmind'))).rejects.toThrow();
    } finally {
      await cleanupVault(vault);
    }
  }, 60_000);

  it('--yes settles everything without asking (keep-all-mine)', async () => {
    pinShard();
    const vault = await vaultWith({ 'Home.md': 'mine\n' });
    try {
      const s = scriptedIO(() => {
        throw new Error('asked');
      });
      const result = await runAdoptFlow(input(vault, { yes: true }), s.io);
      expect(result.kind).toBe('done');
      expect(s.asked).toEqual([]);
      expect(await fs.readFile(path.join(vault, 'Home.md'), 'utf-8')).toBe('mine\n');
    } finally {
      await cleanupVault(vault);
    }
  }, 60_000);

  it('without a terminal or --values, refuses before asking (#139)', async () => {
    pinShard();
    const vault = await vaultWith({});
    try {
      const s = scriptedIO(() => {
        throw new Error('asked');
      });
      await expect(runAdoptFlow(input(vault, { interactive: false }), s.io)).rejects.toMatchObject({
        code: 'ADOPT_NON_INTERACTIVE_WITHOUT_VALUES',
      });
      expect(s.asked).toEqual([]);
    } finally {
      await cleanupVault(vault);
    }
  }, 60_000);

  it('--json without --dry-run refuses before anything else', async () => {
    const s = scriptedIO(() => undefined);
    await expect(runAdoptFlow(input('unused', { json: true }), s.io)).rejects.toMatchObject({ code: 'JSON_REQUIRES_DRY_RUN' });
    expect(s.phases).toEqual([]);
  });

  it('a cancelled prompt ends the run with FlowCancelled, nothing written, the shard removed', async () => {
    pinShard();
    const vault = await vaultWith({ 'Home.md': 'mine\n' });
    try {
      const s = scriptedIO(() => {
        throw new FlowCancelled('User cancelled in wizard.');
      });
      await expect(runAdoptFlow(input(vault), s.io)).rejects.toBeInstanceOf(FlowCancelled);
      expect(s.cleanups()).toBe(1);
      expect(s.committed()).toBe(false);
      await expect(fs.access(path.join(vault, '.shardmind', 'state.json'))).rejects.toThrow();
    } finally {
      await cleanupVault(vault);
    }
  }, 60_000);

  it('a run superseded while it downloaded goes no further: FlowCancelled, nothing written', async () => {
    pinShard();
    const vault = await vaultWith({ 'Home.md': 'mine\n' });
    try {
      const stop = new AbortController();
      const s = scriptedIO(() => undefined);
      const io = { ...s.io, phase: (p: Parameters<AdoptFlowIO['phase']>[0]) => {
        s.io.phase(p);
        if (p.kind === 'loading' && p.message.startsWith('Parsing')) stop.abort();
      } };
      await expect(runAdoptFlow(input(vault, { yes: true, stop: stop.signal }), io)).rejects.toBeInstanceOf(FlowCancelled);
      expect(s.asked).toEqual([]);
      await expect(fs.access(path.join(vault, '.shardmind', 'state.json'))).rejects.toThrow();
    } finally {
      await cleanupVault(vault);
    }
  }, 60_000);

  it('an executor failure is marked rolled back', async () => {
    pinShard();
    const vault = await vaultWith({ 'Home.md': 'mine\n' });
    try {
      // The values file's write fails, after the vault writes.
      const valuesAbs = path.join(vault, 'shard-values.yaml');
      const realWrite = fs.writeFile;
      const spy = vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, opts) => {
        if (file === valuesAbs) throw Object.assign(new Error('simulated EIO'), { code: 'EIO' });
        return realWrite(file, data, opts as Parameters<typeof realWrite>[2]);
      });
      const s = scriptedIO(() => undefined);
      const err = await runAdoptFlow(input(vault, { yes: true }), s.io).catch((e: unknown) => e);
      spy.mockRestore();
      expect(err).toBeInstanceOf(Error);
      expect(adoptRolledBack(err)).toBe(true);
      expect(s.committed()).toBe(false);
    } finally {
      await cleanupVault(vault);
    }
  }, 60_000);
});
