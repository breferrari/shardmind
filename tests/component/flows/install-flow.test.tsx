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
} from './helpers.js';
import { tick, waitFor, ENTER, ESC, ARROW_DOWN, typeText } from '../helpers.js';

const SHARD_SLUG = 'acme/demo';
const SHARD_REF = `github:${SHARD_SLUG}`;

// Custom-tarball slugs for scenarios that need a shape minimal-shard
// can't supply. Each gets its own slug so the stub maps cleanly.
const SLUG_MIDDLE_DEFAULT = 'acme/select-middle';
const SLUG_NUMBER_TYPE = 'acme/number-range';
const SLUG_COMPUTED = 'acme/computed-default';

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
    },
  });

  afterEach(() => {
    cleanup();
  });

  // Drive the standard 4-question minimal-shard wizard: user_name (typed),
  // org_name (default), vault_purpose (default), qmd_enabled ('n'). Stops
  // before the module-review step so callers can specialize behaviors.
  // Returns once the modules step is rendered.
  async function driveMinimalThroughValues(
    r: ReturnType<typeof mountInstall>,
    userName = 'Alice',
  ): Promise<void> {
    await waitFor(r.lastFrame, (f) => /4 questions to answer/.test(f), 10_000);
    r.stdin.write(ENTER);
    await waitFor(r.lastFrame, (f) => f.includes('Your name'));
    await typeText(r.stdin, userName);
    r.stdin.write(ENTER);
    await waitFor(r.lastFrame, (f) => f.includes('Organization'));
    r.stdin.write(ENTER);
    await waitFor(r.lastFrame, (f) => f.includes('How will you use this vault'));
    r.stdin.write(ENTER);
    await waitFor(r.lastFrame, (f) => f.includes('QMD'));
    r.stdin.write('n');
    await waitFor(r.lastFrame, (f) => f.includes('Choose modules to install'));
  }

  // ───── Scenario 1: select default = first option, Enter advances (#103 regression) ─────

  it('1. select default = first option → Enter advances (#103 regression)', async () => {
    const { stub, fixtures } = getCtx();
    // minimal-shard's vault_purpose has options [engineering, research, general]
    // and default: engineering — exactly the #103 shape. Routing via `#v0.1.0`
    // sidesteps the per-version `versions` map (the stub stores those at
    // setup time; ref installs use `setRef` which can be called any time).
    stub.setRef(SHARD_SLUG, 'v0.1.0', 'a'.repeat(40), fixtures.byVersion['0.1.0']!);
    const vault = await makeVaultDir('s1-default-first');
    try {
      const r = mountInstall({
        shardRef: `${SHARD_REF}#v0.1.0`,
        vaultRoot: vault,
      });
      await driveMinimalThroughValues(r);
      // The vault_purpose select had `default = engineering` = first option.
      // Pressing Enter on it (inside driveMinimalThroughValues) must have
      // advanced the wizard. If #103 regressed, we'd be stuck at that prompt
      // and the helper's later waitFor for QMD would have timed out.
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
      stub.setRef(SLUG_MIDDLE_DEFAULT, 'v0.1.0', 'b'.repeat(40), tarPath);

      const r = mountInstall({
        shardRef: `github:${SLUG_MIDDLE_DEFAULT}#v0.1.0`,
        vaultRoot: vault,
      });
      await waitFor(r.lastFrame, (f) => /1 question to answer/.test(f), 10_000);
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
    stub.setRef(SHARD_SLUG, 'v0.1.0', 'a'.repeat(40), fixtures.byVersion['0.1.0']!);
    const vault = await makeVaultDir('s3-required-empty');
    try {
      const r = mountInstall({
        shardRef: `${SHARD_REF}#v0.1.0`,
        vaultRoot: vault,
      });
      await waitFor(r.lastFrame, (f) => /4 questions to answer/.test(f), 10_000);
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
      stub.setRef(SLUG_NUMBER_TYPE, 'v0.1.0', 'c'.repeat(40), tarPath);

      const r = mountInstall({
        shardRef: `github:${SLUG_NUMBER_TYPE}#v0.1.0`,
        vaultRoot: vault,
      });
      await waitFor(r.lastFrame, (f) => /1 question to answer/.test(f), 10_000);
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

  // ───── Scenario 5: boolean → 'n' / default-display correct ─────

  it('5. boolean prompt — \'n\' advances and Confirm renders boolean as "false"', async () => {
    const { stub, fixtures } = getCtx();
    stub.setRef(SHARD_SLUG, 'v0.1.0', 'a'.repeat(40), fixtures.byVersion['0.1.0']!);
    const vault = await makeVaultDir('s5-boolean');
    try {
      const r = mountInstall({
        shardRef: `${SHARD_REF}#v0.1.0`,
        vaultRoot: vault,
      });
      await driveMinimalThroughValues(r);
      r.stdin.write(ENTER); // modules → confirm
      await waitFor(r.lastFrame, (f) => f.includes('Ready to install'));
      // Confirm step shows resolved values; boolean false renders as
      // "false" via formatValue.
      const confirmFrame = r.lastFrame() ?? '';
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
      stub.setRef(SLUG_COMPUTED, 'v0.1.0', 'd'.repeat(40), tarPath);

      const r = mountInstall({
        shardRef: `github:${SLUG_COMPUTED}#v0.1.0`,
        vaultRoot: vault,
      });
      // No missing required values (the only value has a computed
      // default that resolves automatically). Wizard skips the value
      // step and lands on the computed-preview screen.
      await waitFor(r.lastFrame, (f) => f.includes('Auto-filled values'), 15_000);
      const previewFrame = r.lastFrame() ?? '';
      expect(previewFrame).toMatch(/install_token/);
      expect(previewFrame).toMatch(/DERIVED-VALUE/);
    } finally {
      await cleanupVault(vault);
    }
  }, 45_000);

  // ───── Scenario 7: ESC mid-wizard → back-nav → prior answer pre-filled ─────

  it('7. ESC mid-wizard → back-nav → prior answer pre-filled', async () => {
    const { stub, fixtures } = getCtx();
    stub.setRef(SHARD_SLUG, 'v0.1.0', 'a'.repeat(40), fixtures.byVersion['0.1.0']!);
    const vault = await makeVaultDir('s7-esc-prefill');
    try {
      const r = mountInstall({
        shardRef: `${SHARD_REF}#v0.1.0`,
        vaultRoot: vault,
      });
      await waitFor(r.lastFrame, (f) => /4 questions to answer/.test(f), 10_000);
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
    stub.setRef(SHARD_SLUG, 'v0.1.0', 'a'.repeat(40), fixtures.byVersion['0.1.0']!);
    const vault = await makeVaultDir('s8-module-review');
    try {
      const r = mountInstall({
        shardRef: `${SHARD_REF}#v0.1.0`,
        vaultRoot: vault,
      });
      await driveMinimalThroughValues(r);
      // Module review uses LABELS for both Always-included (brain →
      // "Goals, memories, patterns") and Optional (extras → "Extra
      // features (for testing module exclusion)").
      const moduleFrame = r.lastFrame() ?? '';
      expect(moduleFrame).toMatch(/Goals, memories, patterns/);
      expect(moduleFrame).toMatch(/Extra features/);
      r.stdin.write(ENTER);
      await waitFor(r.lastFrame, (f) => f.includes('Ready to install'));
      // Confirm step lists module IDs (not labels) under "Modules
      // included" — both `brain` (always) and `extras` (default-on
      // optional) end up included.
      const confirmFrame = r.lastFrame() ?? '';
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
    stub.setRef(SHARD_SLUG, 'v0.1.0', 'a'.repeat(40), fixtures.byVersion['0.1.0']!);
    const vault = await makeVaultDir('s9-happy-path');
    try {
      const r = mountInstall({
        shardRef: `${SHARD_REF}#v0.1.0`,
        vaultRoot: vault,
      });
      await driveMinimalThroughValues(r, 'Dana');
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
    stub.setRef(SHARD_SLUG, 'v0.1.0', 'a'.repeat(40), fixtures.byVersion['0.1.0']!);
    const vault = await makeVaultDir('s10-back-to-modules');
    try {
      const r = mountInstall({
        shardRef: `${SHARD_REF}#v0.1.0`,
        vaultRoot: vault,
      });
      await driveMinimalThroughValues(r, 'Eve');
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
});
