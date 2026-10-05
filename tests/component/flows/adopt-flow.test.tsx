/**
 * Layer 1 adopt command flow tests — scenarios 19-26 of [#111](https://github.com/breferrari/shardmind/issues/111) Phase 1.
 *
 * Adopt opens on the `AdoptValuesGate` confirm-or-override page (#104):
 * a single page surfacing the values that will drive classification,
 * with Use these values / Override individually / Cancel. "Override"
 * drops into the full InstallWizard. After values are settled, adopt
 * plans against the user's vault to classify each shard path as
 * `matches` / `differs` / `shard-only`. Each `differs` file gets an
 * AdoptDiffView prompt; iteration shape is the same #109 surface as
 * DiffView.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup } from 'ink-testing-library';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

import {
  setupFlowSuite,
  mountAdopt,
  makeVaultDir,
  cleanupVault,
  buildCustomTarball,
  allFrames,
  driveMinimalWizard,
  driveDiffIteration,
  SHARD_SLUG,
  SHARD_REF,
  STUB_SHA,
  DEFAULT_VALUES,
} from './helpers.js';
import { tick, waitFor, ENTER, ARROW_DOWN } from '../helpers.js';
import { createInstalledVault, type Vault } from '../../e2e/helpers/vault.js';
import { resetSigintRollbackForTests } from '../../../source/commands/hooks/shared.js';

const SLUG_VERSION_MISMATCH = 'acme/adopt-future-engine';
const SLUG_RENAMED = 'acme/adopt-renamed';
const SLUG_TOOLS = 'acme/adopt-external-tools';

describe('adopt command — Layer 1 flow tests (#111 Phase 1, scenarios 19-26)', () => {
  const getCtx = setupFlowSuite({
    shards: {
      [SHARD_SLUG]: {
        versions: {} as Record<string, string>,
        latest: '0.1.0',
      },
      [SLUG_VERSION_MISMATCH]: {
        versions: {} as Record<string, string>,
        latest: '0.1.0',
      },
      [SLUG_RENAMED]: {
        versions: {} as Record<string, string>,
        latest: '0.2.0',
      },
      [SLUG_TOOLS]: {
        versions: {} as Record<string, string>,
        latest: '0.1.0',
      },
    },
  });

  // ───── External tools (#138) ─────

  it('a required tool out of range → EXTERNAL_TOOL_UNMET before any write (#138)', async () => {
    const { stub } = getCtx();
    const vault = await makeVaultDir('s-adopt-tools');
    try {
      await writeRel(vault, 'Home.md', '# user-only Home\n');
      const tarPath = await buildCustomTarball({
        version: '0.1.0',
        prefix: 'adopt-external-tools-0.1.0',
        manifestOverrides: {
          hooks: {},
          name: 'adopt-external-tools',
          namespace: 'flowtest',
          // `node` is on PATH wherever the tests run; no version meets this.
          external_tools: { node: { package: 'node', version: '>=999.0.0', command: 'node' } },
        },
        outDir: vault,
      });
      stub.setRef(SLUG_TOOLS, 'v0.1.0', STUB_SHA, tarPath);
      const valuesFile = path.join(vault, 'values.yaml');
      await fs.writeFile(valuesFile, stringifyYaml(DEFAULT_VALUES), 'utf-8');
      const r = mountAdopt({
        shardRef: `github:${SLUG_TOOLS}#v0.1.0`,
        vaultRoot: vault,
        options: { yes: true, values: valuesFile },
      });
      const frame = await waitFor(
        allFrames(r),
        (f) => /EXTERNAL_TOOL_UNMET/.test(f) && /npm i -g node@">=999\.0\.0"/.test(f),
        30_000,
      );
      expect(frame).toMatch(/node: found \d+\.\d+\.\d+, needs >=999\.0\.0/);
      await expect(fs.access(path.join(vault, '.shardmind'))).rejects.toThrow();
      expect(await fs.readFile(path.join(vault, 'Home.md'), 'utf-8')).toBe('# user-only Home\n');
    } finally {
      await cleanupVault(vault);
    }
  }, 60_000);

  it('an optional tool missing → the adopt completes and the summary lists it (#138)', async () => {
    const { stub } = getCtx();
    const vault = await makeVaultDir('s-adopt-tools-optional');
    try {
      const tarPath = await buildCustomTarball({
        version: '0.1.0',
        prefix: 'adopt-external-tools-optional-0.1.0',
        manifestOverrides: {
          hooks: {},
          name: 'adopt-external-tools',
          namespace: 'flowtest',
          external_tools: {
            'shardmind-no-such-tool': { package: 'no-such-tool', version: '>=1.0.0', command: 'shardmind-no-such-tool', optional: true },
          },
        },
        outDir: vault,
      });
      stub.setRef(SLUG_TOOLS, 'v0.1.0-optional', STUB_SHA, tarPath);
      const valuesFile = path.join(vault, 'values.yaml');
      await fs.writeFile(valuesFile, stringifyYaml(DEFAULT_VALUES), 'utf-8');
      const r = mountAdopt({
        shardRef: `github:${SLUG_TOOLS}#v0.1.0-optional`,
        vaultRoot: vault,
        options: { yes: true, values: valuesFile },
      });
      const frame = await waitFor(
        allFrames(r),
        (f) => /Adopted flowtest\/adopt-external-tools/.test(f) && /shardmind-no-such-tool: not found on PATH/.test(f),
        30_000,
      );
      expect(frame).toMatch(/External tools:/);
      await expect(fs.access(path.join(vault, '.shardmind', 'state.json'))).resolves.toBeUndefined();
    } finally {
      await cleanupVault(vault);
    }
  }, 60_000);

  afterEach(() => {
    cleanup();
    // A Ctrl+C sets a once-per-process latch (#155); reset it between tests (#249).
    resetSigintRollbackForTests();
  });

  /**
   * Drive adopt's default `AdoptValuesGate` path (#104): wait for the
   * confirm page, then ENTER on the focused "Use these values" option.
   * The minimal-shard schema's four values all carry literal defaults,
   * so the gate opens on the confirm page (not the override wizard) and
   * a single keystroke settles values + all-default module selections.
   * Adopt then moves to planning + diff-review.
   */
  async function driveAdoptConfirm(
    r: ReturnType<typeof mountAdopt>,
  ): Promise<void> {
    await waitFor(r.lastFrame, (f) => f.includes('Use these values'), 30_000);
    r.stdin.write(ENTER);
  }

  /**
   * Drive the `AdoptModePicker` (#120) shown when there are differing files
   * and no `--mode`/`--yes`: wait for it, then arrow to the requested mode
   * (Keep all mine / Use all theirs / Auto-merge / Decide per file) and ENTER.
   */
  async function pickMode(
    r: ReturnType<typeof mountAdopt>,
    mode: 'keep-all-mine' | 'use-all-theirs' | 'auto-merge' | 'decide-per-file',
  ): Promise<void> {
    await waitFor(r.lastFrame, (f) => /files? differs? from the shard/.test(f), 20_000);
    // Arrow counts must match AdoptModePicker.tsx's option order
    // (keep-all-mine, use-all-theirs, auto-merge, decide-per-file).
    const downs = {
      'keep-all-mine': 0,
      'use-all-theirs': 1,
      'auto-merge': 2,
      'decide-per-file': 3,
    }[mode];
    for (let i = 0; i < downs; i++) {
      r.stdin.write(ARROW_DOWN);
      await tick(40);
    }
    r.stdin.write(ENTER);
  }

  // ───── Scenario 19: empty vault → all shard-only → Summary ─────

  it('19. empty vault → adopt → all shard-only → Summary', async () => {
    const { stub, fixtures } = getCtx();
    stub.setRef(SHARD_SLUG, 'v0.1.0', STUB_SHA, fixtures.byVersion['0.1.0']!);
    const vault = await makeVaultDir('s19-empty');
    try {
      const r = mountAdopt({
        shardRef: `${SHARD_REF}#v0.1.0`,
        vaultRoot: vault,
      });
      await driveAdoptConfirm(r);
      // No differing files → planner goes straight to executing →
      // running-hook → summary. Capture the matched frame from
      // waitFor; reading r.lastFrame() afterwards races the 100 ms
      // exit() timer that clears the testing-library buffer (same
      // pattern as status-flow's two scenarios).
      const frame = await waitFor(
        r.lastFrame,
        (f) => /Adopted shardmind\/minimal/.test(f),
        30_000,
      );
      // All adopted files should be in the "installed fresh" bucket
      // since the vault was empty pre-adopt.
      expect(frame).toMatch(/installed fresh/i);
    } finally {
      await cleanupVault(vault);
    }
  }, 60_000);

  // ───── Scenario 20: ≥3 differing files → AdoptDiffView iterates each (#109) ─────

  it('20. ≥3 differing files → AdoptDiffView iterates each (#109 regression)', async () => {
    const { stub, fixtures } = getCtx();
    stub.setRef(SHARD_SLUG, 'v0.1.0', STUB_SHA, fixtures.byVersion['0.1.0']!);
    const vault = await makeVaultDir('s20-multi-differ');
    try {
      // Pre-populate three shard-path files with content that diverges
      // from the rendered shard. Each path is a renderable .njk in the
      // shard, so the planner classifies each as `differs`.
      await writeRel(vault, 'Home.md', '# user-only Home content\nLine A\nLine B\n');
      await writeRel(
        vault,
        'brain/North Star.md',
        '# user-only North Star\nLine X\nLine Y\n',
      );
      await writeRel(
        vault,
        '.claude/settings.json',
        '{ "user-only": true, "no": "match" }\n',
      );
      const r = mountAdopt({
        shardRef: `${SHARD_REF}#v0.1.0`,
        vaultRoot: vault,
      });
      await driveAdoptConfirm(r);
      // Three files differ → mode picker; choose per-file to reach the loop.
      await pickMode(r, 'decide-per-file');
      // Walk three AdoptDiffView prompts via the shared iteration
      // helper. ENTER on default option = "Keep mine". The #109
      // regression would manifest as iteration 2 timing out on
      // its (2 of 3) counter — the dedup ref would have leaked from
      // iteration 1.
      await driveDiffIteration(r, 3, (r) => {
        r.stdin.write(ENTER);
      });
      await waitFor(r.lastFrame, (f) => /Adopted shardmind\/minimal/.test(f), 30_000);
    } finally {
      await cleanupVault(vault);
    }
  }, 90_000);

  // ───── Scenario 21: differing file + use_shard → file overwritten ─────

  it('21. differing file + user picks use_shard → file overwritten with shard bytes', async () => {
    const { stub, fixtures } = getCtx();
    stub.setRef(SHARD_SLUG, 'v0.1.0', STUB_SHA, fixtures.byVersion['0.1.0']!);
    const vault = await makeVaultDir('s21-use-shard');
    try {
      // Pre-populate a single differing file.
      await writeRel(vault, 'Home.md', 'My pre-existing Home content\n');
      const r = mountAdopt({
        shardRef: `${SHARD_REF}#v0.1.0`,
        vaultRoot: vault,
      });
      await driveAdoptConfirm(r);
      // One file differs → mode picker; choose per-file to reach the prompt.
      await pickMode(r, 'decide-per-file');
      await waitFor(r.lastFrame, (f) => /\(1 of 1\)/.test(f), 20_000);
      // ARROW_DOWN + ENTER → use_shard.
      r.stdin.write(ARROW_DOWN);
      await tick(40);
      r.stdin.write(ENTER);
      await waitFor(r.lastFrame, (f) => /Adopted shardmind\/minimal/.test(f), 30_000);
      // Home.md should now reflect the rendered shard, not the user's
      // pre-existing bytes.
      const home = await fs.readFile(path.join(vault, 'Home.md'), 'utf-8');
      expect(home).not.toContain('My pre-existing Home content');
    } finally {
      await cleanupVault(vault);
    }
  }, 60_000);

  // ───── Scenario 22: existing .shardmind/ → ADOPT_EXISTING_INSTALL ─────

  it('22. existing .shardmind/ → ADOPT_EXISTING_INSTALL → exits with hint', async () => {
    const { stub, fixtures } = getCtx();
    stub.setVersion(SHARD_SLUG, '0.1.0', fixtures.byVersion['0.1.0']!);
    stub.setLatest(SHARD_SLUG, '0.1.0');
    let installedVault: Vault | null = null;
    try {
      installedVault = await createInstalledVault({
        stub,
        shardRef: SHARD_REF,
        values: DEFAULT_VALUES,
        prefix: 's22-existing-install',
      });
      // Now run adopt against the installed vault — adopt's pre-flight
      // gate must throw ADOPT_EXISTING_INSTALL before any wizard
      // rendering.
      const r = mountAdopt({
        shardRef: SHARD_REF,
        vaultRoot: installedVault.root,
      });
      // Capture the matched frame from waitFor; r.lastFrame() races
      // the exit() that clears the buffer once the error phase fires
      // (same pattern as scenario 19 + status-flow).
      const frame = await waitFor(
        r.lastFrame,
        (f) => f.includes('ADOPT_EXISTING_INSTALL'),
        20_000,
      );
      // Hint mentions `shardmind update` as the upgrade path.
      expect(frame).toMatch(/shardmind update/);
    } finally {
      if (installedVault) await installedVault.cleanup();
    }
  }, 60_000);

  it('22b. another shardmind run holds the vault → VAULT_LOCKED before anything is read (#253)', async () => {
    const vault = await makeVaultDir('s22b-locked');
    try {
      await fs.writeFile(
        path.join(vault, '.shardmind.lock'),
        JSON.stringify({ pid: process.ppid, hostname: (await import('node:os')).hostname(), command: 'install', startedAt: '2026-10-04T12:00:00.000Z' }),
      );
      const r = mountAdopt({ shardRef: SHARD_REF, vaultRoot: vault });
      const all = await waitFor(() => r.frames.join(' ').replace(/\s+/g, ' '), (f) => /VAULT_LOCKED/.test(f), 20_000);
      expect(all).toContain(`install (PID ${process.ppid}`);
      expect(await fs.readdir(vault)).toEqual(['.shardmind.lock']);
    } finally {
      await cleanupVault(vault);
    }
  }, 60_000);

  // ───── Scenario 23: --yes + multi-divergent → all auto-keep_mine → Summary ─────

  it('23. --yes + multi-divergent → all auto-keep_mine → Summary', async () => {
    const { stub, fixtures } = getCtx();
    stub.setRef(SHARD_SLUG, 'v0.1.0', STUB_SHA, fixtures.byVersion['0.1.0']!);
    const vault = await makeVaultDir('s23-yes-multi');
    try {
      await writeRel(vault, 'Home.md', '# user-only Home\n');
      await writeRel(vault, 'brain/North Star.md', '# user-only NS\n');
      await writeRel(vault, '.claude/settings.json', '{ "user": true }\n');
      // --yes + values prefill skips both wizard and per-file prompts.
      const valuesFile = path.join(vault, 'values.yaml');
      await fs.writeFile(valuesFile, stringifyYaml(DEFAULT_VALUES), 'utf-8');
      const r = mountAdopt({
        shardRef: `${SHARD_REF}#v0.1.0`,
        vaultRoot: vault,
        options: { yes: true, values: valuesFile },
      });
      await waitFor(r.lastFrame, (f) => /Adopted shardmind\/minimal/.test(f), 30_000);
      // All three pre-existing user files survive (auto-keep_mine).
      const home = await fs.readFile(path.join(vault, 'Home.md'), 'utf-8');
      expect(home).toContain('user-only Home');
      const ns = await fs.readFile(
        path.join(vault, 'brain/North Star.md'),
        'utf-8',
      );
      expect(ns).toContain('user-only NS');
    } finally {
      await cleanupVault(vault);
    }
  }, 60_000);

  // ───── Scenario 24: requires.shardmind unsatisfiable → refuse before any write (#121) ─────

  it('24. requires.shardmind not satisfied → SHARDMIND_VERSION_MISMATCH, no .shardmind written (#121)', async () => {
    const { stub } = getCtx();
    const vault = await makeVaultDir('s24-adopt-version-mismatch');
    try {
      // A pre-existing user file the adopt would otherwise classify. The
      // refusal must fire before the planner touches it.
      await writeRel(vault, 'Home.md', '# user-only Home\n');
      const tarPath = await buildCustomTarball({
        version: '0.1.0',
        prefix: 'adopt-future-engine-0.1.0',
        manifestOverrides: {
          hooks: {},
          name: 'adopt-future-engine',
          namespace: 'flowtest',
          requires: { shardmind: '>=99.0.0' },
        },
        outDir: vault,
      });
      stub.setRef(SLUG_VERSION_MISMATCH, 'v0.1.0', STUB_SHA, tarPath);

      const r = mountAdopt({
        shardRef: `github:${SLUG_VERSION_MISMATCH}#v0.1.0`,
        vaultRoot: vault,
      });
      // Capture the matched frame and assert both the message and the code
      // on it — a second r.lastFrame() races the 100 ms exit() that clears
      // the testing-library buffer (same capture pattern as scenarios 19/22;
      // a slow CI cell surfaced the race here).
      const frame = await waitFor(
        r.lastFrame,
        (f) => /requires shardmind >=99\.0\.0/.test(f),
        30_000,
      );
      expect(frame).toMatch(/SHARDMIND_VERSION_MISMATCH/);
      // No engine state written — the vault was never adopted.
      const stateExists = await fs
        .stat(path.join(vault, '.shardmind', 'state.json'))
        .then((s) => s.isFile())
        .catch(() => false);
      expect(stateExists).toBe(false);
    } finally {
      await cleanupVault(vault);
    }
  }, 45_000);

  // ───── Scenario 25: confirm gate → Override individually → wizard → Summary (#104) ─────

  it('25. "Override individually" drops into the wizard and still adopts', async () => {
    const { stub, fixtures } = getCtx();
    stub.setRef(SHARD_SLUG, 'v0.1.0', STUB_SHA, fixtures.byVersion['0.1.0']!);
    const vault = await makeVaultDir('s25-override');
    try {
      const r = mountAdopt({
        shardRef: `${SHARD_REF}#v0.1.0`,
        vaultRoot: vault,
      });
      // Confirm gate up first; select "Override individually" (option 2)
      // to route into the full InstallWizard.
      await waitFor(r.lastFrame, (f) => f.includes('Override individually'), 30_000);
      r.stdin.write(ARROW_DOWN);
      await tick(40);
      r.stdin.write(ENTER);
      // Empty vault → all shard-only → Summary (no diff prompts).
      await driveMinimalWizard(r, 'Override Tester', 15_000);
      r.stdin.write(ENTER); // module review default selections
      await waitFor(r.lastFrame, (f) => f.includes('Ready to install'));
      r.stdin.write(ENTER); // confirm → planning
      const frame = await waitFor(
        r.lastFrame,
        (f) => /Adopted shardmind\/minimal/.test(f),
        30_000,
      );
      expect(frame).toMatch(/installed fresh/i);
    } finally {
      await cleanupVault(vault);
    }
  }, 60_000);

  // ───── Scenario 26: confirm page surfaces the values before classification (#104) ─────

  it('26. confirm page surfaces the values that will drive classification', async () => {
    const { stub, fixtures } = getCtx();
    stub.setRef(SHARD_SLUG, 'v0.1.0', STUB_SHA, fixtures.byVersion['0.1.0']!);
    const vault = await makeVaultDir('s26-surfaced');
    try {
      const r = mountAdopt({
        shardRef: `${SHARD_REF}#v0.1.0`,
        vaultRoot: vault,
      });
      // The default vault_purpose ("engineering") must be visible on the
      // confirm page *before* any classification/diff/summary frame — the
      // #104 acceptance criterion that no defaults are hidden.
      const frame = await waitFor(
        r.lastFrame,
        (f) => f.includes('Use these values'),
        30_000,
      );
      expect(frame).toMatch(/vault_purpose:\s+engineering/);
      expect(frame).toMatch(/Modules: all \d+ included/);
    } finally {
      await cleanupVault(vault);
    }
  }, 45_000);

  // ───── Scenario 27: mode picker → Keep all mine → no prompts, all kept (#120) ─────

  it('27. mode picker → Keep all mine → all divergent files kept, no per-file prompts', async () => {
    const { stub, fixtures } = getCtx();
    stub.setRef(SHARD_SLUG, 'v0.1.0', STUB_SHA, fixtures.byVersion['0.1.0']!);
    const vault = await makeVaultDir('s27-keep-all');
    try {
      await writeRel(vault, 'Home.md', '# my Home\nkeep me\n');
      await writeRel(vault, 'brain/North Star.md', '# my NS\nkeep me too\n');
      const r = mountAdopt({ shardRef: `${SHARD_REF}#v0.1.0`, vaultRoot: vault });
      await driveAdoptConfirm(r);
      await pickMode(r, 'keep-all-mine');
      const frame = await waitFor(
        r.lastFrame,
        (f) => /Adopted shardmind\/minimal/.test(f),
        30_000,
      );
      expect(frame).toMatch(/kept your version/);
      // Both user files survive byte-for-byte.
      expect(await fs.readFile(path.join(vault, 'Home.md'), 'utf-8')).toContain('keep me');
      expect(
        await fs.readFile(path.join(vault, 'brain/North Star.md'), 'utf-8'),
      ).toContain('keep me too');
    } finally {
      await cleanupVault(vault);
    }
  }, 60_000);

  // ───── Scenario 28: mode picker → Use all theirs → all overwritten (#120) ─────

  it('28. mode picker → Use all theirs → divergent files overwritten with shard bytes', async () => {
    const { stub, fixtures } = getCtx();
    stub.setRef(SHARD_SLUG, 'v0.1.0', STUB_SHA, fixtures.byVersion['0.1.0']!);
    const vault = await makeVaultDir('s28-use-all');
    try {
      await writeRel(vault, 'Home.md', 'my pre-existing Home\n');
      const r = mountAdopt({ shardRef: `${SHARD_REF}#v0.1.0`, vaultRoot: vault });
      await driveAdoptConfirm(r);
      await pickMode(r, 'use-all-theirs');
      const frame = await waitFor(
        r.lastFrame,
        (f) => /Adopted shardmind\/minimal/.test(f),
        30_000,
      );
      expect(frame).toMatch(/switched to the shard/);
      expect(await fs.readFile(path.join(vault, 'Home.md'), 'utf-8')).not.toContain(
        'my pre-existing Home',
      );
    } finally {
      await cleanupVault(vault);
    }
  }, 60_000);

  // ───── Scenario 29: mode picker → Auto-merge → non-conflict auto, conflict prompts (#120) ─────

  it('29. Auto-merge → non-conflicting file auto-resolved, conflicting file prompts', async () => {
    const { stub, fixtures } = getCtx();
    stub.setRef(SHARD_SLUG, 'v0.1.0', STUB_SHA, fixtures.byVersion['0.1.0']!);
    const vault = await makeVaultDir('s29-auto-merge');
    try {
      // Empty user file → pure insertion vs the rendered shard → union merge
      // with no conflict (auto-resolved, no prompt).
      await writeRel(vault, 'Home.md', '');
      // Wholly different content → a replaced span → conflict → prompts.
      await writeRel(vault, 'brain/North Star.md', '# totally different\nxyz\n');
      const r = mountAdopt({ shardRef: `${SHARD_REF}#v0.1.0`, vaultRoot: vault });
      await driveAdoptConfirm(r);
      await pickMode(r, 'auto-merge');
      // Only the conflicting file enters the prompt loop.
      await waitFor(r.lastFrame, (f) => /\(1 of 1\)/.test(f), 20_000);
      r.stdin.write(ENTER); // keep mine on the conflict
      const frame = await waitFor(
        r.lastFrame,
        (f) => /Adopted shardmind\/minimal/.test(f),
        30_000,
      );
      expect(frame).toMatch(/auto-merged/);
      // The empty Home.md was union-merged to the shard's rendered bytes.
      const home = await fs.readFile(path.join(vault, 'Home.md'), 'utf-8');
      expect(home.length).toBeGreaterThan(0);
    } finally {
      await cleanupVault(vault);
    }
  }, 60_000);

  // ───── Scenario 30: --mode (non-interactive) overrides --yes, no picker (#120) ─────

  it('30. --yes --mode=use-all-theirs → non-interactive, no picker, files overwritten', async () => {
    const { stub, fixtures } = getCtx();
    stub.setRef(SHARD_SLUG, 'v0.1.0', STUB_SHA, fixtures.byVersion['0.1.0']!);
    const vault = await makeVaultDir('s30-mode-flag');
    try {
      await writeRel(vault, 'Home.md', 'my pre-existing Home\n');
      const valuesFile = path.join(vault, 'values.yaml');
      await fs.writeFile(valuesFile, stringifyYaml(DEFAULT_VALUES), 'utf-8');
      const r = mountAdopt({
        shardRef: `${SHARD_REF}#v0.1.0`,
        vaultRoot: vault,
        options: { yes: true, values: valuesFile, mode: 'use-all-theirs' },
      });
      // No picker, no value gate — fully non-interactive. --mode overrides
      // --yes's default of keep-all-mine, so Home.md is overwritten.
      await waitFor(r.lastFrame, (f) => /Adopted shardmind\/minimal/.test(f), 30_000);
      expect(await fs.readFile(path.join(vault, 'Home.md'), 'utf-8')).not.toContain(
        'my pre-existing Home',
      );
    } finally {
      await cleanupVault(vault);
    }
  }, 60_000);

  // ───── Scenario 33: a rollback that can't restore says so, not "Rolled back" (#247) ─────

  it("33. failed adopt whose snapshot can't be restored → ROLLBACK_INCOMPLETE names the file and its copy", async () => {
    const { stub, fixtures } = getCtx();
    stub.setRef(SHARD_SLUG, 'v0.1.0', STUB_SHA, fixtures.byVersion['0.1.0']!);
    const vault = await makeVaultDir('s33-rollback-incomplete');
    const realWrite = fs.writeFile;
    const realCopy = fs.copyFile;
    try {
      await writeRel(vault, 'Home.md', 'my pre-existing Home\n');
      const valuesFile = path.join(vault, 'values.yaml');
      await fs.writeFile(valuesFile, stringifyYaml(DEFAULT_VALUES), 'utf-8');
      const homeAbs = path.join(vault, 'Home.md');
      // The values file's write fails after Home.md was written (a file is
      // snapshotted just before its write, #301), and restoring Home.md fails.
      vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, opts) => {
        if (file === path.join(vault, 'shard-values.yaml')) {
          throw Object.assign(new Error('simulated EACCES'), { code: 'EACCES' });
        }
        return realWrite(file, data, opts);
      });
      vi.spyOn(fs, 'copyFile').mockImplementation(async (src, dst, mode) => {
        if (dst === homeAbs && String(src).includes(path.join('.shardmind', 'backups'))) {
          throw Object.assign(new Error('simulated EBUSY'), { code: 'EBUSY' });
        }
        return realCopy(src, dst, mode);
      });
      const r = mountAdopt({
        shardRef: `${SHARD_REF}#v0.1.0`,
        vaultRoot: vault,
        options: { yes: true, values: valuesFile, mode: 'use-all-theirs' },
      });
      // An error exits ~100 ms after rendering, which clears lastFrame; read the history.
      await waitFor(() => r.frames.join('\n'), (f) => /ROLLBACK_INCOMPLETE/.test(f), 30_000);
      await tick(200);
      const frames = r.frames.join('\n');
      expect(frames).toMatch(/Home\.md: restore failed: simulated EBUSY/);
      expect(frames).not.toMatch(/Rolled back partial adopt/);
    } finally {
      vi.restoreAllMocks();
      await cleanupVault(vault);
    }
  }, 60_000);

  // ───── Scenarios 34-35: Ctrl+C stops the writes and rolls back once (#249) ─────

  async function adoptWithCtrlC(
    vault: string,
    interceptor: (vault: string, interrupt: () => Promise<void>) => void,
  ): Promise<{ exit: ReturnType<typeof vi.spyOn> }> {
    const { stub, fixtures } = getCtx();
    stub.setRef(SHARD_SLUG, 'v0.1.0', STUB_SHA, fixtures.byVersion['0.1.0']!);
    await writeRel(vault, 'Home.md', 'my pre-existing Home\n');
    const valuesFile = path.join(vault, 'values.yaml');
    await fs.writeFile(valuesFile, stringifyYaml(DEFAULT_VALUES), 'utf-8');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    // Ctrl+C, then time for the handler to do whatever it does before the
    // intercepted operation goes on.
    interceptor(vault, async () => {
      process.emit('SIGINT');
      await new Promise((r) => setTimeout(r, 200));
    });
    mountAdopt({
      shardRef: `${SHARD_REF}#v0.1.0`,
      vaultRoot: vault,
      options: { yes: true, values: valuesFile, mode: 'use-all-theirs' },
    });
    await waitFor(() => (exit.mock.calls.length > 0 ? 'exited' : ''), (f) => f === 'exited', 30_000);
    await tick(500);
    return { exit };
  }

  it('34. Ctrl+C mid-write → the adopt writes nothing more and leaves no state behind', async () => {
    const vault = await makeVaultDir('s34-ctrl-c-mid-write');
    const realWrite = fs.writeFile;
    const writtenAfter: string[] = [];
    let interrupted = false;
    try {
      const { exit } = await adoptWithCtrlC(vault, (v, interrupt) => {
        vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, opts) => {
          const f = String(file);
          if (interrupted && f.startsWith(v)) writtenAfter.push(path.relative(v, f));
          if (!interrupted && f === path.join(v, 'CLAUDE.md')) {
            interrupted = true;
            await interrupt();
          }
          return realWrite(file, data, opts);
        });
      });
      expect(exit).toHaveBeenCalledWith(130);
      expect(writtenAfter).toEqual([]);
      await expect(fs.access(path.join(vault, '.shardmind', 'state.json'))).rejects.toThrow();
      expect(await fs.readFile(path.join(vault, 'Home.md'), 'utf-8')).toBe('my pre-existing Home\n');
    } finally {
      vi.restoreAllMocks();
      resetSigintRollbackForTests();
      await cleanupVault(vault);
    }
  }, 60_000);

  it("35. Ctrl+C while a failed adopt rolls back → the snapshot is restored once, not twice", async () => {
    const vault = await makeVaultDir('s35-ctrl-c-mid-rollback');
    const realWrite = fs.writeFile;
    const realCopy = fs.copyFile;
    let homeRestores = 0;
    let interrupted = false;
    try {
      await adoptWithCtrlC(vault, (v, interrupt) => {
        // The values file's write fails after Home.md was written, so runAdopt rolls back on its own.
        vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, opts) => {
          if (file === path.join(v, 'shard-values.yaml')) {
            throw Object.assign(new Error('simulated EACCES'), { code: 'EACCES' });
          }
          return realWrite(file, data, opts);
        });
        // Ctrl+C lands while that rollback restores Home.md.
        vi.spyOn(fs, 'copyFile').mockImplementation(async (src, dst, mode) => {
          if (dst === path.join(v, 'Home.md') && String(src).includes(path.join('.shardmind', 'backups'))) {
            homeRestores++;
            if (!interrupted) {
              interrupted = true;
              await interrupt();
            }
          }
          return realCopy(src, dst, mode);
        });
      });
      expect(homeRestores).toBe(1);
      expect(await fs.readFile(path.join(vault, 'Home.md'), 'utf-8')).toBe('my pre-existing Home\n');
    } finally {
      vi.restoreAllMocks();
      resetSigintRollbackForTests();
      await cleanupVault(vault);
    }
  }, 60_000);

  // ───── Scenario 31: --yes --mode=auto-merge → non-interactive, conflicts keep-mine (#120) ─────

  it('31. --yes --mode=auto-merge → non-conflicting merged, conflicting falls back to keep-mine', async () => {
    const { stub, fixtures } = getCtx();
    stub.setRef(SHARD_SLUG, 'v0.1.0', STUB_SHA, fixtures.byVersion['0.1.0']!);
    const vault = await makeVaultDir('s31-auto-merge-yes');
    try {
      // Empty file → non-conflicting union (auto-merged); divergent file →
      // conflict. Under --yes (no prompt) the conflict must fall back to
      // keep-mine, not hang waiting for a decision.
      await writeRel(vault, 'Home.md', '');
      await writeRel(vault, 'brain/North Star.md', '# totally different\nxyz\n');
      const valuesFile = path.join(vault, 'values.yaml');
      await fs.writeFile(valuesFile, stringifyYaml(DEFAULT_VALUES), 'utf-8');
      const r = mountAdopt({
        shardRef: `${SHARD_REF}#v0.1.0`,
        vaultRoot: vault,
        options: { yes: true, values: valuesFile, mode: 'auto-merge' },
      });
      const frame = await waitFor(
        r.lastFrame,
        (f) => /Adopted shardmind\/minimal/.test(f),
        30_000,
      );
      // Home.md auto-merged to the shard bytes; North Star kept (conflict fallback).
      expect(frame).toMatch(/auto-merged/);
      expect(frame).toMatch(/kept your version/);
      expect(await fs.readFile(path.join(vault, 'Home.md'), 'utf-8')).not.toBe('');
      expect(
        await fs.readFile(path.join(vault, 'brain/North Star.md'), 'utf-8'),
      ).toContain('totally different');
    } finally {
      await cleanupVault(vault);
    }
  }, 60_000);

  // ───── Scenario 32: --from-version moves a file cloned at its old path (#179) ─────

  it('32. --from-version → a file at a renamed path is kept and moved to the new one', async () => {
    const { stub } = getCtx();
    const vault = await makeVaultDir('s32-from-version');
    try {
      await writeRel(vault, 'CLAUDE.md', 'My agent notes.\n');
      const tarPath = await buildCustomTarball({
        version: '0.2.0',
        prefix: 'adopt-renamed-0.2.0',
        manifestOverrides: { migrations: [{ from: '0.1.0', to: '0.2.0', renames: { 'CLAUDE.md': 'AGENTS.md' } }] },
        mutate: (dir) => fs.rename(path.join(dir, 'CLAUDE.md'), path.join(dir, 'AGENTS.md')),
        outDir: vault,
      });
      stub.setRef(SLUG_RENAMED, 'v0.2.0', STUB_SHA, tarPath);
      const valuesFile = path.join(vault, 'values.yaml');
      await fs.writeFile(valuesFile, stringifyYaml(DEFAULT_VALUES), 'utf-8');
      const r = mountAdopt({
        shardRef: `github:${SLUG_RENAMED}#v0.2.0`,
        vaultRoot: vault,
        options: { yes: true, values: valuesFile, fromVersion: '0.1.0' },
      });
      const frame = await waitFor(r.lastFrame, (f) => /Adopted shardmind\/minimal/.test(f), 30_000);
      expect(frame).toContain('CLAUDE.md → AGENTS.md');
      expect(await fs.readFile(path.join(vault, 'AGENTS.md'), 'utf-8')).toBe('My agent notes.\n');
      await expect(fs.access(path.join(vault, 'CLAUDE.md'))).rejects.toThrow();
    } finally {
      await cleanupVault(vault);
    }
  }, 60_000);

  // ───── Scenario 33: --from-version that is not a version → refused before the fetch (#179) ─────

  it('33. --from-version not semver → ADOPT_FROM_VERSION_INVALID, nothing fetched', async () => {
    const vault = await makeVaultDir('s33-from-version-invalid');
    try {
      // A shard the stub never serves: any network step would fail with
      // another code, so this one can only come from before the fetch.
      const r = mountAdopt({
        shardRef: 'github:acme/never-served#v0.2.0',
        vaultRoot: vault,
        options: { fromVersion: 'five' },
      });
      // The refusal is immediate and the command exits ~100 ms later, writing
      // an empty last frame: search every frame, not just the last one.
      const frame = await waitFor(() => r.frames.join('\n'), (f) => /ADOPT_FROM_VERSION_INVALID/.test(f), 30_000);
      expect(frame).toContain("'five'");
    } finally {
      await cleanupVault(vault);
    }
  }, 45_000);
});

async function writeRel(vault: string, rel: string, content: string): Promise<void> {
  const abs = path.join(vault, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf-8');
}
