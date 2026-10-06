/**
 * `adopt --from-version` through the whole flow (#325): the base release is
 * fetched and rendered, and a file still at it takes the target's bytes,
 * managed, in every mode. Spec: docs/SHARD-LAYOUT.md §Adopt semantics,
 * docs/IMPLEMENTATION.md §4.17 (Behind the target).
 *
 * The stub serves the obsidian-mind-like shard at 6.0.0 (the clone) and
 * 6.1.0 (the target), whose CLAUDE.md changed. A clone is the shard's folder
 * as checked out: its plain files at their paths, its templates unrendered.
 * (A rendered file that carries `install_date` never equals a later render,
 * so it is never behind; the values-differ fallback is covered in
 * tests/unit/adopt-behind.test.ts.)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setupFlowSuite, makeVaultDir, cleanupVault } from './helpers.js';
import { buildObsidianMindTarballs, type ObsidianMindTarballs } from '../../e2e/helpers/obsidian-mind-tarball.js';
import { runAdoptFlow, type AdoptFlowInput, type AdoptFlowIO, type AdoptQuestion } from '../../../source/core/flows/adopt.js';
import { readState } from '../../../source/core/state.js';
import { adoptPlanResult } from '../../../source/core/json-output.js';

const OM_SLUG = 'acme/om';
const OM_REF = `github:${OM_SLUG}`;
const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/shards/obsidian-mind-like');

describe('adopt --from-version: files still at the base release (#325)', () => {
  const getCtx = setupFlowSuite({ shards: { [OM_SLUG]: { versions: {} as Record<string, string>, latest: '6.1.0' } } });
  let om: ObsidianMindTarballs;

  beforeAll(async () => {
    om = await buildObsidianMindTarballs();
  }, 90_000);

  function serve(): void {
    const { stub } = getCtx();
    stub.setVersion(OM_SLUG, '6.0.0', om.byVersion['6.0.0']);
    stub.setVersion(OM_SLUG, '6.1.0', om.byVersion['6.1.0']);
  }

  function scriptedIO(answer: (q: AdoptQuestion) => unknown) {
    const asked: AdoptQuestion[] = [];
    const io: AdoptFlowIO = {
      ask: async (q) => {
        asked.push(q);
        return answer(q) as never;
      },
      phase: () => {},
      progress: () => {},
      hooks: { setPhase: () => {}, onStdout: () => {}, onStderr: () => {} },
      lock: () => ({ release: () => {} }),
      onCleanup: () => {},
      newRunAbort: () => new AbortController(),
      onRun: () => {},
      onCommitted: () => {},
      onHookAbort: () => {},
    };
    return { io, asked };
  }

  // `--yes`: the schema's defaults, and keep-all-mine unless a mode is given.
  const input = (vault: string, extra: Partial<AdoptFlowInput> = {}): AdoptFlowInput => ({
    shardRef: `${OM_REF}@6.1.0`,
    valuesFile: undefined,
    yes: true,
    mode: undefined,
    fromVersion: '6.0.0',
    dryRun: false,
    json: false,
    interactive: true,
    vaultRoot: vault,
    engineVersion: undefined,
    ...extra,
  });

  /** The shard's folder as cloned at 6.0.0, with AGENTS.md edited. */
  async function clonedAt600(): Promise<string> {
    const vault = await makeVaultDir('adopt-behind');
    await fs.cp(FIXTURE_DIR, vault, { recursive: true });
    await fs.appendFile(path.join(vault, 'AGENTS.md'), '\nMy own line.\n');
    return vault;
  }

  const targetClaude = async (): Promise<string> => {
    const dir = await makeVaultDir('adopt-behind-target');
    try {
      await runAdoptFlow(input(dir, { fromVersion: undefined, mode: 'use-all-theirs' }), scriptedIO(() => 'use_shard').io);
      return await fs.readFile(path.join(dir, 'CLAUDE.md'), 'utf-8');
    } finally {
      await cleanupVault(dir);
    }
  };

  it("keep-all-mine: only the edited file is the user's; CLAUDE.md takes 6.1.0, managed", async () => {
    serve();
    const vault = await clonedAt600();
    try {
      const result = await runAdoptFlow(input(vault), scriptedIO(() => 'keep_mine').io);
      if (result.kind !== 'done') throw new Error('expected done');
      expect(result.summary.updatedBehind).toEqual(['CLAUDE.md']);
      expect(result.summary.adoptedMine).toEqual(['AGENTS.md']);
      expect(result.base).toEqual({ version: '6.0.0' });
      const claude = await fs.readFile(path.join(vault, 'CLAUDE.md'), 'utf-8');
      expect(claude).toContain('(v6.1.0 update)');
      expect(claude).toBe(await targetClaude());
      const state = await readState(vault);
      expect(state!.files['CLAUDE.md']!.ownership).toBe('managed');
      expect(state!.files['AGENTS.md']!.ownership).toBe('modified');
    } finally {
      await cleanupVault(vault);
    }
  });

  it('--dry-run --json lists CLAUDE.md as behind, with the base, and writes nothing', async () => {
    serve();
    const vault = await clonedAt600();
    try {
      const before = await fs.readFile(path.join(vault, 'CLAUDE.md'), 'utf-8');
      const result = await runAdoptFlow(input(vault, { dryRun: true, json: true }), scriptedIO(() => 'keep_mine').io);
      if (result.kind !== 'plan') throw new Error('expected plan');
      const doc = adoptPlanResult(result.plan, { dryRun: true, mode: null });
      expect(doc.counts.behind).toBe(1);
      expect(doc.base).toEqual({ version: '6.0.0' });
      expect(doc.files.find((f) => f.path === 'CLAUDE.md')!.classification).toBe('behind');
      expect(doc.files.find((f) => f.path === 'AGENTS.md')!.classification).toBe('differs');
      expect(await fs.readFile(path.join(vault, 'CLAUDE.md'), 'utf-8')).toBe(before);
    } finally {
      await cleanupVault(vault);
    }
  });

  it('decide-per-file never asks about a behind file, and still updates it', async () => {
    serve();
    const vault = await clonedAt600();
    try {
      const s = scriptedIO((q) => (q.kind === 'values' ? { values: { user_name: 'Alice' }, selections: {} } : q.kind === 'mode' ? 'decide-per-file' : 'keep_mine'));
      const result = await runAdoptFlow(input(vault, { yes: false }), s.io);
      if (result.kind !== 'done') throw new Error('expected done');
      const asked = s.asked.filter((q) => q.kind === 'per-file').map((q) => (q.kind === 'per-file' ? q.queue[q.currentIndex]!.path : ''));
      expect(asked).toContain('AGENTS.md');
      expect(asked).not.toContain('CLAUDE.md');
      expect(result.summary.updatedBehind).toEqual(['CLAUDE.md']);
    } finally {
      await cleanupVault(vault);
    }
  });

  it('a base release that cannot be fetched: the run goes on as before, with the reason', async () => {
    serve();
    const vault = await clonedAt600();
    try {
      const plan = await runAdoptFlow(input(vault, { fromVersion: '5.9.0', dryRun: true, json: true }), scriptedIO(() => 'keep_mine').io);
      if (plan.kind !== 'plan') throw new Error('expected plan');
      expect(plan.plan.base).toEqual({ version: '5.9.0', unavailable: expect.any(String) });
      expect(plan.plan.behind).toEqual([]);
      expect(plan.plan.differs.map((c) => c.path)).toEqual(expect.arrayContaining(['AGENTS.md', 'CLAUDE.md']));

      const result = await runAdoptFlow(input(vault, { fromVersion: '5.9.0' }), scriptedIO(() => 'keep_mine').io);
      if (result.kind !== 'done') throw new Error('expected done');
      expect(result.summary.updatedBehind).toEqual([]);
      expect(result.summary.adoptedMine).toEqual(expect.arrayContaining(['AGENTS.md', 'CLAUDE.md']));
      expect(result.base).toEqual({ version: '5.9.0', unavailable: expect.any(String) });
    } finally {
      await cleanupVault(vault);
    }
  });

  it('without --from-version nothing is fetched for a base, and CLAUDE.md is kept under keep-all-mine', async () => {
    serve();
    const vault = await clonedAt600();
    try {
      const { stub } = getCtx();
      const before = stub.requestedPaths().length;
      const result = await runAdoptFlow(input(vault, { fromVersion: undefined }), scriptedIO(() => 'keep_mine').io);
      if (result.kind !== 'done') throw new Error('expected done');
      expect(result.summary.updatedBehind).toEqual([]);
      expect(result.summary.adoptedMine).toEqual(expect.arrayContaining(['AGENTS.md', 'CLAUDE.md']));
      expect(result.base).toBeUndefined();
      expect(stub.requestedPaths().slice(before).some((p) => p.includes('6.0.0'))).toBe(false);
    } finally {
      await cleanupVault(vault);
    }
  });
});
