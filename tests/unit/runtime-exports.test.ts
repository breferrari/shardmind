/**
 * `shardmind/runtime`'s public surface, pinned for 1.0 (#358,
 * IMPLEMENTATION §5). Every export is semver-bound after 1.0, so adding or
 * removing a name is a deliberate change here and in the spec, never a side
 * effect. ShardMind serves anyone's shards: nothing here is removed because
 * some shard doesn't use it.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as runtime from '../../source/runtime/index.js';
import { buildValuesValidator as engineValidator } from '../../source/core/schema.js';
import { buildValuesValidator as runtimeValidator } from '../../source/runtime/values-validator.js';
import { ensureBuilt } from '../e2e/helpers/build-once.js';
import type { ShardSchema } from '../../source/runtime/types.js';

const VALUE_EXPORTS = [
  'SHARDMIND_DIR',
  'STATE_FILE',
  'ShardMindError',
  'VALUES_FILE',
  'getIncludedModules',
  'loadSchema',
  'loadState',
  'loadValues',
  'resolveVaultRoot',
  'validateFrontmatter',
  'validateValues',
];

const TYPE_EXPORTS = [
  'BootstrapContext',
  'ErrorCode',
  'FileState',
  'FrontmatterRule',
  'FrontmatterValidationResult',
  'GroupDefinition',
  'HookContextBase',
  'HookSlot',
  'Migration',
  'MigrationChange',
  'ModuleDefinition',
  'ModuleSelections',
  'PersonalizeContext',
  'PostUpdateContext',
  'ShardManifest',
  'ShardSchema',
  'ShardState',
  'SignalDefinition',
  'SlottedHookContext',
  'ValidationResult',
  'ValueDefinition',
];

/** The names in `index.ts`'s `export type { … }` blocks: types leave no trace at runtime. */
function typeExports(): string[] {
  const source = fs.readFileSync(path.join(import.meta.dirname, '../../source/runtime/index.ts'), 'utf-8');
  const names: string[] = [];
  for (const block of source.matchAll(/export type \{([^}]*)\}/g)) {
    for (const line of block[1]!.split('\n')) {
      const code = line.replace(/\/\/.*$/, '');
      for (const name of code.split(',')) {
        const trimmed = name.trim();
        if (trimmed) names.push(trimmed);
      }
    }
  }
  return names.sort();
}

describe('shardmind/runtime exports (#358)', () => {
  it('exports exactly the documented values', () => {
    expect(Object.keys(runtime).sort()).toEqual(VALUE_EXPORTS);
  });

  it('exports exactly the documented types', () => {
    expect(typeExports()).toEqual(TYPE_EXPORTS);
  });

  it('gives the vault paths relative to the vault root', () => {
    expect(runtime.SHARDMIND_DIR).toBe('.shardmind');
    expect(runtime.STATE_FILE).toBe(path.join('.shardmind', 'state.json'));
    expect(runtime.VALUES_FILE).toBe('shard-values.yaml');
  });

  // The published types are what an author's editor sees. A parallel-clean
  // race in the build once wiped this file; a missing or drifting
  // declaration fails here.
  it('ships the same list in dist/runtime/index.d.ts', async () => {
    await ensureBuilt();
    const dts = fs.readFileSync(path.join(import.meta.dirname, '../../dist/runtime/index.d.ts'), 'utf-8');
    const line = /^export \{([^}]*)\};$/m.exec(dts);
    expect(line).not.toBeNull();
    const names = line![1]!.split(',').map((n) => n.trim().replace(/^type /, ''));
    expect(names.sort()).toEqual([...VALUE_EXPORTS, ...TYPE_EXPORTS].sort());
  });
});

describe('validateValues uses the engine validator (#358)', () => {
  const schema = {
    schema_version: 1,
    values: {
      user_name: { type: 'string', message: 'Name?', required: true },
      org_name: { type: 'string', message: 'Org?', default: '{{ user_name }} Labs' },
      qmd_enabled: { type: 'boolean', message: 'QMD?', default: false },
      retention_days: { type: 'number', message: 'Days?', default: 30, min: 1 },
    },
    groups: [],
    modules: {},
    signals: [],
    frontmatter: {},
    migrations: [],
  } as unknown as ShardSchema;

  it('is the same function in the engine and the runtime, so the two cannot drift', () => {
    expect(runtimeValidator).toBe(engineValidator);
  });

  it.each([
    ['all given', { user_name: 'Ada', org_name: 'Ada Labs', qmd_enabled: true, retention_days: 7 }],
    ['a computed default left out', { user_name: 'Ada' }],
    ['a computed default given', { user_name: 'Ada', org_name: 'Other' }],
    ['a wrong type', { user_name: 'Ada', qmd_enabled: 'yes' }],
    ['out of range', { user_name: 'Ada', retention_days: 0 }],
    ['a required key missing', { org_name: 'X' }],
  ])('agrees with the engine on %s', (_label, values) => {
    const engine = engineValidator(schema).safeParse(values);
    const result = runtime.validateValues(values, schema);
    expect(result.valid).toBe(engine.success);
    expect(result.errors.map((e) => e.path)).toEqual(engine.success ? [] : engine.error.issues.map((i) => i.path.join('.')));
  });

  it('leaves a computed default unset rather than applying the template string', () => {
    expect(runtime.validateValues({ user_name: 'Ada' }, schema).valid).toBe(true);
    const parsed = engineValidator(schema).parse({ user_name: 'Ada' }) as Record<string, unknown>;
    expect(parsed['org_name']).toBeUndefined();
  });
});
