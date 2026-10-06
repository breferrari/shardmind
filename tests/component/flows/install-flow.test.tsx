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

import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup } from 'ink-testing-library';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parse as parseYaml } from 'yaml';

import {
  setupFlowSuite,
  mountInstall,
  makeVaultDir,
  cleanupVault,
  buildCustomTarball,
  allFrames,
  driveMinimalWizard,
  SHARD_SLUG,
  SHARD_REF,
  STUB_SHA,
  DEFAULT_VALUES,
} from './helpers.js';
import { createInstalledVault, type Vault } from '../../e2e/helpers/vault.js';
import { resetSigintRollbackForTests } from '../../../source/commands/hooks/shared.js';
import { symlinksWork } from '../../helpers/fs-capabilities.js';
import { tick, waitFor, ENTER, ESC, ARROW_DOWN, SPACE, typeText } from '../helpers.js';

// Custom-tarball slugs for scenarios that need a shape minimal-shard
// can't supply. Each gets its own slug so the stub maps cleanly.
const SLUG_MIDDLE_DEFAULT = 'acme/select-middle';
const SLUG_NUMBER_TYPE = 'acme/number-range';
const SLUG_COMPUTED = 'acme/computed-default';
const SLUG_MULTISELECT = 'acme/multiselect';
const SLUG_VERSION_MISMATCH = 'acme/future-engine';
const SLUG_BROKEN = 'acme/broken-render';
const SLUG_DROPPED = 'acme/dropped-files';
const SLUG_LINT = 'acme/lint-before-wizard';
const SLUG_TOOLS = 'acme/external-tools';

