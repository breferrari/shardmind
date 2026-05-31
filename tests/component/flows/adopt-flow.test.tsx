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

import { describe, it, expect, afterEach } from 'vitest';
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
  driveMinimalWizard,
  driveDiffIteration,
  SHARD_SLUG,
  SHARD_REF,
  STUB_SHA,
  DEFAULT_VALUES,
} from './helpers.js';
import { tick, waitFor, ENTER, ARROW_DOWN } from '../helpers.js';
import { createInstalledVault, type Vault } from '../../e2e/helpers/vault.js';

const SLUG_VERSION_MISMATCH = 'acme/adopt-future-engine';

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
    },
  });

  afterEach(() => {
    cleanup();
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
});

async function writeRel(vault: string, rel: string, content: string): Promise<void> {
  const abs = path.join(vault, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf-8');
}
