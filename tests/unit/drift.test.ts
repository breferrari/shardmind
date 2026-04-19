/**
 * Fixture-driven merge engine tests (TDD for drift.ts + differ.ts).
 *
 * Each directory under tests/fixtures/merge/ defines one scenario via
 * scenario.yaml + 6 companion files. The runner auto-discovers every fixture
 * and exercises computeMergeAction against it. Tests are `it.skip` until
 * source/core/differ.ts lands (#11); unskip then.
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
 * The values YAMLs are the source of truth for render inputs; scenario.yaml
 * does not duplicate them.
 *
 * Scenarios 10, 11, 13, 14, 15, 17 describe orchestration-level behavior
 * (create / prompt_delete / prompt_delete_module / volatile skip). These
 * actions are not in the MergeAction union in IMPLEMENTATION.md §4.9 and the
 * `ownership: 'managed' | 'modified'` input can't carry the distinction.
 * When unskipping, the implementer should dispatch in this runner so those
 * scenarios call the orchestration path (e.g. drift.detectDrift for
 * volatile, or whatever new-file / removed-file plumbing replaces them) and
 * leave computeMergeAction for scenarios 01-09, 12, 16 only.
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
}

interface FixtureFiles {
  oldTemplate: string;
  newTemplate: string;
  oldValues: Record<string, unknown>;
  newValues: Record<string, unknown>;
  actualContent: string;
  expectedOutput: string | null;
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

  let expectedOutput: string | null = null;
  try {
    expectedOutput = await fsp.readFile(path.join(base, 'expected-output.md'), 'utf-8');
  } catch {
    // Some scenarios (e.g. conflicts) deliberately omit expected-output.md
    // because the merge markers depend on implementation details.
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
    // Scenario is loaded inside the test body so a malformed scenario.yaml
    // fails that scenario only, not the whole file at collection time.
    //
    // Skipped until source/core/differ.ts lands (#11). The fixtures and
    // runner body are landed now (per issue #10) so the implementer has a
    // ready target to TDD against — unskip then, not before.
    it.skip(dir, async () => {
      const scenario = await loadScenario(dir);
      const { computeMergeAction } = await import('../../source/core/differ.js');

      const files = await loadFiles(dir);

      const renderContext = {
        values: files.newValues,
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
        oldValues: files.oldValues,
        newValues: files.newValues,
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