const canSymlink = await symlinksWork();

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
      [SLUG_DROPPED]: {
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
      [SLUG_TOOLS]: {
        versions: {} as Record<string, string>,
        latest: '0.1.0',
      },
    },
  });

  // ───── External tools (#138) ─────
  // `node` is on PATH wherever the tests run, so a range it cannot meet
  // refuses for real, and a name nothing provides is reliably missing.

  /** A shard declaring `tools`, served at `#<ref>` on SLUG_TOOLS. */
  async function toolsShard(ref: string, tools: Record<string, unknown>, outDir: string): Promise<string> {
    const { stub } = getCtx();
    const tarPath = await buildCustomTarball({
      version: '0.1.0',
      prefix: `external-tools-${ref}`,
      manifestOverrides: { hooks: {}, name: 'external-tools', namespace: 'flowtest', external_tools: tools },
      outDir,
    });
    stub.setRef(SLUG_TOOLS, ref, STUB_SHA, tarPath);
    return `github:${SLUG_TOOLS}#${ref}`;
  }

  const stateWritten = (vault: string) =>
    fs.stat(path.join(vault, '.shardmind', 'state.json')).then((st) => st.isFile(), () => false);

  it('a required tool out of range → EXTERNAL_TOOL_UNMET before any write, hint inside the range (#138)', async () => {
    const vault = await makeVaultDir('s-tools-required');
    try {
      const ref = await toolsShard('v-required', { node: { package: 'node', version: '>=999.0.0', command: 'node' } }, vault);
      const r = mountInstall({ shardRef: ref, vaultRoot: vault, options: { defaults: true } });
      const frame = await waitFor(
        allFrames(r),
        (f) => /EXTERNAL_TOOL_UNMET/.test(f) && /node: found \d+\.\d+\.\d+, needs >=999\.0\.0/.test(f) && /npm i -g node@">=999\.0\.0"/.test(f),
        30_000,
      );
      expect(frame).toMatch(/EXTERNAL_TOOL_UNMET/);
      expect(await stateWritten(vault)).toBe(false);
    } finally {
      await cleanupVault(vault);
    }
  }, 45_000);

  it('an optional tool missing → the install completes and the summary lists it (#138)', async () => {
    const vault = await makeVaultDir('s-tools-optional');
    try {
      const ref = await toolsShard(
        'v-optional',
        {
          'shardmind-no-such-tool': { package: 'no-such-tool', version: '>=1.0.0', command: 'shardmind-no-such-tool', optional: true },
          node: { package: 'node', version: '>=1.0.0', command: 'node' },
        },
        vault,
      );
      const r = mountInstall({ shardRef: ref, vaultRoot: vault, options: { defaults: true } });
      const frame = await waitFor(
        allFrames(r),
        (f) => /Installed/.test(f) && /External tools:/.test(f) && /shardmind-no-such-tool: not found on PATH/.test(f),
        30_000,
      );
      expect(frame).toMatch(/npm i -g no-such-tool@">=1\.0\.0"/);
      expect(frame).not.toMatch(/node:/);
      expect(await stateWritten(vault)).toBe(true);
    } finally {
      await cleanupVault(vault);
    }
  }, 45_000);

  it('a dry run checks no tool and says so (#138)', async () => {
    const vault = await makeVaultDir('s-tools-dry-run');
    try {
      const ref = await toolsShard('v-dry-run', { node: { package: 'node', version: '>=999.0.0', command: 'node' } }, vault);
      const r = mountInstall({ shardRef: ref, vaultRoot: vault, options: { defaults: true, dryRun: true } });
      const frame = await waitFor(allFrames(r), (f) => /external tools not checked \(dry run\)/.test(f), 30_000);
      expect(frame).not.toMatch(/EXTERNAL_TOOL_UNMET/);
    } finally {
      await cleanupVault(vault);
    }
  }, 45_000);

  afterEach(() => {
    cleanup();
    // A Ctrl+C sets a once-per-process latch (#155); reset it between tests (#249).
    resetSigintRollbackForTests();
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
      const done = await waitFor(
        r.lastFrame,
        (f) => /Installed shardmind\/minimal@0\.1\.0/.test(f),
        15_000,
      );
      // In place (`.`, #333): no folder to point at, no cd line.
      expect(done).not.toContain('Your vault is in');
      expect(done).not.toMatch(/cd /);
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

  // ───── Another run holds the vault (#253) ─────

  it('install is refused while another shardmind run holds the vault, before it reads or writes (#253)', async () => {
    const { stub, fixtures } = getCtx();
    stub.setVersion(SHARD_SLUG, '0.1.0', fixtures.byVersion['0.1.0']!);
    stub.setLatest(SHARD_SLUG, '0.1.0');
    const vault = await makeVaultDir('s-vault-locked');
    try {
      // The test runner's parent: another process, and alive, so its lock is held.
      await fs.writeFile(
        path.join(vault, '.shardmind.lock'),
        JSON.stringify({ pid: process.ppid, hostname: (await import('node:os')).hostname(), command: 'update', startedAt: '2026-10-04T12:00:00.000Z' }),
      );
      const r = mountInstall({ shardRef: SHARD_REF, vaultRoot: vault });
      const all = await waitFor(
        () => r.frames.join(' ').replace(/\s+/g, ' '),
        (f) => /VAULT_LOCKED/.test(f),
        30_000,
      );
      expect(all).toContain(`update (PID ${process.ppid}`);
      expect(all).not.toMatch(/questions to answer/);
      expect(await fs.readdir(vault)).toEqual(['.shardmind.lock']);
    } finally {
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

  it("--force reinstall keeps the user's own .shardmind/ files (#237)", async () => {
    const { stub, fixtures } = getCtx();
    stub.setVersion(SHARD_SLUG, '0.1.0', fixtures.byVersion['0.1.0']!);
    stub.setLatest(SHARD_SLUG, '0.1.0');
    const vault = await createInstalledVault({
      stub,
      shardRef: SHARD_REF,
      values: DEFAULT_VALUES,
      prefix: 's237-force-keeps-own',
    });
    try {
      // The vault owner's own file in the engine's folder (#190), and a
      // nested one, alongside the engine's entries.
      const ignore = 'archive/\n';
      await vault.writeFile('.shardmind/boundary-ignore', ignore);
      await vault.writeFile('.shardmind/notes/why.md', 'my notes\n');
      const r = mountInstall({ shardRef: SHARD_REF, vaultRoot: vault.root, options: { force: true } });
      await waitFor(r.lastFrame, (f) => /4 questions to answer/.test(f), 30_000);
      await driveMinimalWizard(r, 'Bob');
      r.stdin.write(ENTER);
      await waitFor(r.lastFrame, (f) => f.includes('Ready to install'));
      r.stdin.write(ENTER);
      await waitFor(r.lastFrame, (f) => /Installed shardmind\/minimal@0\.1\.0/.test(f), 15_000);
      expect(await vault.readFile('.shardmind/boundary-ignore')).toBe(ignore);
      expect(await vault.readFile('.shardmind/notes/why.md')).toBe('my notes\n');
      // The new install's own state, not the old one's.
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

  it('17. --force reinstall whose render fails → old install and edits restored, nothing left aside (#55)', async () => {
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
          // Fails only with a name typed in the wizard, so the pre-install check
          // (#35), which renders with the defaults, lets it through.
          await fs.writeFile(
            path.join(work, 'zz-broken.md.njk'),
            '{% if user_name == "Boom" %}{{ user_name | nosuchfilter }}{% endif %}\n',
          );
        },
      });
      stub.setRef(SLUG_BROKEN, 'v0.1.0', STUB_SHA, tarPath);
      const r = mountInstall({
        shardRef: `github:${SLUG_BROKEN}#v0.1.0`,
        vaultRoot: vault.root,
        options: { force: true },
      });
      await driveMinimalWizard(r, 'Boom');
      r.stdin.write(ENTER);
      await waitFor(r.lastFrame, (f) => f.includes('Ready to install'));
      r.stdin.write(ENTER);
      // An error exits ~100 ms after rendering, which clears lastFrame; read the history.
      await waitFor(() => r.frames.join('\n'), (f) => /RENDER_TEMPLATE_ERROR/.test(f), 30_000);
      await tick(200);
      expect(await vault.readFile('.shardmind/state.json')).toBe(stateBefore);
      expect(await vault.readFile('shard-values.yaml')).toBe(valuesBefore);
      expect(await vault.readFile('Home.md')).toBe('my edited home\n');
      expect(await leftoverBackups(vault.root)).toEqual([]);
    } finally {
      await vault.cleanup();
    }
  }, 60_000);
  // ───── Ctrl+C while a reinstall moves files aside puts them all back once (#55, #249) ─────

  it('Ctrl+C while a --force reinstall moves files aside → old install and edits restored (#249)', async () => {
    const { stub, fixtures } = getCtx();
    stub.setVersion(SHARD_SLUG, '0.1.0', fixtures.byVersion['0.1.0']!);
    stub.setLatest(SHARD_SLUG, '0.1.0');
    const vault = await createInstalledVault({
      stub,
      shardRef: SHARD_REF,
      values: DEFAULT_VALUES,
      prefix: 's249-ctrl-c-set-aside',
    });
    const realRename = fs.rename;
    let interrupted = false;
    let movedAfter = 0;
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      await vault.writeFile('Home.md', 'my edited home\n');
      const stateBefore = await vault.readFile('.shardmind/state.json');
      vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (interrupted && String(to).includes('shardmind-backup-')) movedAfter++;
        const result = await realRename(from, to);
        if (!interrupted && String(to).includes('shardmind-backup-')) {
          // Ctrl+C lands right after the first move aside.
          interrupted = true;
          process.emit('SIGINT');
          await new Promise((r) => setImmediate(r));
        }
        return result;
      });
      const r = mountInstall({ shardRef: SHARD_REF, vaultRoot: vault.root, options: { force: true } });
      await driveMinimalWizard(r, 'Dana');
      r.stdin.write(ENTER);
      await waitFor(r.lastFrame, (f) => f.includes('Ready to install'));
      r.stdin.write(ENTER);
      await waitFor(() => (exit.mock.calls.length > 0 ? 'exited' : ''), (f) => f === 'exited', 30_000);
      await tick(500);
      expect(interrupted).toBe(true);
      expect(exit).toHaveBeenCalledWith(130);
      // The loop stops before its next move (#55).
      expect(movedAfter).toBe(0);
      expect(await vault.readFile('.shardmind/state.json')).toBe(stateBefore);
      expect(await vault.readFile('Home.md')).toBe('my edited home\n');
      expect(await leftoverBackups(vault.root)).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      resetSigintRollbackForTests();
      await vault.cleanup();
    }
  }, 60_000);

  // ───── A reinstall removes the files it no longer plans, keeps the ones you edited (#228) ─────

  async function reinstallWithoutTwoFiles(
    prefix: string,
    opts: { breakRender: boolean; before?: (vault: Vault) => Promise<void> },
  ) {
    const { stub, fixtures } = getCtx();
    stub.setVersion(SHARD_SLUG, '0.1.0', fixtures.byVersion['0.1.0']!);
    stub.setLatest(SHARD_SLUG, '0.1.0');
    const vault = await createInstalledVault({ stub, shardRef: SHARD_REF, values: DEFAULT_VALUES, prefix });
    // The user edits CLAUDE.md; brain/North Star.md stays as installed.
    await vault.writeFile('CLAUDE.md', 'my own CLAUDE notes\n');
    const northStar = await vault.readFile('brain/North Star.md');
    await opts.before?.(vault);
    const tarPath = await buildCustomTarball({
      version: '0.1.0',
      prefix: `dropped-${prefix}`,
      manifestOverrides: { hooks: {}, name: 'minimal', namespace: 'shardmind' },
      outDir: vault.root,
      mutate: async (work) => {
        await fs.rm(path.join(work, 'CLAUDE.md'));
        await fs.rm(path.join(work, 'brain', 'North Star.md.njk'));
        if (opts.breakRender) {
          await fs.writeFile(
            path.join(work, 'zz-broken.md.njk'),
            '{% if user_name == "Boom" %}{{ user_name | nosuchfilter }}{% endif %}\n',
          );
        }
      },
    });
    stub.setRef(SLUG_DROPPED, 'v0.1.0', STUB_SHA, tarPath);
    const r = mountInstall({ shardRef: `github:${SLUG_DROPPED}#v0.1.0`, vaultRoot: vault.root, options: { force: true } });
    await driveMinimalWizard(r, opts.breakRender ? 'Boom' : 'Dana');
    r.stdin.write(ENTER);
    await waitFor(r.lastFrame, (f) => f.includes('Ready to install'));
    r.stdin.write(ENTER);
    return { vault, r, northStar };
  }

  it('--force reinstall of a release without two files → removes the untouched one, keeps the edited one (#228)', async () => {
    const { vault, r } = await reinstallWithoutTwoFiles('s228-stale', { breakRender: false });
    try {
      // The summary exits ~100 ms after rendering, which clears lastFrame; read the history.
      const frame = await waitFor(() => r.frames.join('\n'), (f) => /Removed 1 file/.test(f), 30_000);
      expect(frame).toMatch(/brain\/North Star\.md/);
      expect(frame).toMatch(/Kept 1 file you edited/);
      expect(frame).toMatch(/CLAUDE\.md/);
      await expect(fs.access(path.join(vault.root, 'brain', 'North Star.md'))).rejects.toThrow();
      expect(await vault.readFile('CLAUDE.md')).toBe('my own CLAUDE notes\n');
      const state = JSON.parse(await vault.readFile('.shardmind/state.json')) as { files: Record<string, unknown> };
      expect(Object.keys(state.files)).not.toContain('brain/North Star.md');
      expect(Object.keys(state.files)).not.toContain('CLAUDE.md');
      expect(await leftoverBackups(vault.root)).toEqual([]);
    } finally {
      await vault.cleanup();
    }
  }, 90_000);

  it.skipIf(!canSymlink)('refuses to remove a stale file through a linked folder out of the vault (#228)', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'stale-outside-'));
    const target = path.join(outside, 'North Star.md');
    const { vault, r } = await reinstallWithoutTwoFiles('s228-stale-link', {
      breakRender: false,
      before: async (v) => {
        // brain/ now links to a folder outside the vault holding the same bytes.
        await fs.writeFile(target, await v.readFile('brain/North Star.md'));
        await fs.rm(path.join(v.root, 'brain'), { recursive: true });
        await fs.symlink(outside, path.join(v.root, 'brain'), process.platform === 'win32' ? 'junction' : 'dir');
      },
    });
    try {
      await waitFor(() => r.frames.join('\n'), (f) => /VAULT_PATH_UNSAFE/.test(f), 30_000);
      await tick(200);
      expect((await fs.stat(target)).isFile()).toBe(true);
    } finally {
      await vault.cleanup();
      await fs.rm(outside, { recursive: true, force: true });
    }
  }, 90_000);

  it('the same reinstall failing puts the file it would have removed back (#228)', async () => {
    const { vault, r, northStar } = await reinstallWithoutTwoFiles('s228-stale-fails', { breakRender: true });
    try {
      await waitFor(() => r.frames.join('\n'), (f) => /RENDER_TEMPLATE_ERROR/.test(f), 30_000);
      await tick(200);
      expect(await vault.readFile('brain/North Star.md')).toBe(northStar);
      expect(await vault.readFile('CLAUDE.md')).toBe('my own CLAUDE notes\n');
      expect(await leftoverBackups(vault.root)).toEqual([]);
    } finally {
      await vault.cleanup();
    }
  }, 90_000);

  // ───── A fresh install whose render fails mid-write leaves nothing behind (#207) ─────

  it('Ctrl+C mid-install → the install writes nothing more and leaves nothing behind (#249)', async () => {
    const { stub, fixtures } = getCtx();
    stub.setVersion(SHARD_SLUG, '0.1.0', fixtures.byVersion['0.1.0']!);
    stub.setLatest(SHARD_SLUG, '0.1.0');
    const vaultRoot = await makeVaultDir('s249-ctrl-c-install');
    const realWrite = fs.writeFile;
    const writtenAfter: string[] = [];
    let interrupted = false;
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const inVault = (f: string) => path.resolve(f).toLowerCase().startsWith(path.resolve(vaultRoot).toLowerCase());
    vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, opts) => {
      const f = String(file);
      if (interrupted && inVault(f)) writtenAfter.push(path.relative(vaultRoot, f));
      if (!interrupted && inVault(f)) {
        // Ctrl+C lands during the install's first write, which then goes on
        // while the handler acts: the two overlap, as they do for real.
        interrupted = true;
        process.emit('SIGINT');
        await new Promise((r) => setImmediate(r));
      }
      return realWrite(file, data, opts);
    });
    try {
      const r = mountInstall({ shardRef: SHARD_REF, vaultRoot, options: { defaults: true } });
      void r;
      await waitFor(() => (exit.mock.calls.length > 0 ? 'exited' : ''), (f) => f === 'exited', 30_000);
      await tick(500);
      expect(exit).toHaveBeenCalledWith(130);
      expect(interrupted).toBe(true);
      expect(writtenAfter).toEqual([]);
      expect(await fs.readdir(vaultRoot)).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      resetSigintRollbackForTests();
      await cleanupVault(vaultRoot);
    }
  }, 60_000);

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

  it("a failed install whose backup can't be moved back says so, not 'Rolled back' (#247)", async () => {
    const { stub, fixtures } = getCtx();
    stub.setVersion(SHARD_SLUG, '0.1.0', fixtures.byVersion['0.1.0']!);
    stub.setLatest(SHARD_SLUG, '0.1.0');
    const vaultRoot = await makeVaultDir('s247-backup-not-restored');
    // The user's Home.md collides and is backed up (`--defaults`); the stray
    // values file then fails the install after its files are written.
    await fs.writeFile(path.join(vaultRoot, 'Home.md'), 'my home\n', 'utf-8');
    await fs.writeFile(path.join(vaultRoot, 'shard-values.yaml'), 'user_name: "left over"\n', 'utf-8');
    const realRename = fs.rename;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from).includes('.shardmind-backup')) {
        throw Object.assign(new Error('simulated EBUSY'), { code: 'EBUSY' });
      }
      return realRename(from, to);
    });
    try {
      const r = mountInstall({ shardRef: SHARD_REF, vaultRoot, options: { defaults: true } });
      await waitFor(() => r.frames.join('\n'), (f) => /ROLLBACK_INCOMPLETE/.test(f), 30_000);
      await tick(200);
      const frames = r.frames.join('\n');
      expect(frames).toMatch(/VALUES_FILE_COLLISION/);
      expect(frames).toMatch(/Home\.md: restore failed: simulated EBUSY/);
      expect(frames).not.toMatch(/Rolled back partial install/);
      const backup = (await fs.readdir(vaultRoot)).find((n) => n.includes('.shardmind-backup'));
      expect(await fs.readFile(path.join(vaultRoot, backup!), 'utf-8')).toBe('my home\n');
    } finally {
      vi.restoreAllMocks();
      await cleanupVault(vaultRoot);
    }
  }, 60_000);

  // ───── A failed fresh install keeps the user's .shardmind/ files and folders (#215) ─────

  it("fresh install that fails keeps the user's .shardmind/boundary-ignore and empty folder (#215)", async () => {
    const { stub, fixtures } = getCtx();
    stub.setVersion(SHARD_SLUG, '0.1.0', fixtures.byVersion['0.1.0']!);
    stub.setLatest(SHARD_SLUG, '0.1.0');
    const vaultRoot = await makeVaultDir('s215-keep-own');
    try {
      // The user's own `.shardmind/boundary-ignore` (#190) and an empty
      // folder the shard also writes into, both made before any install.
      const ignore = 'archive/\n';
      await fs.mkdir(path.join(vaultRoot, '.shardmind'), { recursive: true });
      await fs.writeFile(path.join(vaultRoot, '.shardmind', 'boundary-ignore'), ignore, 'utf-8');
      await fs.mkdir(path.join(vaultRoot, 'brain'), { recursive: true });
      // Fails the last write, after every file and state.json (as in #207).
      const stray = 'user_name: "left over"\n';
      await fs.writeFile(path.join(vaultRoot, 'shard-values.yaml'), stray, 'utf-8');
      const r = mountInstall({ shardRef: SHARD_REF, vaultRoot, options: { defaults: true } });
      await waitFor(() => r.frames.join('\n'), (f) => /VALUES_FILE_COLLISION/.test(f), 30_000);
      await tick(200);
      expect((await fs.readdir(vaultRoot)).sort()).toEqual(['.shardmind', 'brain', 'shard-values.yaml']);
      expect(await fs.readdir(path.join(vaultRoot, '.shardmind'))).toEqual(['boundary-ignore']);
      expect(await fs.readFile(path.join(vaultRoot, '.shardmind', 'boundary-ignore'), 'utf-8')).toBe(ignore);
      expect(await fs.readdir(path.join(vaultRoot, 'brain'))).toEqual([]);
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

  // ───── Install into a new folder (#333) ─────
  // The cwd is a temp dir; SHARD_SLUG's name is `demo`.

  describe('into a new folder (#333)', () => {
    const exists = (p: string) => fs.access(p).then(() => true, () => false);

    /** Fails every Markdown write under `under`, as a full disk would. */
    function failWritesUnder(under: string) {
      const realWrite = fs.writeFile.bind(fs);
      return vi.spyOn(fs, 'writeFile').mockImplementation((async (file: unknown, ...rest: unknown[]) => {
        if (typeof file === 'string' && file.startsWith(under) && file.endsWith('.md')) {
          throw Object.assign(new Error('EIO: injected'), { code: 'EIO' });
        }
        return (realWrite as (...a: unknown[]) => Promise<void>)(file, ...rest);
      }) as typeof fs.writeFile);
    }

    it('by default makes a folder named after the shard, installs into it and says how to get there', async () => {
      const { stub, fixtures } = getCtx();
      stub.setRef(SHARD_SLUG, 'v0.1.0', STUB_SHA, fixtures.byVersion['0.1.0']!);
      const cwd = await makeVaultDir('new-folder-default');
      try {
        const r = mountInstall({ shardRef: `${SHARD_REF}#v0.1.0`, vaultRoot: cwd, folder: undefined, options: { defaults: true } });
        const frame = await waitFor(r.lastFrame, (f) => /Installed shardmind\/minimal@0\.1\.0/.test(f), 30_000);
        expect(await exists(path.join(cwd, 'demo', '.shardmind', 'state.json'))).toBe(true);
        expect(await exists(path.join(cwd, '.shardmind'))).toBe(false);
        expect(frame).toContain('cd demo');
        expect(frame.replace(/\s+/g, ' ')).toContain('Your vault is in');
      } finally {
        await cleanupVault(cwd);
      }
    }, 45_000);

    it('a nested folder with a space makes every level, and quotes the cd line', async () => {
      const { stub, fixtures } = getCtx();
      stub.setRef(SHARD_SLUG, 'v0.1.0', STUB_SHA, fixtures.byVersion['0.1.0']!);
      const cwd = await makeVaultDir('new-folder-nested');
      try {
        const r = mountInstall({ shardRef: `${SHARD_REF}#v0.1.0`, vaultRoot: cwd, folder: 'vaults/my wiki', options: { defaults: true } });
        const frame = await waitFor(r.lastFrame, (f) => /Installed shardmind\/minimal@0\.1\.0/.test(f), 30_000);
        expect(await exists(path.join(cwd, 'vaults', 'my wiki', '.shardmind', 'state.json'))).toBe(true);
        expect(frame).toContain('cd "vaults/my wiki"');
      } finally {
        await cleanupVault(cwd);
      }
    }, 45_000);

    it('a non-empty folder is refused before any network call, and left as it was', async () => {
      const { stub } = getCtx();
      const cwd = await makeVaultDir('new-folder-taken');
      try {
        await fs.mkdir(path.join(cwd, 'demo'));
        await fs.writeFile(path.join(cwd, 'demo', 'mine.md'), 'mine\n');
        const before = stub.requestedPaths().length;
        const r = mountInstall({ shardRef: SHARD_REF, vaultRoot: cwd, folder: undefined, options: { defaults: true } });
        await waitFor(r.lastFrame, (f) => f.includes('INSTALL_DESTINATION_NOT_EMPTY'), 15_000);
        expect(stub.requestedPaths().length).toBe(before);
        expect(await fs.readdir(path.join(cwd, 'demo'))).toEqual(['mine.md']);
        expect(process.exitCode).toBe(1);
      } finally {
        process.exitCode = undefined;
        await cleanupVault(cwd);
      }
    }, 30_000);

    it('a cancel at the confirm screen leaves no folder behind', async () => {
      const { stub, fixtures } = getCtx();
      stub.setRef(SHARD_SLUG, 'v0.1.0', STUB_SHA, fixtures.byVersion['0.1.0']!);
      const cwd = await makeVaultDir('new-folder-cancel');
      try {
        const r = mountInstall({ shardRef: `${SHARD_REF}#v0.1.0`, vaultRoot: cwd, folder: undefined });
        await driveMinimalWizard(r, 'Dana');
        r.stdin.write(ENTER); // modules → confirm
        await waitFor(r.lastFrame, (f) => f.includes('Ready to install'));
        r.stdin.write(ARROW_DOWN);
        await tick(40);
        r.stdin.write(ARROW_DOWN);
        await tick(40);
        r.stdin.write(ENTER);
        await waitFor(r.lastFrame, (f) => f.includes('Cancelled'), 15_000);
        expect(await fs.readdir(cwd)).toEqual([]);
      } finally {
        await cleanupVault(cwd);
      }
    }, 45_000);

    it.each([
      ['removes the folders the install made', 'a/b', false, []],
      ['into an existing empty folder keeps the folder', undefined, true, ['demo']],
    ])('a failed write %s', async (_case, folder, preExisting, left) => {
      const { stub, fixtures } = getCtx();
      stub.setRef(SHARD_SLUG, 'v0.1.0', STUB_SHA, fixtures.byVersion['0.1.0']!);
      const cwd = await makeVaultDir('new-folder-fail');
      if (preExisting) await fs.mkdir(path.join(cwd, 'demo'));
      const spy = failWritesUnder(path.join(cwd, (folder ?? 'demo').split('/')[0]!));
      try {
        const r = mountInstall({ shardRef: `${SHARD_REF}#v0.1.0`, vaultRoot: cwd, folder, options: { defaults: true } });
        await waitFor(r.lastFrame, (f) => /EIO: injected/.test(f), 30_000);
        expect(await fs.readdir(cwd)).toEqual(left);
        if (preExisting) expect(await fs.readdir(path.join(cwd, 'demo'))).toEqual([]);
      } finally {
        spy.mockRestore();
        process.exitCode = undefined;
        await cleanupVault(cwd);
      }
    }, 45_000);

    it('--dry-run makes no folder, and says where the vault would go', async () => {
      const { stub, fixtures } = getCtx();
      stub.setRef(SHARD_SLUG, 'v0.1.0', STUB_SHA, fixtures.byVersion['0.1.0']!);
      const cwd = await makeVaultDir('new-folder-dry');
      try {
        const r = mountInstall({ shardRef: `${SHARD_REF}#v0.1.0`, vaultRoot: cwd, folder: undefined, options: { defaults: true, dryRun: true } });
        await waitFor(r.lastFrame, (f) => /would be written into demo/.test(f), 30_000);
        expect(await fs.readdir(cwd)).toEqual([]);
      } finally {
        await cleanupVault(cwd);
      }
    }, 45_000);
  });
});
