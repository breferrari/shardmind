/**
 * Fixture-driven merge engine tests (drift.ts + differ.ts).
 *
 * Each directory under tests/fixtures/merge/ defines one scenario via
 * scenario.yaml + 6 companion files. The runner auto-discovers every
 * fixture and dispatches to the right code path based on scenario flags.
 *
 * On-disk layout per fixture:
 *   scenario.yaml            metadata only — flags + expected_action
 *   old-template.md.njk      template shipped by the previous shard version
 *   new-template.md.njk      template shipped by the new shard version
 *   old-values.yaml          values used when rendering the old template
 *   new-values.yaml          values used when rendering the new template
 *   actual-file.md           file currently on disk (theirs)
 *   expected-output.md       expected post-merge file content
 *                            (absent for scenarios where the exact content
 *                            depends on implementation — e.g. conflict
 *                            markers)
 *
 * Dispatch map:
 *   - Scenarios 01–09, 12, 16  → computeMergeAction (skip / overwrite /
 *                                  auto_merge / conflict)
 *   - Scenario 17              → volatile — detectDrift classification only
 *   - Scenarios 10, 13, 15     → new_file — render new template, assert create
 *   - Scenarios 11, 14         → removed — assert prompt_delete[_module]
 *
 * The create / prompt_delete / prompt_delete_module / volatile-skip actions
 * are orchestration-level (the update command's planner) and don't live in
 * the MergeAction union in IMPLEMENTATION.md §4.9 — dispatch here, not in
 * differ.ts.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { describe, it, expect } from 'vitest';
import { detectDrift } from '../../source/core/drift.js';
import { computeMergeAction } from '../../source/core/differ.js';
import { renderString } from '../../source/core/renderer.js';
import { assertNever } from '../../source/runtime/types.js';
import type { RenderContext } from '../../source/runtime/types.js';
import { makeStateWithFiles } from '../helpers/index.js';

const FIXTURES = path.resolve('tests/fixtures/merge');

type OwnershipBefore = 'managed' | 'modified' | 'volatile' | null | undefined;

interface Scenario {
  name: string;
  description?: string;
  ownership_before?: OwnershipBefore;
  user_edited?: boolean;
  template_changed?: boolean;
  values_changed?: boolean;
  conflict_expected?: boolean;
  expected_action: string;
  expected_conflict_count?: number;
  volatile?: boolean;
  new_file?: boolean;
  removed?: boolean;
  frontmatter_only?: boolean;
  each_iterator_add?: boolean;
  iterator_key?: string;
  new_item_slug?: string;
  partial_update?: boolean;
  module_change?: 'newly_included' | 'newly_excluded';
  module?: string;
}

interface FixtureFiles {
  oldTemplate: string;
  newTemplate: string;
  oldValues: Record<string, unknown>;
  newValues: Record<string, unknown>;
  actualContent: string;
  expectedOutput: string | null;
}

type ScenarioKind = 'volatile' | 'new_file' | 'removed' | 'standard';

function classifyScenario(s: Scenario): ScenarioKind {
  if (s.volatile) return 'volatile';
  if (s.new_file) return 'new_file';
  if (s.removed) return 'removed';
  return 'standard';
}

const fixtureDirs = fs
  .readdirSync(FIXTURES)
  .filter(name => fs.statSync(path.join(FIXTURES, name)).isDirectory())
  .sort();

async function loadScenario(dir: string): Promise<Scenario> {
  const raw = await fsp.readFile(path.join(FIXTURES, dir, 'scenario.yaml'), 'utf-8');
  return parseYaml(raw) as Scenario;
}

async function loadFiles(dir: string): Promise<FixtureFiles> {
  const base = path.join(FIXTURES, dir);
  const [oldTemplate, newTemplate, oldValuesRaw, newValuesRaw, actualContent] = await Promise.all([
    fsp.readFile(path.join(base, 'old-template.md.njk'), 'utf-8'),
    fsp.readFile(path.join(base, 'new-template.md.njk'), 'utf-8'),
    fsp.readFile(path.join(base, 'old-values.yaml'), 'utf-8'),
    fsp.readFile(path.join(base, 'new-values.yaml'), 'utf-8'),
    fsp.readFile(path.join(base, 'actual-file.md'), 'utf-8'),
  ]);

  // expected-output.md is optional — conflict scenarios omit it because
  // the marker format is implementation-defined.
  let expectedOutput: string | null = null;
  try {
    expectedOutput = await fsp.readFile(path.join(base, 'expected-output.md'), 'utf-8');
  } catch {
    /* no-op */
  }

  return {
    oldTemplate,
    newTemplate,
    oldValues: (parseYaml(oldValuesRaw) ?? {}) as Record<string, unknown>,
    newValues: (parseYaml(newValuesRaw) ?? {}) as Record<string, unknown>,
    actualContent,
    expectedOutput,
  };
}

/**
 * Runtime ownership is derived from drift hashing (detectDrift), not from
 * the fixture's authored `ownership_before`. If `user_edited` is true, the
 * actual file's hash differs from `rendered_hash`, and drift classifies the
 * file as `modified` regardless of what `ownership_before` says. Scenario
 * 07 relies on this — it declares `ownership_before: managed` with
 * `user_edited: true` to model "file was managed until the user just
 * edited it" and expects a conflict.
 */
