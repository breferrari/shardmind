/**
 * Fixture-driven merge engine tests (TDD for drift.ts + differ.ts).
 *
 * Each directory under tests/fixtures/merge/ defines one scenario via
 * scenario.yaml. The runner auto-discovers every fixture and exercises
 * computeMergeAction against it. These tests intentionally fail until
 * source/core/differ.ts is implemented — that is the TDD contract for
 * milestone 3 (issue #10).
 *
 * scenario.yaml fields consumed here:
 *   - name                        human-readable title (used as test name)
 *   - expected_action             one of:
 *                                   skip | overwrite | auto_merge | conflict
 *                                   create | prompt_delete | prompt_delete_module
 *                                 (the last three are orchestration-level
 *                                 actions; they will require the runner or
 *                                 MergeAction union to be extended when
 *                                 those pipelines land.)
 *   - expected_conflict_count     (optional) assert on conflict region count
 *   - ownership_before            managed | modified | volatile | null
 *   - volatile / new_file /
 *     removed / module_change     (optional) scenario flags for dispatch
 *   - values.old / values.new     inputs fed to the renderer inside
 *                                 computeMergeAction
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, it, expect } from 'vitest';

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
  values: { old: Record<string, unknown>; new: Record<string, unknown> };
}

interface FixtureFiles {
  oldTemplate: string;
  newTemplate: string;
  actualContent: string;
  expectedOutput: string | null;
}

const fixtureDirs = fs
  .readdirSync(FIXTURES)
  .filter(name => fs.statSync(path.join(FIXTURES, name)).isDirectory())
  .sort();

function loadScenario(dir: string): Scenario {
  const raw = fs.readFileSync(path.join(FIXTURES, dir, 'scenario.yaml'), 'utf-8');
  return parseYaml(raw) as Scenario;
}

async function loadFiles(dir: string): Promise<FixtureFiles> {
  const base = path.join(FIXTURES, dir);
  const [oldTemplate, newTemplate, actualContent] = await Promise.all([
    fsp.readFile(path.join(base, 'old-template.md.njk'), 'utf-8'),
    fsp.readFile(path.join(base, 'new-template.md.njk'), 'utf-8'),
    fsp.readFile(path.join(base, 'actual-file.md'), 'utf-8'),
  ]);

  let expectedOutput: string | null = null;
  try {
    expectedOutput = await fsp.readFile(path.join(base, 'expected-output.md'), 'utf-8');
  } catch {
    // Some scenarios (e.g. conflicts) deliberately omit expected-output.md
    // because the merge markers depend on implementation details.
  }

  return { oldTemplate, newTemplate, actualContent, expectedOutput };
}

/**
 * Collapse scenario flags into the MergeAction ownership input. The Day 3
 * implementation will likely promote 'volatile' / 'absent' into a richer
 * ownership union; for now we pass through so tests express intent.
 */
function ownershipForMergeInput(scenario: Scenario): 'managed' | 'modified' {
  if (scenario.ownership_before === 'modified') return 'modified';
  return 'managed';
}

describe('merge engine (fixture-driven)', () => {
  it('discovers all 17 scenarios', () => {
    expect(fixtureDirs).toHaveLength(17);
  });

  for (const dir of fixtureDirs) {
    const scenario = loadScenario(dir);

    it(`${dir}: ${scenario.name}`, async () => {
      // Dynamic import so each scenario fails independently until
      // source/core/differ.ts lands. Vitest reports per-test failures
      // rather than a single file-load error.
      const { computeMergeAction } = await import('../../source/core/differ.js');

      const files = await loadFiles(dir);

      const renderContext = {
        values: scenario.values.new,
        included_modules: scenario.module ? [scenario.module] : [],
        shard: { name: 'test-shard', version: '0.1.0' },
        install_date: '2026-04-01',
        year: '2026',
      };

      const action = await computeMergeAction({
        path: `${dir}.md`,
        ownership: ownershipForMergeInput(scenario),
        oldTemplate: files.oldTemplate,
        newTemplate: files.newTemplate,
        oldValues: scenario.values.old,
        newValues: scenario.values.new,
        actualContent: files.actualContent,
        renderContext,
      });

      expect(action.type).toBe(scenario.expected_action);

      if (
        files.expectedOutput !== null &&
        (action.type === 'overwrite' || action.type === 'auto_merge')
      ) {
        expect((action as { content: string }).content).toBe(files.expectedOutput);
      }

      if (action.type === 'conflict' && scenario.expected_conflict_count !== undefined) {
        const result = (action as { result: { conflicts: unknown[] } }).result;
        expect(result.conflicts).toHaveLength(scenario.expected_conflict_count);
      }
    });
  }
});
