/**
 * Layer 1 install command flow tests — scenarios 1–10 of [#111](https://github.com/breferrari/shardmind/issues/111) Phase 1.
 *
 * Each test mounts the whole `<Install>` component tree via the harness,
 * drives stdin like a user would, and asserts on `lastFrame()` plus the
 * resulting on-disk vault. Both #103 and #109 would have been caught at
 * this layer; until this lands, the wizard regression matrix has zero
 * automated coverage.
 *
 * Stack of seams the harness wires:
 *   - github-stub on a random port (one per file, started in beforeAll),
 *   - SHARDMIND_GITHUB_API_BASE pointed at the stub URL (lazy-read in
 *     registry.ts so this beforeAll mutation actually takes effect),
 *   - process.cwd() spied to return the test's temp vault root,
 *   - process.cwd() / vi mocks restored in the harness's afterEach.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup } from 'ink-testing-library';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import {
  setupFlowSuite,
  mountInstall,
  makeVaultDir,
  cleanupVault,
  buildCustomTarball,
  driveMinimalWizard,
  SHARD_SLUG,
  SHARD_REF,
  STUB_SHA,
  DEFAULT_VALUES,
} from './helpers.js';
import { createInstalledVault } from '../../e2e/helpers/vault.js';
import { tick, waitFor, ENTER, ESC, ARROW_DOWN, SPACE, typeText } from '../helpers.js';

// Custom-tarball slugs for scenarios that need a shape minimal-shard
// can't supply. Each gets its own slug so the stub maps cleanly.
const SLUG_MIDDLE_DEFAULT = 'acme/select-middle';
const SLUG_NUMBER_TYPE = 'acme/number-range';
const SLUG_COMPUTED = 'acme/computed-default';
const SLUG_MULTISELECT = 'acme/multiselect';
const SLUG_VERSION_MISMATCH = 'acme/future-engine';
const SLUG_BROKEN = 'acme/broken-render';
const SLUG_LINT = 'acme/lint-before-wizard';

describe('install command — Layer 1 flow tests (#111 Phase 1, scenarios 1–10)', () => {
  const getCtx = setupFlowSuite({
    shards: {
      [SHARD_SLUG]: {
        versions: {} as Record<string, string>,
        latest: '0.1.0',
      },
      [SLUG_MIDDLE_DEFAULT]: {
        versions: {} as Record<string, string>,
        latest: '0.1.0',
      },
      [SLUG_NUMBER_TYPE]: {
        versions: {} as Record<string, string>,
        latest: '0.1.0',
      },
      [SLUG_COMPUTED]: {
        versions: {} as Record<string, string>,
        latest: '0.1.0',
      },
      [SLUG_MULTISELECT]: {
        versions: {} as Record<string, string>,
        latest: '0.1.0',
      },
      [SLUG_VERSION_MISMATCH]: {
        versions: {} as Record<string, string>,
        latest: '0.1.0',
      },
      [SLUG_BROKEN]: {
        versions: {} as Record<string, string>,
        latest: '0.1.0',
      },
      [SLUG_LINT]: {
        versions: {} as Record<string, string>,
        latest: '0.1.0',
      },
    },
  });

  afterEach(() => {
    cleanup();
  });

  // ───── Scenario 1: select default = first option, Enter advances (#103 regression) ─────

  it('1. select default = first option → Enter advances (#103 regression)', async () => {
    const { stub, fixtures } = getCtx();
    // minimal-shard's vault_purpose has options [engineering, research, general]
    // and default: engineering — exactly the #103 shape. Routing via `#v0.1.0`
    // sidesteps the per-version `versions` map (the stub stores those at
    // setup time; ref installs use `setRef` which can be called any time).
    stub.setRef(SHARD_SLUG, 'v0.1.0', STUB_SHA, fixtures.byVersion['0.1.0']!);
    const vault = await makeVaultDir('s1-default-first');
    try {
      const r = mountInstall({
        shardRef: `${SHARD_REF}#v0.1.0`,
        vaultRoot: vault,
      });
      await driveMinimalWizard(r);
      // The vault_purpose select had `default = engineering` = first option.
      // Pressing Enter on it (inside driveMinimalWizard) must have advanced
      // the wizard. If #103 regressed, we'd be stuck at that prompt and the
      // helper's later waitFor for QMD would have timed out.
      r.stdin.write(ENTER); // module review default selections
      await waitFor(r.lastFrame, (f) => f.includes('Ready to install'));
      r.stdin.write(ENTER);
      await waitFor(r.lastFrame, (f) => /Installed shardmind\/minimal@0\.1\.0/.test(f), 15_000);
      const valuesYaml = await fs.readFile(path.join(vault, 'shard-values.yaml'), 'utf-8');
      const parsed = parseYaml(valuesYaml) as Record<string, unknown>;
      expect(parsed['vault_purpose']).toBe('engineering');
    } finally {
      await cleanupVault(vault);
    }
  }, 30_000);

  // ───── Scenario 2: select default = middle option ─────

  it('2. select default = middle option → Enter advances', async () => {
    const { stub } = getCtx();
    const vault = await makeVaultDir('s2-default-middle');
    try {
      const tarPath = await buildCustomTarball({
        version: '0.1.0',
        prefix: 'select-middle-0.1.0',
        manifestOverrides: { hooks: {}, name: 'select-middle', namespace: 'flowtest' },
        schema: {
          schema_version: 1,
          values: {
            color: {
              type: 'select',
              required: true,
              message: 'Pick a color',
              options: [
                { value: 'red', label: 'Red' },
                { value: 'green', label: 'Green' }, // middle option
                { value: 'blue', label: 'Blue' },
              ],
              default: 'green',
              group: 'g',
            },
          },
          groups: [{ id: 'g', label: 'G' }],
          // At least one removable module so the module review step
          // renders an interactive widget (without removable modules
          // ModuleReview shows a stub Text and the user can't advance —
          // tracked as a separate UX gap, irrelevant to scenario 2's
          // select-default focus).
          modules: {
            core: { label: 'Core', paths: ['core/'], removable: false },
            extras: { label: 'Extras', paths: ['extras/'], removable: true },
          },
          signals: [],
          frontmatter: {},
          migrations: [],
        },
        outDir: vault,
      });
      stub.setRef(SLUG_MIDDLE_DEFAULT, 'v0.1.0', STUB_SHA, tarPath);

      const r = mountInstall({
        shardRef: `github:${SLUG_MIDDLE_DEFAULT}#v0.1.0`,
        vaultRoot: vault,
      });
      await waitFor(r.lastFrame, (f) => /1 question to answer/.test(f), 30_000);
      r.stdin.write(ENTER);
      await waitFor(r.lastFrame, (f) => f.includes('Pick a color'));
      // Cursor pre-positions on the default (middle option, reordered to
      // index 0). Enter must advance.
      r.stdin.write(ENTER);
      await waitFor(r.lastFrame, (f) => f.includes('Choose modules to install'));
      r.stdin.write(ENTER);
      await waitFor(r.lastFrame, (f) => f.includes('Ready to install'));
      r.stdin.write(ENTER);
      await waitFor(r.lastFrame, (f) => /Installed flowtest\/select-middle@0\.1\.0/.test(f), 15_000);
      const valuesYaml = await fs.readFile(path.join(vault, 'shard-values.yaml'), 'utf-8');
      const parsed = parseYaml(valuesYaml) as Record<string, unknown>;
      expect(parsed['color']).toBe('green');
    } finally {
      await cleanupVault(vault);
    }
  }, 45_000);

  // ───── Scenario 3: required string + empty Enter → validation error ─────

  it('3. required string + empty Enter → validation error → typed input → advances', async () => {
    const { stub, fixtures } = getCtx();
    stub.setRef(SHARD_SLUG, 'v0.1.0', STUB_SHA, fixtures.byVersion['0.1.0']!);
    const vault = await makeVaultDir('s3-required-empty');
    try {
      const r = mountInstall({
        shardRef: `${SHARD_REF}#v0.1.0`,
        vaultRoot: vault,
      });
      await waitFor(r.lastFrame, (f) => /4 questions to answer/.test(f), 30_000);
      r.stdin.write(ENTER);
      await waitFor(r.lastFrame, (f) => f.includes('Your name'));
      // Empty Enter on required field → validation error.
      r.stdin.write(ENTER);
      await waitFor(r.lastFrame, (f) => f.includes('Required'));
      // Type a value → advance.
      await typeText(r.stdin, 'Bob');
      r.stdin.write(ENTER);
      await waitFor(r.lastFrame, (f) => f.includes('Organization'));
    } finally {
      await cleanupVault(vault);
    }
  }, 30_000);

  // ───── Scenario 4: number + min/max → out-of-range → corrected → advances ─────

  it('4. number + min/max → out-of-range → error → corrected → advances', async () => {
    const { stub } = getCtx();
    const vault = await makeVaultDir('s4-number-range');
    try {
      const tarPath = await buildCustomTarball({
        version: '0.1.0',
        prefix: 'number-range-0.1.0',
        manifestOverrides: { hooks: {}, name: 'number-range', namespace: 'flowtest' },
        schema: {
          schema_version: 1,
          values: {
            age: {
              type: 'number',
              required: true,
              message: 'Age?',
              min: 18,
              max: 99,
              default: 25,
              group: 'g',
            },
          },
          groups: [{ id: 'g', label: 'G' }],
          modules: {
            core: { label: 'Core', paths: ['core/'], removable: false },
            extras: { label: 'Extras', paths: ['extras/'], removable: true },
          },
          signals: [],
          frontmatter: {},
          migrations: [],
        },
        outDir: vault,
      });
      stub.setRef(SLUG_NUMBER_TYPE, 'v0.1.0', STUB_SHA, tarPath);

      const r = mountInstall({
        shardRef: `github:${SLUG_NUMBER_TYPE}#v0.1.0`,
        vaultRoot: vault,
      });
      await waitFor(r.lastFrame, (f) => /1 question to answer/.test(f), 30_000);
      r.stdin.write(ENTER);
      await waitFor(r.lastFrame, (f) => f.includes('Age?'));
      // The default value (25) is pre-filled in the input. Append '999'
      // to push the value out of range without clearing first (TextInput
      // treats writes as inserts, no easy clear-and-retype).
      // Wait — actually default is 25, append makes it 25999 which is
      // > max=99. So '999' suffices.
      await typeText(r.stdin, '999');
      r.stdin.write(ENTER);
      await waitFor(r.lastFrame, (f) => /Must be ≤ 99/.test(f));
      // The input still holds '25999'. We need to get back to a valid
      // number. The TextInput's defaultValue is what shows initially;
      // there's no clean way to clear from outside. Practical fix:
      // submit a backspace-equivalent sequence and retype. ASCII DEL
      // (0x7f) is what most terminals send for Backspace.
      const BACKSPACE = '\x7f';
      for (let i = 0; i < 5; i++) {
        r.stdin.write(BACKSPACE);
        await tick(20);
      }
      // Now empty (or close to it); type a valid value.
      await typeText(r.stdin, '50');
      r.stdin.write(ENTER);
      await waitFor(r.lastFrame, (f) => f.includes('Choose modules to install'));
    } finally {
      await cleanupVault(vault);
    }
  }, 45_000);

  // ───── Scenario 5: boolean (Yes/No select, #100) / default-display correct ─────

  it('5. boolean prompt — Enter on default (false) advances and Confirm renders boolean as "false"', async () => {
    const { stub, fixtures } = getCtx();
    stub.setRef(SHARD_SLUG, 'v0.1.0', STUB_SHA, fixtures.byVersion['0.1.0']!);
    const vault = await makeVaultDir('s5-boolean');
    try {
      const r = mountInstall({
        shardRef: `${SHARD_REF}#v0.1.0`,
        vaultRoot: vault,
      });
      await driveMinimalWizard(r);
      r.stdin.write(ENTER); // modules → confirm
      // Confirm step shows resolved values; boolean false renders as
      // "false" via formatValue. Wait on the assertion target and use the
      // returned frame — re-reading races Ink's next render (#136).
      const confirmFrame = await waitFor(
        r.lastFrame,
        (f) => f.includes('Ready to install') && /qmd_enabled:\s*false/.test(f),
      );
      expect(confirmFrame).toMatch(/qmd_enabled:\s*false/);
    } finally {
      await cleanupVault(vault);
    }
  }, 30_000);

  // ───── Scenario 6: computed default → preview screen ─────

  it('6. computed default → preview screen shows resolved value', async () => {
    const { stub } = getCtx();
    const vault = await makeVaultDir('s6-computed-default');
    try {
      const tarPath = await buildCustomTarball({
        version: '0.1.0',
        prefix: 'computed-0.1.0',
        manifestOverrides: { hooks: {}, name: 'computed-default', namespace: 'flowtest' },
        schema: {
          schema_version: 1,
          values: {
            // Computed default — `{{ ... }}` Nunjucks expression per
            // source/core/schema.ts `isComputedDefault`. Result: literal
            // string "DERIVED-VALUE", proving the wizard rendered the
            // expression rather than passing the raw string through.
            install_token: {
              type: 'string',
              required: false,
              message: 'Install token',
              default: '{{ "derived-value" | upper }}',
              group: 'g',
            },
          },
          groups: [{ id: 'g', label: 'G' }],
          modules: {
            core: { label: 'Core', paths: ['core/'], removable: false },
            extras: { label: 'Extras', paths: ['extras/'], removable: true },
          },
          signals: [],
          frontmatter: {},
          migrations: [],
        },
        outDir: vault,
      });
      stub.setRef(SLUG_COMPUTED, 'v0.1.0', STUB_SHA, tarPath);

      const r = mountInstall({
        shardRef: `github:${SLUG_COMPUTED}#v0.1.0`,
        vaultRoot: vault,
      });
      // No missing required values (the only value has a computed
      // default that resolves automatically). Wizard skips the value
      // step and lands on the computed-preview screen.
      const previewFrame = await waitFor(
        r.lastFrame,
        (f) =>
          f.includes('Auto-filled values') &&
          /install_token/.test(f) &&
          /DERIVED-VALUE/.test(f),
        30_000,
      );
      expect(previewFrame).toMatch(/install_token/);
      expect(previewFrame).toMatch(/DERIVED-VALUE/);
    } finally {
      await cleanupVault(vault);
    }
  }, 45_000);

  // ───── Scenario 7: ESC mid-wizard → back-nav → prior answer pre-filled ─────

  it('7. ESC mid-wizard → back-nav → prior answer pre-filled', async () => {
    const { stub, fixtures } = getCtx();
    stub.setRef(SHARD_SLUG, 'v0.1.0', STUB_SHA, fixtures.byVersion['0.1.0']!);
    const vault = await makeVaultDir('s7-esc-prefill');
    try {
      const r = mountInstall({
        shardRef: `${SHARD_REF}#v0.1.0`,
        vaultRoot: vault,
      });
      await waitFor(r.lastFrame, (f) => /4 questions to answer/.test(f), 30_000);
      r.stdin.write(ENTER);
      await waitFor(r.lastFrame, (f) => f.includes('Your name'));
      await typeText(r.stdin, 'Charlie');
      r.stdin.write(ENTER);
      await waitFor(r.lastFrame, (f) => f.includes('Organization'));
      // ESC → back to user_name. The prefill ('Charlie') should
      // re-render in the input.
      r.stdin.write(ESC);
      await waitFor(r.lastFrame, (f) => f.includes('Your name') && f.includes('Charlie'));
    } finally {
      await cleanupVault(vault);
    }
  }, 30_000);

  // ───── Scenario 8: module review → labels visible / IDs in confirm ─────

  it('8. module review renders labels; confirm step lists IDs', async () => {
    const { stub, fixtures } = getCtx();
    stub.setRef(SHARD_SLUG, 'v0.1.0', STUB_SHA, fixtures.byVersion['0.1.0']!);
    const vault = await makeVaultDir('s8-module-review');
    try {
      const r = mountInstall({
        shardRef: `${SHARD_REF}#v0.1.0`,
        vaultRoot: vault,
      });
      await driveMinimalWizard(r);
      // Module review uses LABELS for both Always-included (brain →
      // "Goals, memories, patterns") and Optional (extras → "Extra
      // features (for testing module exclusion)").
      const moduleFrame = await waitFor(
        r.lastFrame,
        (f) => /Goals, memories, patterns/.test(f) && /Extra features/.test(f),
      );
      expect(moduleFrame).toMatch(/Goals, memories, patterns/);
      expect(moduleFrame).toMatch(/Extra features/);
      r.stdin.write(ENTER);
      // Confirm step lists module IDs (not labels) under "Modules
      // included" — both `brain` (always) and `extras` (default-on
      // optional) end up included.
      const confirmFrame = await waitFor(
        r.lastFrame,
        (f) => f.includes('Ready to install') && /Modules included \(2\)/.test(f),
      );
      expect(confirmFrame).toMatch(/Modules included \(2\)/);
      expect(confirmFrame).toMatch(/brain/);
      expect(confirmFrame).toMatch(/extras/);
    } finally {
      await cleanupVault(vault);
    }
  }, 30_000);

  // ───── Scenario 9: full happy path → Summary ─────

  it('9. confirm → install → progress → summary (full happy path)', async () => {
    const { stub, fixtures } = getCtx();
    stub.setRef(SHARD_SLUG, 'v0.1.0', STUB_SHA, fixtures.byVersion['0.1.0']!);
    const vault = await makeVaultDir('s9-happy-path');
    try {
      const r = mountInstall({
        shardRef: `${SHARD_REF}#v0.1.0`,
        vaultRoot: vault,
      });
      await driveMinimalWizard(r, 'Dana');
      r.stdin.write(ENTER); // modules → confirm
      await waitFor(r.lastFrame, (f) => f.includes('Ready to install'));
      r.stdin.write(ENTER);
      await waitFor(
        r.lastFrame,
        (f) => /Installed shardmind\/minimal@0\.1\.0/.test(f),
        15_000,
      );
      // Vault was actually written.
      const stateExists = await fs
        .stat(path.join(vault, '.shardmind', 'state.json'))
        .then((s) => s.isFile())
        .catch(() => false);
      expect(stateExists).toBe(true);
      const valuesYaml = await fs.readFile(path.join(vault, 'shard-values.yaml'), 'utf-8');
      expect(valuesYaml).toContain('Dana');
    } finally {
      await cleanupVault(vault);
    }
  }, 45_000);

  // ───── Scenario 10: confirm → back → re-submit ─────

  it('10. confirm → Back to module review → re-submit', async () => {
    const { stub, fixtures } = getCtx();
    stub.setRef(SHARD_SLUG, 'v0.1.0', STUB_SHA, fixtures.byVersion['0.1.0']!);
    const vault = await makeVaultDir('s10-back-to-modules');
    try {
      const r = mountInstall({
        shardRef: `${SHARD_REF}#v0.1.0`,
        vaultRoot: vault,
      });
      await driveMinimalWizard(r, 'Eve');
      r.stdin.write(ENTER); // modules → confirm
      await waitFor(r.lastFrame, (f) => f.includes('Ready to install'));
      // Confirm options: [Install, Back to module review, Cancel].
      // Down arrow once → Back. Enter.
      r.stdin.write(ARROW_DOWN);
      await tick(40);
      r.stdin.write(ENTER);
      await waitFor(r.lastFrame, (f) => f.includes('Choose modules to install'));
      // Re-submit — Enter on default selections lands us back at confirm.
      r.stdin.write(ENTER);
      await waitFor(r.lastFrame, (f) => f.includes('Ready to install'));
    } finally {
      await cleanupVault(vault);
    }
  }, 30_000);

  // ───── Scenario 11: multiselect value — per-option default, toggle, submit (#101) ─────

  it('11. multiselect value → seeded default + space toggles + Enter → array persisted', async () => {
    const { stub } = getCtx();
    const vault = await makeVaultDir('s11-multiselect');
    try {
      const tarPath = await buildCustomTarball({
        version: '0.1.0',
        prefix: 'multiselect-0.1.0',
        manifestOverrides: { hooks: {}, name: 'multiselect', namespace: 'flowtest' },
        schema: {
          schema_version: 1,
          values: {
            // Per-option `default: true` (#101). The engine normalizes this to
            // the canonical top-level default array ['claude'] at parse time,
            // which seeds the widget's pre-checked set.
            agents: {
              type: 'multiselect',
              message: 'Which agents do you use?',
              options: [
                { value: 'claude', label: 'Claude Code', default: true },
                { value: 'codex', label: 'Codex CLI' },
                { value: 'gemini', label: 'Gemini CLI' },
              ],
              min: 1,
              group: 'g',
            },
          },
          groups: [{ id: 'g', label: 'G' }],
          modules: {
            core: { label: 'Core', paths: ['core/'], removable: false },
            extras: { label: 'Extras', paths: ['extras/'], removable: true },
          },
          signals: [],
          frontmatter: {},
          migrations: [],
        },
        outDir: vault,
      });
      stub.setRef(SLUG_MULTISELECT, 'v0.1.0', STUB_SHA, tarPath);

      const r = mountInstall({
        shardRef: `github:${SLUG_MULTISELECT}#v0.1.0`,
        vaultRoot: vault,
      });
      await waitFor(r.lastFrame, (f) => /1 question to answer/.test(f), 30_000);
      r.stdin.write(ENTER);
      await waitFor(r.lastFrame, (f) => f.includes('Which agents do you use?'));
      // claude seeds pre-checked from the synthesized default; ◆ = selected.
      await waitFor(r.lastFrame, (f) => f.includes('◆ Claude Code'));
      // Move to codex and toggle it on → ['claude', 'codex'].
      r.stdin.write(ARROW_DOWN);
      await tick(40);
      r.stdin.write(SPACE);
      await tick(40);
      r.stdin.write(ENTER);
      await waitFor(r.lastFrame, (f) => f.includes('Choose modules to install'));
      r.stdin.write(ENTER);
      await waitFor(r.lastFrame, (f) => f.includes('Ready to install'));
      r.stdin.write(ENTER);
      await waitFor(r.lastFrame, (f) => /Installed flowtest\/multiselect@0\.1\.0/.test(f), 15_000);
      const valuesYaml = await fs.readFile(path.join(vault, 'shard-values.yaml'), 'utf-8');
      const parsed = parseYaml(valuesYaml) as Record<string, unknown>;
      expect(parsed['agents']).toEqual(['claude', 'codex']);
    } finally {
      await cleanupVault(vault);
    }
  }, 45_000);

  // ───── Scenario 12: requires.shardmind unsatisfiable → refuse before any write (#121) ─────

  it('12. requires.shardmind not satisfied → SHARDMIND_VERSION_MISMATCH, no vault write (#121)', async () => {
    const { stub } = getCtx();
    const vault = await makeVaultDir('s12-version-mismatch');
    try {
      // A shard demanding a far-future engine. The running test engine
      // (shardmind's own package.json version) can never satisfy >=99.0.0,
      // so the check must fire and refuse before the wizard or any write.
      const tarPath = await buildCustomTarball({
        version: '0.1.0',
        prefix: 'future-engine-0.1.0',
        manifestOverrides: {
          hooks: {},
          name: 'future-engine',
          namespace: 'flowtest',
          requires: { shardmind: '>=99.0.0' },
        },
        outDir: vault,
      });
      stub.setRef(SLUG_VERSION_MISMATCH, 'v0.1.0', STUB_SHA, tarPath);

      const r = mountInstall({
        shardRef: `github:${SLUG_VERSION_MISMATCH}#v0.1.0`,
        vaultRoot: vault,
      });
      // Wait on everything this test asserts, and use the frame waitFor
      // RETURNS. Waiting on one string and then re-reading `lastFrame()` for a
      // different one races Ink's next render: under CPU pressure the second
      // read landed between renders and returned an empty frame, which is the
      // `expected '\n' to match /SHARDMIND_VERSION_MISMATCH/` flake in #136.
      const frame = await waitFor(
        r.lastFrame,
        (f) =>
          /requires shardmind >=99\.0\.0/.test(f) &&
          /SHARDMIND_VERSION_MISMATCH/.test(f) &&
          /npm i -g shardmind@latest/.test(f),
        30_000,
      );
      expect(frame).toMatch(/SHARDMIND_VERSION_MISMATCH/);
      expect(frame).toMatch(/npm i -g shardmind@latest/);
      // The refusal happens after parseManifest but before any executor
      // runs — the vault must hold no engine state.
      const stateExists = await fs
        .stat(path.join(vault, '.shardmind', 'state.json'))
        .then((s) => s.isFile())
        .catch(() => false);
      expect(stateExists).toBe(false);
    } finally {
      await cleanupVault(vault);
    }
  }, 45_000);

  // ───── A broken shard is refused before the wizard, every problem listed (#35) ─────

  it('broken templates → INSTALL_SHARD_INVALID before the wizard, each path listed, no vault write (#35)', async () => {
    const { stub } = getCtx();
    const vault = await makeVaultDir('s-lint-before-wizard');
    try {
      const tarPath = await buildCustomTarball({
        version: '0.1.0',
        prefix: 'lint-before-wizard-0.1.0',
        manifestOverrides: { hooks: {}, name: 'minimal', namespace: 'shardmind' },
        outDir: vault,
        mutate: async (work) => {
          await fs.writeFile(path.join(work, 'Broken One.md.njk'), '{% if %}\n');
          await fs.mkdir(path.join(work, 'extras'), { recursive: true });
          await fs.writeFile(path.join(work, 'extras', 'Broken Two.md.njk'), '{{ not_a_function() }}\n');
        },
      });
      stub.setRef(SLUG_LINT, 'v0.1.0', STUB_SHA, tarPath);
      // Interactive: without the check, the first value prompt would render.
      const r = mountInstall({ shardRef: `github:${SLUG_LINT}#v0.1.0`, vaultRoot: vault });
      // An error exits shortly after rendering, which clears lastFrame; read the history.
      const all = await waitFor(
        () => r.frames.join(' ').replace(/\s+/g, ' '),
        (f) => /INSTALL_SHARD_INVALID/.test(f) && /extras\/Broken Two\.md/.test(f),
        30_000,
      );
      expect(all).toMatch(/Broken One\.md/);
      expect(all).toMatch(/shardmind validate/);
      expect(all).not.toMatch(/questions to answer/);
      expect(await fs.readdir(vault)).not.toContain('.shardmind');
      expect(await fs.readdir(vault)).not.toContain('shard-values.yaml');
    } finally {
      await cleanupVault(vault);
    }
  }, 45_000);

  it('a --values answer the schema rejects is not a shard problem: the wizard still opens (#35)', async () => {
    const { stub, fixtures } = getCtx();
    stub.setVersion(SHARD_SLUG, '0.1.0', fixtures.byVersion['0.1.0']!);
    stub.setLatest(SHARD_SLUG, '0.1.0');
    const vault = await makeVaultDir('s-lint-bad-prefill');
    const valuesFile = `${vault}-values.yaml`;
    try {
      await fs.writeFile(valuesFile, 'vault_purpose: not-an-option\n');
      const r = mountInstall({ shardRef: SHARD_REF, vaultRoot: vault, options: { values: valuesFile } });
      const frame = await waitFor(r.lastFrame, (f) => /questions to answer/.test(f), 30_000);
      expect(frame).not.toMatch(/INSTALL_SHARD_INVALID/);
    } finally {
      await fs.rm(valuesFile, { force: true });
      await cleanupVault(vault);
    }
  }, 45_000);

  // ───── A user file at an `_each`-expanded path is backed up, not overwritten (#214) ─────

  it('install backs up a user file at a path an _each template expands to (#214)', async () => {
    const { stub } = getCtx();
    const vault = await makeVaultDir('s214-each-backup');
    const work = await makeVaultDir('s214-tarball');
    try {
      const tarPath = await buildCustomTarball({
        version: '0.1.0',
        prefix: 'each-0.1.0',
        manifestOverrides: { hooks: {}, name: 'minimal', namespace: 'shardmind' },
        outDir: work,
        mutate: async (dir) => {
          const schemaPath = path.join(dir, '.shardmind', 'shard-schema.yaml');
          const schema = await fs.readFile(schemaPath, 'utf-8');
          await fs.writeFile(
            schemaPath,
            schema.replace(
              'values:\n',
              'values:\n  people:\n    type: list\n    message: "People"\n    default: []\n    group: setup\n\n',
            ),
          );
          await fs.mkdir(path.join(dir, 'people'), { recursive: true });
          await fs.writeFile(path.join(dir, 'people', '_each.md.njk'), '# {{ item.name }}\n');
        },
      });
      stub.setRef(SLUG_BROKEN, 'v0.1.0', STUB_SHA, tarPath);
      await fs.mkdir(path.join(vault, 'people'), { recursive: true });
      await fs.writeFile(path.join(vault, 'people', 'alice.md'), 'my own notes on alice\n');
      const valuesPath = path.join(work, 'values.yaml');
      await fs.writeFile(
        valuesPath,
        'user_name: Alice\nvault_purpose: engineering\npeople:\n  - { name: Alice, slug: alice }\n',
      );
      const r = mountInstall({
        shardRef: `github:${SLUG_BROKEN}#v0.1.0`,
        vaultRoot: vault,
        options: { values: valuesPath, yes: true },
      });
      await waitFor(() => r.frames.join('\n'), (f) => /Installed shardmind\/minimal@0\.1\.0/.test(f), 30_000);
      const backups = (await leftoverBackups(vault)).map((p) => p.replace(/\\/g, '/'));
      expect(backups).toHaveLength(1);
      expect(backups[0]).toMatch(/^people\/alice\.md\.shardmind-backup-/);
      expect(await fs.readFile(path.join(vault, backups[0]!), 'utf-8')).toBe('my own notes on alice\n');
      expect(await fs.readFile(path.join(vault, 'people', 'alice.md'), 'utf-8')).toBe('# Alice\n');
    } finally {
      await cleanupVault(vault);
      await cleanupVault(work);
    }
  }, 60_000);

  // Every `.shardmind-backup-*` path anywhere under the vault.
  async function leftoverBackups(root: string): Promise<string[]> {
    const entries = await fs.readdir(root, { recursive: true });
    return entries.map(String).filter((e) => e.includes('shardmind-backup-'));
  }

  // Wizard → confirm → collision review → Overwrite (the second option).
  async function driveToOverwrite(r: ReturnType<typeof mountInstall>) {
    await driveMinimalWizard(r, 'Dana');
    r.stdin.write(ENTER); // modules → confirm
    await waitFor(r.lastFrame, (f) => f.includes('Ready to install'));
    r.stdin.write(ENTER);
    await waitFor(r.lastFrame, (f) => f.includes('Overwrite'), 15_000);
    r.stdin.write(ARROW_DOWN); // backup → overwrite
    await tick(40);
    r.stdin.write(ENTER);
  }

  // ───── Scenario 13: collision review → Overwrite → summary lists what was replaced (#55) ─────

  it('13. collision review → Overwrite → summary lists the replaced file, no backup (#55)', async () => {
    const { stub, fixtures } = getCtx();
    stub.setRef(SHARD_SLUG, 'v0.1.0', STUB_SHA, fixtures.byVersion['0.1.0']!);
    const vault = await makeVaultDir('s13-overwrite');
    try {
      await fs.writeFile(path.join(vault, 'Home.md'), 'my own home\n');
      const r = mountInstall({ shardRef: `${SHARD_REF}#v0.1.0`, vaultRoot: vault });
      await driveToOverwrite(r);
      const frame = await waitFor(
        r.lastFrame,
        (f) => /Installed shardmind\/minimal@0\.1\.0/.test(f) && /no backup/.test(f),
        15_000,
      );
      expect(frame).toContain('Replaced 1 existing file (no backup):');
      expect(frame).toContain('Home.md');
      const entries = await fs.readdir(vault);
      expect(entries.some((e) => e.includes('shardmind-backup-'))).toBe(false);
    } finally {
      await cleanupVault(vault);
    }
  }, 45_000);

  // ───── Scenario 14: --force over an existing install skips the gate (#55) ─────

  it('14. --force over an existing install → no gate → wizard → reinstalled (#55)', async () => {
    const { stub, fixtures } = getCtx();
    stub.setVersion(SHARD_SLUG, '0.1.0', fixtures.byVersion['0.1.0']!);
    stub.setLatest(SHARD_SLUG, '0.1.0');
    const vault = await createInstalledVault({
      stub,
      shardRef: SHARD_REF,
      values: DEFAULT_VALUES,
      prefix: 's14-force-reinstall',
    });
    try {
      const r = mountInstall({ shardRef: SHARD_REF, vaultRoot: vault.root, options: { force: true } });
      const wizard = await waitFor(r.lastFrame, (f) => /4 questions to answer/.test(f), 30_000);
      expect(wizard).not.toContain('Reinstall from scratch');
      await driveMinimalWizard(r, 'Bob');
      r.stdin.write(ENTER);
      await waitFor(r.lastFrame, (f) => f.includes('Ready to install'));
      r.stdin.write(ENTER);
      const frame = await waitFor(r.lastFrame, (f) => /Installed shardmind\/minimal@0\.1\.0/.test(f), 15_000);
      // The old install's files were untouched, so nothing of the user's was lost.
      expect(frame).not.toContain('(no backup)');
      expect(await leftoverBackups(vault.root)).toEqual([]);
      expect(await vault.readFile('shard-values.yaml')).toContain('Bob');
    } finally {
      await vault.cleanup();
    }
  }, 60_000);

  // ───── Scenario 15: dry run → Overwrite removes nothing (#55) ─────

  it('15. --dry-run → collision review → Overwrite leaves the file alone (#55)', async () => {
    const { stub, fixtures } = getCtx();
    stub.setRef(SHARD_SLUG, 'v0.1.0', STUB_SHA, fixtures.byVersion['0.1.0']!);
    const vault = await makeVaultDir('s15-dry-overwrite');
    try {
      await fs.writeFile(path.join(vault, 'Home.md'), 'my own home\n');
      const r = mountInstall({ shardRef: `${SHARD_REF}#v0.1.0`, vaultRoot: vault, options: { dryRun: true } });
      await driveToOverwrite(r);
      const frame = await waitFor(r.lastFrame, (f) => /Dry run complete/.test(f), 15_000);
      expect(frame).toContain('Would replace 1 existing file (no backup):');
      expect(await fs.readFile(path.join(vault, 'Home.md'), 'utf-8')).toBe('my own home\n');
    } finally {
      await cleanupVault(vault);
    }
  }, 45_000);
  // ───── Scenario 16: --force → wizard → Cancel keeps the existing install (#55) ─────

  it('16. --force over an existing install → wizard → Cancel → existing install intact (#55)', async () => {
    const { stub, fixtures } = getCtx();
    stub.setVersion(SHARD_SLUG, '0.1.0', fixtures.byVersion['0.1.0']!);
    stub.setLatest(SHARD_SLUG, '0.1.0');
    const vault = await createInstalledVault({
      stub,
      shardRef: SHARD_REF,
      values: DEFAULT_VALUES,
      prefix: 's16-force-cancel',
    });
    try {
      const stateBefore = await vault.readFile('.shardmind/state.json');
      const valuesBefore = await vault.readFile('shard-values.yaml');
      const r = mountInstall({ shardRef: SHARD_REF, vaultRoot: vault.root, options: { force: true } });
      await driveMinimalWizard(r, 'Bob');
      r.stdin.write(ENTER);
      await waitFor(r.lastFrame, (f) => f.includes('Ready to install'));
      // Confirm options: [install, back, cancel].
      r.stdin.write(ARROW_DOWN);
      r.stdin.write(ARROW_DOWN);
      await tick(40);
      r.stdin.write(ENTER);
      await waitFor(r.lastFrame, (f) => /cancelled/i.test(f), 15_000);
      expect(await vault.readFile('.shardmind/state.json')).toBe(stateBefore);
      expect(await vault.readFile('shard-values.yaml')).toBe(valuesBefore);
    } finally {
      await vault.cleanup();
    }
  }, 60_000);

  // ───── Scenario 17: a --force reinstall that fails puts everything back (#55) ─────

  it('17. --yes --force reinstall of a shard with a broken template → refused before anything is touched (#55, #35)', async () => {
    const { stub, fixtures } = getCtx();
    stub.setVersion(SHARD_SLUG, '0.1.0', fixtures.byVersion['0.1.0']!);
    stub.setLatest(SHARD_SLUG, '0.1.0');
    const vault = await createInstalledVault({
      stub,
      shardRef: SHARD_REF,
      values: DEFAULT_VALUES,
      prefix: 's17-force-rollback',
    });
    try {
      await vault.writeFile('Home.md', 'my edited home\n');
      const stateBefore = await vault.readFile('.shardmind/state.json');
      const valuesBefore = await vault.readFile('shard-values.yaml');
      const tarPath = await buildCustomTarball({
        version: '0.1.0',
        prefix: 'broken-render-0.1.0',
        manifestOverrides: { hooks: {}, name: 'minimal', namespace: 'shardmind' },
        outDir: vault.root,
        mutate: async (work) => {
          await fs.writeFile(path.join(work, 'zz-broken.md.njk'), '{{ not_a_function() }}\n');
        },
      });
      stub.setRef(SLUG_BROKEN, 'v0.1.0', STUB_SHA, tarPath);
      const r = mountInstall({
        shardRef: `github:${SLUG_BROKEN}#v0.1.0`,
        vaultRoot: vault.root,
        options: { yes: true, force: true },
      });
      // An error exits ~100 ms after rendering, which clears lastFrame; read the history.
      // The pre-install check (#35) refuses it before any move; the executor's
      // own rollback is covered by tests/integration/install.test.ts.
      await waitFor(() => r.frames.join('\n'), (f) => /INSTALL_SHARD_INVALID/.test(f), 30_000);
      await tick(200);
      expect(await vault.readFile('.shardmind/state.json')).toBe(stateBefore);
      expect(await vault.readFile('shard-values.yaml')).toBe(valuesBefore);
      expect(await vault.readFile('Home.md')).toBe('my edited home\n');
      expect(await leftoverBackups(vault.root)).toEqual([]);
    } finally {
      await vault.cleanup();
    }
  }, 60_000);
  // ───── A fresh install whose render fails mid-write leaves nothing behind (#207) ─────

  it('fresh install that fails after its files are written → only the user\'s own file is left (#207)', async () => {
    const { stub, fixtures } = getCtx();
    stub.setVersion(SHARD_SLUG, '0.1.0', fixtures.byVersion['0.1.0']!);
    stub.setLatest(SHARD_SLUG, '0.1.0');
    const vaultRoot = await makeVaultDir('s207-fresh-rollback');
    try {
      // A stray values file with no state.json: the install is fresh, every
      // file and state.json get written, and only the final exclusive
      // values write fails (VALUES_FILE_COLLISION). Deterministic, unlike a
      // failing template, whose place in the walk depends on readdir order.
      const stray = 'user_name: "left over"\n';
      await fs.writeFile(path.join(vaultRoot, 'shard-values.yaml'), stray, 'utf-8');
      const r = mountInstall({ shardRef: SHARD_REF, vaultRoot, options: { defaults: true } });
      await waitFor(() => r.frames.join('\n'), (f) => /VALUES_FILE_COLLISION/.test(f), 30_000);
      await tick(200);
      expect(r.frames.join('\n')).toMatch(/Rolled back partial install/);
      expect(await fs.readdir(vaultRoot)).toEqual(['shard-values.yaml']);
      expect(await fs.readFile(path.join(vaultRoot, 'shard-values.yaml'), 'utf-8')).toBe(stray);
    } finally {
      await cleanupVault(vaultRoot);
    }
  }, 60_000);

  // ───── Scenario 18: gate → Reinstall with --yes backs up only the user's own content (#55) ─────

  it("18. gate → Reinstall with --yes → only the edited file is backed up, the old install's untouched files are not (#55)", async () => {
    const { stub, fixtures } = getCtx();
    stub.setVersion(SHARD_SLUG, '0.1.0', fixtures.byVersion['0.1.0']!);
    stub.setLatest(SHARD_SLUG, '0.1.0');
    const vault = await createInstalledVault({
      stub,
      shardRef: SHARD_REF,
      values: DEFAULT_VALUES,
      prefix: 's18-gate-reinstall-yes',
    });
    try {
      await vault.writeFile('Home.md', 'my edited home\n');
      const r = mountInstall({ shardRef: SHARD_REF, vaultRoot: vault.root, options: { yes: true } });
      await waitFor(r.lastFrame, (f) => f.includes('Reinstall from scratch'), 30_000);
      r.stdin.write(ARROW_DOWN); // keep → reinstall
      await tick(40);
      r.stdin.write(ENTER);
      await waitFor(r.lastFrame, (f) => f.includes('Type REINSTALL to proceed'));
      await typeText(r.stdin, 'REINSTALL');
      r.stdin.write(ENTER);
      const frame = await waitFor(r.lastFrame, (f) => /Installed shardmind\/minimal@0\.1\.0/.test(f), 15_000);
      expect(frame).toContain('Backed up 1 existing file');
      const left = await leftoverBackups(vault.root);
      expect(left).toHaveLength(1);
      expect(left[0]).toMatch(/^Home\.md\.shardmind-backup-/);
    } finally {
      await vault.cleanup();
    }
  }, 60_000);
  // ───── Scenario 19: a file edited while the collision prompt is open is the user's (#55) ─────

  it('19. reinstall → collision review → a file edited meanwhile → Back up keeps it too (#55)', async () => {
    const { stub, fixtures } = getCtx();
    stub.setVersion(SHARD_SLUG, '0.1.0', fixtures.byVersion['0.1.0']!);
    stub.setLatest(SHARD_SLUG, '0.1.0');
    const vault = await createInstalledVault({
      stub,
      shardRef: SHARD_REF,
      values: DEFAULT_VALUES,
      prefix: 's19-recheck',
    });
    try {
      await vault.writeFile('Home.md', 'my edited home\n');
      const r = mountInstall({ shardRef: SHARD_REF, vaultRoot: vault.root, options: { force: true } });
      await driveMinimalWizard(r, 'Bob');
      r.stdin.write(ENTER);
      await waitFor(r.lastFrame, (f) => f.includes('Ready to install'));
      r.stdin.write(ENTER);
      await waitFor(r.lastFrame, (f) => /Installed shardmind\/minimal@0\.1\.0/.test(f), 15_000);
      // --force overwrites; a second, interactive reinstall gets the prompt.
      await vault.writeFile('Home.md', 'edited again\n');
      cleanup();
      const r2 = mountInstall({ shardRef: SHARD_REF, vaultRoot: vault.root });
      await waitFor(r2.lastFrame, (f) => f.includes('Reinstall from scratch'), 30_000);
      r2.stdin.write(ARROW_DOWN);
      await tick(40);
      r2.stdin.write(ENTER);
      await waitFor(r2.lastFrame, (f) => f.includes('Type REINSTALL to proceed'));
      await typeText(r2.stdin, 'REINSTALL');
      r2.stdin.write(ENTER);
      await driveMinimalWizard(r2, 'Cy');
      r2.stdin.write(ENTER);
      await waitFor(r2.lastFrame, (f) => f.includes('Ready to install'));
      r2.stdin.write(ENTER);
      await waitFor(r2.lastFrame, (f) => f.includes('Overwrite'), 15_000);
      // Edited while the prompt is open: untouched when it was classified.
      await vault.writeFile('brain/North Star.md', 'edited during the prompt\n');
      r2.stdin.write(ENTER); // Back up
      const frame = await waitFor(r2.lastFrame, (f) => /Installed shardmind\/minimal@0\.1\.0/.test(f), 15_000);
      expect(frame).toContain('Backed up 2 existing files');
      const left = await leftoverBackups(vault.root);
      expect(left.some((p) => /North Star\.md\.shardmind-backup-/.test(p))).toBe(true);
    } finally {
      await vault.cleanup();
    }
  }, 90_000);
});