function ownershipForMergeInput(scenario: Scenario): 'managed' | 'modified' {
  if (scenario.ownership_before === 'modified' || scenario.user_edited) return 'modified';
  return 'managed';
}

function makeRenderContext(scenario: Scenario): RenderContext {
  return {
    values: {},
    included_modules: scenario.module ? [scenario.module] : [],
    shard: { name: 'test-shard', version: '0.1.0' },
    install_date: '2026-04-01',
    year: '2026',
  };
}

describe('merge engine (fixture-driven)', () => {
  it('discovers all 17 scenarios', () => {
    expect(fixtureDirs).toHaveLength(17);
  });

  for (const dir of fixtureDirs) {
    // Scenario loaded inside the test body so a malformed scenario.yaml
    // fails only that scenario, not the whole file at collection time.
    it(dir, async () => {
      const scenario = await loadScenario(dir);
      const files = await loadFiles(dir);
      const kind = classifyScenario(scenario);

      switch (kind) {
        case 'volatile':
          return assertVolatile(dir, scenario, files);
        case 'new_file':
          return assertNewFile(dir, scenario, files);
        case 'removed':
          return assertRemoved(scenario, files);
        case 'standard':
          return assertStandardMerge(dir, scenario, files);
        default:
          assertNever(kind);
      }
    });
  }
});

async function assertVolatile(dir: string, scenario: Scenario, files: FixtureFiles): Promise<void> {
  expect(scenario.expected_action).toBe('skip');
  const report = await buildVolatileDriftReport(dir, files.actualContent);
  expect(report.volatile).toHaveLength(1);
  expect(report.volatile[0]?.path).toBe(`${dir}.md`);
}

function assertNewFile(dir: string, scenario: Scenario, files: FixtureFiles): void {
  expect(scenario.expected_action).toBe('create');
  const renderContext = makeRenderContext(scenario);
  const iteratorExtras = scenario.each_iterator_add
    ? extractIteratorItem(files.newValues, scenario)
    : {};
  const rendered = renderString(
    files.newTemplate,
    { ...renderContext, values: { ...files.newValues, ...iteratorExtras } },
    `${dir}.md`,
  );
  if (files.expectedOutput !== null) {
    expect(rendered).toBe(files.expectedOutput);
  }
}

function assertRemoved(scenario: Scenario, files: FixtureFiles): void {
  const expected =
    scenario.module_change === 'newly_excluded' ? 'prompt_delete_module' : 'prompt_delete';
  expect(scenario.expected_action).toBe(expected);
  expect(files.newTemplate.trim()).toBe('');
}

async function assertStandardMerge(
  dir: string,
  scenario: Scenario,
  files: FixtureFiles,
): Promise<void> {
  const action = await computeMergeAction({
    path: `${dir}.md`,
    ownership: ownershipForMergeInput(scenario),
    oldTemplate: files.oldTemplate,
    newTemplate: files.newTemplate,
    oldValues: files.oldValues,
    newValues: files.newValues,
    actualContent: files.actualContent,
    renderContext: makeRenderContext(scenario),
  });

  expect(action.type).toBe(scenario.expected_action);

  if (
    files.expectedOutput !== null &&
    (action.type === 'overwrite' || action.type === 'auto_merge')
  ) {
    expect(action.content).toBe(files.expectedOutput);
  }

  if (action.type === 'conflict') {
    expect(action.result.content).toContain('<<<<<<< yours');
    expect(action.result.content).toContain('=======');
    expect(action.result.content).toContain('>>>>>>> shard update');
    if (scenario.expected_conflict_count !== undefined) {
      expect(action.result.conflicts).toHaveLength(scenario.expected_conflict_count);
    }
  }
}

/**
 * Build a minimal vault on disk with one volatile file and run detectDrift
 * against it. Verifies that drift reports a volatile entry without attempting
 * to hash-compare the content — the gate that makes the update command skip
 * volatile files.
 */
async function buildVolatileDriftReport(dir: string, actualContent: string) {
  const vaultRoot = path.join(os.tmpdir(), `drift-volatile-${crypto.randomUUID()}`);
  await fsp.mkdir(vaultRoot, { recursive: true });
  try {
    const relPath = `${dir}.md`;
    await fsp.writeFile(path.join(vaultRoot, relPath), actualContent, 'utf-8');

    const state = makeStateWithFiles({
      [relPath]: {
        template: 'templates/volatile.md.njk',
        rendered_hash: 'stale-hash-that-does-not-match-on-purpose',
        ownership: 'user',
      },
    });

    return await detectDrift(vaultRoot, state);
  } finally {
    await fsp.rm(vaultRoot, { recursive: true, force: true });
  }
}

function extractIteratorItem(
  values: Record<string, unknown>,
  scenario: Scenario,
): Record<string, unknown> {
  if (!scenario.iterator_key || !scenario.new_item_slug) return {};
  const list = values[scenario.iterator_key];
  if (!Array.isArray(list)) return {};
  const item = (list as Array<Record<string, unknown>>).find(
    i => i['slug'] === scenario.new_item_slug,
  );
  return item ? { item } : {};
}
