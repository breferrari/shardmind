/**
 * v6 contract acceptance — integration sibling of
 * `tests/e2e/obsidian-mind-contract.test.ts`.
 *
 * Holds scenarios that bypass the wizard because the CLI exposes no
 * non-interactive `--modules` flag for module deselection. The
 * behavioral contract — files at deselected module paths are not
 * installed; agent gating is module gating — is engine-level and is
 * exercised here through `runInstall(...)` directly.
 *
 * Scope:
 *   - Scenario 3: Claude-only agent install (deselect codex + gemini).
 *   - Scenario 4: deselect `perf` module.
 *   - Scenario 5: combined custom values + Claude-only + deselect `perf`.
 *
 * The E2E sibling covers everything else from the #92 matrix.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { parseManifest } from '../../source/core/manifest.js';
import {
  parseSchema,
  buildValuesValidator,
} from '../../source/core/schema.js';
import { readState } from '../../source/core/state.js';
import {
  defaultModuleSelections,
  resolveComputedDefaults,
} from '../../source/core/install-planner.js';
import { runInstall } from '../../source/core/install-executor.js';
import type { ResolvedShard, ShardState } from '../../source/runtime/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_DIR = path.resolve(
  __dirname,
  '../fixtures/shards/obsidian-mind-like',
);

const RESOLVED: ResolvedShard = {
  namespace: 'acme',
  name: 'obs-mind-like',
  version: '6.0.0',
  source: 'github:acme/obs-mind-like',
  tarballUrl: 'n/a (local fixture)',
};

const CUSTOM_VALUES = {
  user_name: 'Alice',
  org_name: 'Acme Labs',
  vault_purpose: 'engineering' as const,
  qmd_enabled: true,
  brain_capacity: 100,
};

describe('install (obsidian-mind-like) — module deselection', () => {
  let vault: string;

  beforeEach(async () => {
    vault = path.join(os.tmpdir(), `shardmind-obs-mind-int-${crypto.randomUUID()}`);
    await fsp.mkdir(vault, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(vault, { recursive: true, force: true });
  });

  it('Claude-only install drops AGENTS.md / GEMINI.md / .codex / .gemini from the vault', async () => {
    // Scenario 3 — docs/SHARD-LAYOUT.md §Personalization model:
    // "Agent selection is modeled as module gating." Excluding the
    // `codex` + `gemini` modules removes their declared paths
    // (AGENTS.md, GEMINI.md, .codex/, .gemini/) from the install.
    const manifest = await parseManifest(
      path.join(FIXTURE_DIR, '.shardmind', 'shard.yaml'),
    );
    const schema = await parseSchema(
      path.join(FIXTURE_DIR, '.shardmind', 'shard-schema.yaml'),
    );

    const selections = defaultModuleSelections(schema);
    selections['codex'] = 'excluded';
    selections['gemini'] = 'excluded';

    const validator = buildValuesValidator(schema);
    const values = validator.parse(resolveComputedDefaults(schema, CUSTOM_VALUES));

    await runInstall({
      vaultRoot: vault,
      manifest,
      schema,
      tempDir: FIXTURE_DIR,
      resolved: RESOLVED,
      tarballSha256: 'deadbeef',
      values,
      selections,
    });

    // Claude-side present.
    await expect(fsp.access(path.join(vault, 'CLAUDE.md'))).resolves.toBeUndefined();
    await expect(
      fsp.access(path.join(vault, '.claude/settings.json')),
    ).resolves.toBeUndefined();

    // Codex + Gemini absent.
    await expect(fsp.access(path.join(vault, 'AGENTS.md'))).rejects.toThrow();
    await expect(fsp.access(path.join(vault, 'GEMINI.md'))).rejects.toThrow();
    await expect(fsp.access(path.join(vault, '.codex'))).rejects.toThrow();
    await expect(fsp.access(path.join(vault, '.gemini'))).rejects.toThrow();

    const state = (await readState(vault)) as ShardState;
    expect(state.modules['codex']).toBe('excluded');
    expect(state.modules['gemini']).toBe('excluded');
    expect(state.modules['claude']).toBe('included');
  });

  it('deselecting `perf` keeps the rest of the vault intact (CLAUDE.md verbatim, brain/ + work/ present)', async () => {
    // Scenario 4 — docs/SHARD-LAYOUT.md §Values, schema, and modules:
    // "Module deselection = file-path gating, not section pruning.
    // Files under deselected module paths don't install. CLAUDE.md /
    // AGENTS.md / GEMINI.md stay whole." Pin both halves of that rule:
    // perf/ files don't install; CLAUDE.md is byte-equivalent to the
    // shard source.
    const manifest = await parseManifest(
      path.join(FIXTURE_DIR, '.shardmind', 'shard.yaml'),
    );
    const schema = await parseSchema(
      path.join(FIXTURE_DIR, '.shardmind', 'shard-schema.yaml'),
    );

    const selections = defaultModuleSelections(schema);
    selections['perf'] = 'excluded';

    const validator = buildValuesValidator(schema);
    const values = validator.parse(resolveComputedDefaults(schema, CUSTOM_VALUES));

    await runInstall({
      vaultRoot: vault,
      manifest,
      schema,
      tempDir: FIXTURE_DIR,
      resolved: RESOLVED,
      tarballSha256: 'deadbeef',
      values,
      selections,
    });

    // perf/ folder gone.
    await expect(fsp.access(path.join(vault, 'perf'))).rejects.toThrow();

    // brain/ + work/ still present (brain is non-removable; work is
    // removable but not deselected here).
    await expect(
      fsp.access(path.join(vault, 'brain', 'North Star.md')),
    ).resolves.toBeUndefined();
    await expect(
      fsp.access(path.join(vault, 'work', 'README.md')),
    ).resolves.toBeUndefined();

    // CLAUDE.md is verbatim — no section pruning happens just because
    // perf/ is deselected. Compare to the source byte-for-byte.
    const installed = await fsp.readFile(path.join(vault, 'CLAUDE.md'));
    const source = await fsp.readFile(path.join(FIXTURE_DIR, 'CLAUDE.md'));
    expect(installed.equals(source)).toBe(true);
  });

  it('combined gating (custom values + Claude-only + deselect perf) installs only the expected modules', async () => {
    // Scenario 5 — combined gating. Tests that multi-module
    // deselection across both vault content (perf) and agents
    // (codex + gemini) compose without interference.
    const manifest = await parseManifest(
      path.join(FIXTURE_DIR, '.shardmind', 'shard.yaml'),
    );
    const schema = await parseSchema(
      path.join(FIXTURE_DIR, '.shardmind', 'shard-schema.yaml'),
    );

    const selections = defaultModuleSelections(schema);
    selections['codex'] = 'excluded';
    selections['gemini'] = 'excluded';
    selections['perf'] = 'excluded';

    const validator = buildValuesValidator(schema);
    const values = validator.parse(resolveComputedDefaults(schema, CUSTOM_VALUES));

    await runInstall({
      vaultRoot: vault,
      manifest,
      schema,
      tempDir: FIXTURE_DIR,
      resolved: RESOLVED,
      tarballSha256: 'deadbeef',
      values,
      selections,
    });

    // Excluded.
    for (const rel of ['AGENTS.md', 'GEMINI.md', '.codex', '.gemini', 'perf']) {
      await expect(fsp.access(path.join(vault, rel))).rejects.toThrow();
    }

    // Included.
    for (const rel of [
      'CLAUDE.md',
      '.claude/settings.json',
      'brain/North Star.md',
      'work/README.md',
      'Home.md',
      '.mcp.json',
    ]) {
      await expect(fsp.access(path.join(vault, rel))).resolves.toBeUndefined();
    }

    const state = (await readState(vault)) as ShardState;
    expect(state.modules).toMatchObject({
      brain: 'included',
      work: 'included',
      perf: 'excluded',
      claude: 'included',
      codex: 'excluded',
      gemini: 'excluded',
    });

    // Custom values flowed into the dotfolder render.
    const settings = JSON.parse(
      await fsp.readFile(path.join(vault, '.claude/settings.json'), 'utf-8'),
    );
    expect(settings).toMatchObject({ user: 'Alice', org: 'Acme Labs' });
  });
});
