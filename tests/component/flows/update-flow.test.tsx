/**
 * Layer 1 update command flow tests — scenarios 13-17 of [#111](https://github.com/breferrari/shardmind/issues/111) Phase 1.
 *
 * Each test pre-installs a vault via `createInstalledVault` (subprocess
 * install of v0.1.0), then mounts `<Update>` in-process to drive the
 * interactive update flow. Both #103 and #109 surface in this layer:
 * scenario 14's multi-conflict iteration is a direct regression of
 * #109 (firedRef leaked across files in DiffView).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup } from 'ink-testing-library';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  setupFlowSuite,
  mountUpdate,
  buildCustomTarball,
  driveDiffIteration,
  SHARD_SLUG,
  SHARD_REF,
  STUB_SHA,
  DEFAULT_VALUES,
} from './helpers.js';
import { tick, waitFor, ENTER, ARROW_DOWN } from '../helpers.js';
import { createInstalledVault, type Vault } from '../../e2e/helpers/vault.js';

const MULTI_CONFLICT_SLUG = 'acme/multi-conflict';
const MULTI_CONFLICT_REF = `github:${MULTI_CONFLICT_SLUG}`;
const NEW_VALUE_SLUG = 'acme/new-value';
const NEW_VALUE_REF = `github:${NEW_VALUE_SLUG}`;
const REMOVED_FILE_SLUG = 'acme/removed-file';
const REMOVED_FILE_REF = `github:${REMOVED_FILE_SLUG}`;

describe('update command — Layer 1 flow tests (#111 Phase 1, scenarios 13-17)', () => {
  const getCtx = setupFlowSuite({
    shards: {
      [SHARD_SLUG]: {
        versions: {} as Record<string, string>,
        latest: '0.1.0',
      },
      [MULTI_CONFLICT_SLUG]: {
        versions: {} as Record<string, string>,
        latest: '0.1.0',
      },
      [NEW_VALUE_SLUG]: {
        versions: {} as Record<string, string>,
        latest: '0.1.0',
      },
      [REMOVED_FILE_SLUG]: {
        versions: {} as Record<string, string>,
        latest: '0.1.0',
      },
    },
  });

  afterEach(() => {
    cleanup();
  });

  // ───── Scenario 13: single conflict → keep_mine → ownership='modified' ─────

  it('13. single conflict → DiffView → keep_mine → state.files reflects modified ownership', async () => {
    const { stub, fixtures } = getCtx();
    stub.setVersion(SHARD_SLUG, '0.1.0', fixtures.byVersion['0.1.0']!);
    stub.setLatest(SHARD_SLUG, '0.1.0');
    let vault: Vault | null = null;
    try {
      vault = await createInstalledVault({
        stub,
        shardRef: SHARD_REF,
        values: DEFAULT_VALUES,
        prefix: 's13-single-conflict',
      });
      // Append a user edit at the BOTTOM of Home.md — the same region
      // v0.3.0 modifies, so the three-way merge surfaces a conflict.
      const home = await vault.readFile('Home.md');
      await vault.writeFile('Home.md', home + '\nUser edit at the very bottom.\n');
      stub.setVersion(SHARD_SLUG, '0.3.0', fixtures.byVersion['0.3.0']!);
      stub.setLatest(SHARD_SLUG, '0.3.0');

      const r = mountUpdate({ vaultRoot: vault.root });
      // Wait for DiffView's "Conflict in Home.md" header.
      await waitFor(r.lastFrame, (f) => /Conflict in Home\.md/.test(f), 20_000);
      // Options: [accept_new, keep_mine, skip, (open_editor_disabled)].
      // ARROW_DOWN once + ENTER → keep_mine.
      r.stdin.write(ARROW_DOWN);
      await tick(40);
      r.stdin.write(ENTER);
      // UpdateSummary frame.
      await waitFor(r.lastFrame, (f) => /Updated 0\.1\.0 → 0\.3\.0/.test(f), 20_000);
      const state = JSON.parse(
        await fs.readFile(path.join(vault.root, '.shardmind', 'state.json'), 'utf-8'),
      ) as { files: Record<string, { ownership: string }> };
      expect(state.files['Home.md']?.ownership).toBe('modified');
    } finally {
      if (vault) await vault.cleanup();
    }
  }, 90_000);

  // ───── Scenario 14: ≥3 conflicts → iterate (#109 regression) ─────

  it('14. multiple conflicts → DiffView iterates each (#109 regression)', async () => {
    const { stub } = getCtx();
    // Build a v0.1.0 baseline + v0.2.0 with conflicting modifications
    // to three distinct files (Home.md, brain/North Star.md, CLAUDE.md).
    // The user pre-edits all three at conflicting regions, so the
    // update has to walk through three sequential DiffView prompts.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-'));
    try {
      const v01 = await buildCustomTarball({
        version: '0.1.0',
        prefix: 'multi-conflict-0.1.0',
        manifestOverrides: { hooks: {}, name: 'multi-conflict', namespace: 'flowtest' },
        outDir: tmpDir,
      });
      const v02 = await buildCustomTarball({
        version: '0.2.0',
        prefix: 'multi-conflict-0.2.0',
        manifestOverrides: { hooks: {}, name: 'multi-conflict', namespace: 'flowtest' },
        mutate: async (work) => {
          // Append distinguishable lines to three .njk templates. These
          // are the same files the user will edit at the bottom,
          // producing three genuine three-way conflicts. We deliberately
          // avoid CLAUDE.md here — minimal-shard's CLAUDE.md contains
          // a literal `{{ }}` token in its prose, and the merge engine
          // (`differ.ts::computeMergeAction`) renders both old + new
          // through Nunjucks even for static files. That render fails
          // on the literal token. Out of scope for this regression test.
          const home = path.join(work, 'Home.md.njk');
          await fs.writeFile(home, (await fs.readFile(home, 'utf-8')) + '\nv0.2.0 home append\n', 'utf-8');
          const ns = path.join(work, 'brain', 'North Star.md.njk');
          await fs.writeFile(ns, (await fs.readFile(ns, 'utf-8')) + '\nv0.2.0 north star append\n', 'utf-8');
          const settings = path.join(work, '.claude', 'settings.json.njk');
          await fs.writeFile(settings, (await fs.readFile(settings, 'utf-8')) + '\nv0.2.0 settings tail\n', 'utf-8');
        },
        outDir: tmpDir,
      });

      stub.setVersion(MULTI_CONFLICT_SLUG, '0.1.0', v01);
      stub.setLatest(MULTI_CONFLICT_SLUG, '0.1.0');
      const vault = await createInstalledVault({
        stub,
        shardRef: MULTI_CONFLICT_REF,
        values: DEFAULT_VALUES,
        prefix: 's14-multi-conflict',
      });
      try {
        // User edits the rendered counterparts of all three .njk
        // templates at the bottom — same region v0.2.0 appended →
        // conflict on each.
        const home = await vault.readFile('Home.md');
        await vault.writeFile('Home.md', home + '\nUser bottom edit (Home).\n');
        const ns = await vault.readFile('brain/North Star.md');
        await vault.writeFile('brain/North Star.md', ns + '\nUser bottom edit (NS).\n');
        const settings = await vault.readFile('.claude/settings.json');
        await vault.writeFile('.claude/settings.json', settings + '\nUser bottom edit (settings).\n');

        stub.setVersion(MULTI_CONFLICT_SLUG, '0.2.0', v02);
        stub.setLatest(MULTI_CONFLICT_SLUG, '0.2.0');

        const r = mountUpdate({ vaultRoot: vault.root });
        // Walk three DiffView prompts via the shared iteration helper.
        // ARROW_DOWN + ENTER on each = keep_mine. The #109 regression
        // would manifest as iteration 2 timing out on its (2 of 3)
        // counter — the dedup ref would have leaked from iteration 1.
        await driveDiffIteration(r, 3, async (r) => {
          r.stdin.write(ARROW_DOWN);
          await tick(40);
          r.stdin.write(ENTER);
        });
        await waitFor(r.lastFrame, (f) => /Updated 0\.1\.0 → 0\.2\.0/.test(f), 30_000);
        const state = JSON.parse(
          await fs.readFile(path.join(vault.root, '.shardmind', 'state.json'), 'utf-8'),
        ) as { files: Record<string, { ownership: string }> };
        // All three user-edited paths are now `modified`.
        expect(state.files['Home.md']?.ownership).toBe('modified');
        expect(state.files['brain/North Star.md']?.ownership).toBe('modified');
        expect(state.files['.claude/settings.json']?.ownership).toBe('modified');
      } finally {
        await vault.cleanup();
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }, 120_000);

  // ───── Scenario 15: conflict + accept_new → vault overwritten ─────

  it('15. conflict + accept_new → vault file matches shard render', async () => {
    const { stub, fixtures } = getCtx();
    stub.setVersion(SHARD_SLUG, '0.1.0', fixtures.byVersion['0.1.0']!);
    stub.setLatest(SHARD_SLUG, '0.1.0');
    let vault: Vault | null = null;
    try {
      vault = await createInstalledVault({
        stub,
        shardRef: SHARD_REF,
        values: DEFAULT_VALUES,
        prefix: 's15-accept-new',
      });
      const home = await vault.readFile('Home.md');
      await vault.writeFile('Home.md', home + '\nUser edit that will be discarded.\n');
      stub.setVersion(SHARD_SLUG, '0.3.0', fixtures.byVersion['0.3.0']!);
      stub.setLatest(SHARD_SLUG, '0.3.0');

      const r = mountUpdate({ vaultRoot: vault.root });
      await waitFor(r.lastFrame, (f) => /Conflict in Home\.md/.test(f), 20_000);
      // ENTER on default (cursor at first option = accept_new).
      r.stdin.write(ENTER);
      await waitFor(r.lastFrame, (f) => /Updated 0\.1\.0 → 0\.3\.0/.test(f), 20_000);
      const updated = await vault.readFile('Home.md');
      // accept_new replaces user content with shard render — user edit
      // line should be gone.
      expect(updated).not.toContain('User edit that will be discarded.');
      // v0.3.0's append should be present.
      expect(updated).toContain('Updated again in v0.3.0.');
    } finally {
      if (vault) await vault.cleanup();
    }
  }, 90_000);

  // ───── Scenario 16: new value added by updated schema is auto-applied ─────

  // Under the v6 contract, every schema value MUST declare a `default`
  // field — the schema parser rejects schemas that omit one. That makes
  // the NewValuesPrompt path (fire only when a new required value has
  // no default) effectively unreachable in practice: under v6 a "new
  // required value" always brings a default, and `computeSchemaAdditions`
  // skips it (`if (def.default !== undefined) continue;`). The
  // component-level test for the prompt widget itself lives in
  // `tests/component/NewValuesPrompt.test.tsx` and stays meaningful;
  // here we instead pin the realistic v6 update path: a v0.2.0 schema
  // that adds a value (with a default) auto-fills it during update,
  // no prompt fires, and the new value lands in shard-values.yaml.
  it('16. new value with default added by updated schema → auto-applied, no prompt', async () => {
    const { stub } = getCtx();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-'));
    try {
      const v01 = await buildCustomTarball({
        version: '0.1.0',
        prefix: 'new-value-0.1.0',
        manifestOverrides: { hooks: {}, name: 'new-value', namespace: 'flowtest' },
        outDir: tmpDir,
      });
      const v02 = await buildCustomTarball({
        version: '0.2.0',
        prefix: 'new-value-0.2.0',
        manifestOverrides: { hooks: {}, name: 'new-value', namespace: 'flowtest' },
        schema: minimalShardSchemaWithExtraRequired(),
        outDir: tmpDir,
      });
      stub.setVersion(NEW_VALUE_SLUG, '0.1.0', v01);
      stub.setLatest(NEW_VALUE_SLUG, '0.1.0');
      const vault = await createInstalledVault({
        stub,
        shardRef: NEW_VALUE_REF,
        values: DEFAULT_VALUES,
        prefix: 's16-new-value',
      });
      try {
        stub.setVersion(NEW_VALUE_SLUG, '0.2.0', v02);
        stub.setLatest(NEW_VALUE_SLUG, '0.2.0');

        const r = mountUpdate({ vaultRoot: vault.root });
        // Update auto-fills `project_id` with its schema default
        // ('PROJ-AUTO'); no prompt should appear.
        await waitFor(
          r.lastFrame,
          (f) => /Updated 0\.1\.0 → 0\.2\.0/.test(f),
          30_000,
        );
        const noPromptShown = !(r.lastFrame() ?? '').includes(
          'New values since your last install',
        );
        expect(noPromptShown).toBe(true);
        const valuesYaml = await fs.readFile(
          path.join(vault.root, 'shard-values.yaml'),
          'utf-8',
        );
        expect(valuesYaml).toContain('project_id');
        expect(valuesYaml).toContain('PROJ-AUTO');
      } finally {
        await vault.cleanup();
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }, 120_000);

  // ───── Scenario 17: removed file (user-modified) → RemovedFilesReview → keep ─────

  it('17. removed file (user-modified) → RemovedFilesReview → keep → file stays untracked', async () => {
    const { stub } = getCtx();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rm-'));
    try {
      const v01 = await buildCustomTarball({
        version: '0.1.0',
        prefix: 'removed-file-0.1.0',
        manifestOverrides: { hooks: {}, name: 'removed-file', namespace: 'flowtest' },
        outDir: tmpDir,
      });
      // v0.2.0: drop CLAUDE.md from the shard. After install of v0.1.0
      // the user has CLAUDE.md; if they edit it, the engine asks
      // whether to keep or delete (ownership='modified' → prompted).
      const v02 = await buildCustomTarball({
        version: '0.2.0',
        prefix: 'removed-file-0.2.0',
        manifestOverrides: { hooks: {}, name: 'removed-file', namespace: 'flowtest' },
        outDir: tmpDir,
        mutate: async (work) => {
          await fs.rm(path.join(work, 'CLAUDE.md'), { force: true });
        },
      });
      stub.setVersion(REMOVED_FILE_SLUG, '0.1.0', v01);
      stub.setLatest(REMOVED_FILE_SLUG, '0.1.0');
      const vault = await createInstalledVault({
        stub,
        shardRef: REMOVED_FILE_REF,
        values: DEFAULT_VALUES,
        prefix: 's17-removed-file',
      });
      try {
        // User edits CLAUDE.md — makes it modified, qualifying it for
        // the removed-files review (managed-but-untouched paths
        // auto-delete silently).
        const claude = await vault.readFile('CLAUDE.md');
        await vault.writeFile('CLAUDE.md', claude + '\nUser edit on CLAUDE.\n');

        stub.setVersion(REMOVED_FILE_SLUG, '0.2.0', v02);
        stub.setLatest(REMOVED_FILE_SLUG, '0.2.0');

        const r = mountUpdate({ vaultRoot: vault.root });
        await waitFor(
          r.lastFrame,
          (f) => f.includes('Removed by new shard'),
          20_000,
        );
        // First option is "Keep my edits (untrack)" — ENTER accepts.
        r.stdin.write(ENTER);
        await waitFor(r.lastFrame, (f) => /Updated 0\.1\.0 → 0\.2\.0/.test(f), 30_000);
        // CLAUDE.md still on disk (user kept it).
        const claudeAfter = await vault.readFile('CLAUDE.md');
        expect(claudeAfter).toContain('User edit on CLAUDE');
      } finally {
        await vault.cleanup();
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }, 120_000);
});

// Helpers local to this file ───────────────────────────────────────

function minimalShardSchemaWithExtraRequired(): object {
  // Schema mirrors examples/minimal-shard/.shardmind/shard-schema.yaml
  // but adds a new REQUIRED value (`project_id`) without a literal
  // default in the migration list. The migration framework's `added`
  // step would normally fill this in via `migrations:`; omitting a
  // matching migration steers the engine into the NewValuesPrompt
  // path that scenario 16 exercises.
  return {
    schema_version: 1,
    values: {
      user_name: { type: 'string', required: true, message: 'Your name', default: '', group: 'setup' },
      org_name: { type: 'string', message: "Organization (or 'Independent')", default: 'Independent', group: 'setup' },
      vault_purpose: {
        type: 'select',
        required: true,
        message: 'How will you use this vault?',
        options: [
          { value: 'engineering', label: 'Engineering' },
          { value: 'research', label: 'Research' },
          { value: 'general', label: 'General' },
        ],
        default: 'engineering',
        group: 'setup',
      },
      qmd_enabled: { type: 'boolean', message: 'Enable QMD semantic search?', default: false, group: 'setup' },
      project_id: {
        type: 'string',
        required: true,
        message: 'Project ID',
        default: 'PROJ-AUTO',
        group: 'setup',
      },
    },
    groups: [{ id: 'setup', label: 'Quick Setup' }],
    modules: {
      brain: { label: 'Goals, memories, patterns', paths: ['brain/'], removable: false },
      extras: { label: 'Extras', paths: ['extras/'], removable: true },
    },
    signals: [],
    frontmatter: {},
    migrations: [],
  };
}
