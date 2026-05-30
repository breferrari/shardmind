import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { parseSchema, buildValuesValidator, isComputedDefault } from '../../source/core/schema.js';

const FIXTURES = path.resolve('tests/fixtures/schema');
const EXAMPLE_SCHEMA = path.resolve('examples/minimal-shard/.shardmind/shard-schema.yaml');

// Unique tmp filename per call. `Date.now()` collides under parallel
// vitest workers (two tests within the same millisecond share a path,
// and the second `unlink` throws ENOENT after the first cleans up).
const tmpYaml = (prefix: string): string =>
  path.join(os.tmpdir(), `${prefix}-${crypto.randomUUID()}.yaml`);

describe('parseSchema', () => {
  it('parses valid-minimal fixture', async () => {
    const schema = await parseSchema(path.join(FIXTURES, 'valid-minimal.yaml'));
    expect(schema.schema_version).toBe(1);
    expect(Object.keys(schema.values)).toEqual(['user_name']);
    expect(schema.values['user_name']!.type).toBe('string');
    expect(schema.values['user_name']!.required).toBe(true);
    expect(schema.groups).toHaveLength(1);
    expect(schema.groups[0]!.id).toBe('setup');
  });

  it('parses examples/minimal-shard/shard-schema.yaml with all sections', async () => {
    const schema = await parseSchema(EXAMPLE_SCHEMA);
    expect(schema.schema_version).toBe(1);
    expect(Object.keys(schema.values)).toHaveLength(4);
    expect(schema.values['vault_purpose']!.type).toBe('select');
    expect(schema.values['vault_purpose']!.options).toHaveLength(3);
    expect(schema.values['qmd_enabled']!.type).toBe('boolean');
    expect(schema.values['qmd_enabled']!.default).toBe(false);
    expect(Object.keys(schema.modules)).toContain('brain');
    expect(schema.modules['brain']!.removable).toBe(false);
    expect(schema.modules['extras']!.removable).toBe(true);
    expect(schema.signals).toHaveLength(2);
    expect(schema.migrations).toEqual([]);
  });

  it('normalizes frontmatter shorthand arrays to FrontmatterRule objects', async () => {
    const schema = await parseSchema(EXAMPLE_SCHEMA);
    expect(schema.frontmatter['global']).toEqual({ required: ['date', 'description', 'tags'] });
    expect(schema.frontmatter['brain-note']).toEqual({
      required: ['date', 'description'],
      path_match: 'brain/*.md',
    });
  });

  it('parses valid-all-types fixture with all 6 value types', async () => {
    const schema = await parseSchema(path.join(FIXTURES, 'valid-all-types.yaml'));
    expect(schema.values['user_name']!.type).toBe('string');
    expect(schema.values['dark_mode']!.type).toBe('boolean');
    expect(schema.values['max_notes']!.type).toBe('number');
    expect(schema.values['max_notes']!.min).toBe(1);
    expect(schema.values['max_notes']!.max).toBe(100);
    expect(schema.values['vault_purpose']!.type).toBe('select');
    expect(schema.values['plugins']!.type).toBe('multiselect');
    expect(schema.values['tags']!.type).toBe('list');
  });

  it('rejects non-existent file', async () => {
    const err = await parseSchema('/no/such/schema.yaml').catch(e => e);
    expect(err.code).toBe('SCHEMA_NOT_FOUND');
  });

  it('rejects invalid YAML syntax', async () => {
    const fs = await import('node:fs/promises');
    const tmp = tmpYaml('schema-test');
    await fs.writeFile(tmp, ':\n  - [\ninvalid');
    try {
      const err = await parseSchema(tmp).catch(e => e);
      expect(err.code).toBe('SCHEMA_INVALID_YAML');
    } finally {
      await fs.unlink(tmp);
    }
  });

  it('rejects missing group reference', async () => {
    const err = await parseSchema(path.join(FIXTURES, 'invalid-missing-group.yaml')).catch(e => e);
    expect(err.code).toBe('SCHEMA_VALIDATION_FAILED');
    expect(err.message).toContain('nonexistent_group');
  });

  it('rejects bad structure (missing schema_version)', async () => {
    const err = await parseSchema(path.join(FIXTURES, 'invalid-bad-structure.yaml')).catch(e => e);
    expect(err.code).toBe('SCHEMA_VALIDATION_FAILED');
  });

  it('rejects schema value keys that collide with render context (reserved names)', async () => {
    const err = await parseSchema(path.join(FIXTURES, 'invalid-reserved-name.yaml')).catch(e => e);
    expect(err.code).toBe('SCHEMA_RESERVED_NAME');
    expect(err.message).toContain('shard');
  });

  it('rejects select value definitions with missing options (.check rule)', async () => {
    const err = await parseSchema(path.join(FIXTURES, 'invalid-select-no-options.yaml')).catch(e => e);
    expect(err.code).toBe('SCHEMA_VALIDATION_FAILED');
    expect(err.message).toContain('options');
  });

  it('rejects number value definitions where min > max (.check rule)', async () => {
    const err = await parseSchema(path.join(FIXTURES, 'invalid-min-gt-max.yaml')).catch(e => e);
    expect(err.code).toBe('SCHEMA_VALIDATION_FAILED');
    expect(err.message).toContain('min');
  });

  it('rejects literal `default` whose type does not match the value type', async () => {
    const err = await parseSchema(path.join(FIXTURES, 'invalid-default-type-mismatch.yaml')).catch(e => e);
    expect(err.code).toBe('SCHEMA_VALIDATION_FAILED');
    expect(err.message).toContain('default');
    expect(err.message).toContain('number');
  });

  it('rejects select `default` not present in `options[].value`', async () => {
    const err = await parseSchema(path.join(FIXTURES, 'invalid-select-default-not-in-options.yaml')).catch(e => e);
    expect(err.code).toBe('SCHEMA_VALIDATION_FAILED');
    expect(err.message).toContain('default');
    expect(err.message).toContain('options');
    expect(err.message).toContain('purple');
  });

  it('rejects multiselect `default` containing values not in `options[].value`', async () => {
    const err = await parseSchema(path.join(FIXTURES, 'invalid-multiselect-default-not-in-options.yaml')).catch(e => e);
    expect(err.code).toBe('SCHEMA_VALIDATION_FAILED');
    expect(err.message).toContain('default');
    expect(err.message).toContain('nonexistent');
  });

  it('synthesizes a multiselect default from per-option `default: true` and strips the booleans', async () => {
    const schema = await parseSchema(path.join(FIXTURES, 'valid-multiselect-per-option-default.yaml'));
    const agents = schema.values['agents']!;
    expect(agents.type).toBe('multiselect');
    expect(agents.default).toEqual(['claude']);
    expect(agents.min).toBe(1);
    // Per-option `default` is authoring sugar — it must not survive into the
    // normalized (and therefore cached) schema, so re-parse never sees both
    // a per-option and a top-level default.
    for (const opt of agents.options ?? []) {
      expect('default' in opt).toBe(false);
    }
  });

  it('defaults a multiselect with no per-option and no top-level default to []', async () => {
    const schema = await parseSchema(path.join(FIXTURES, 'valid-multiselect-per-option-default.yaml'));
    expect(schema.values['themes']!.default).toEqual([]);
  });

  it('is idempotent: re-parsing a normalized (top-level-array) multiselect keeps its default', async () => {
    // valid-all-types.yaml's `plugins` uses the canonical top-level `default: []`.
    // Round-tripping it (the shape cacheManifest writes) must not error or drift.
    const schema = await parseSchema(path.join(FIXTURES, 'valid-all-types.yaml'));
    expect(schema.values['plugins']!.default).toEqual([]);
  });

  it('rejects a multiselect that declares both per-option and top-level defaults', async () => {
    const err = await parseSchema(path.join(FIXTURES, 'invalid-multiselect-both-defaults.yaml')).catch(e => e);
    expect(err.code).toBe('SCHEMA_VALIDATION_FAILED');
    expect(err.message).toContain('agents');
    expect(err.message).toContain('default');
  });

  it('rejects per-option `default` on a non-multiselect (select) option', async () => {
    const err = await parseSchema(path.join(FIXTURES, 'invalid-per-option-default-on-select.yaml')).catch(e => e);
    expect(err.code).toBe('SCHEMA_VALIDATION_FAILED');
    expect(err.message).toContain('color');
    expect(err.hint).toContain('multiselect');
  });

  it('rejects values missing the required `default` field', async () => {
    const err = await parseSchema(path.join(FIXTURES, 'invalid-missing-default.yaml')).catch(e => e);
    expect(err.code).toBe('SCHEMA_VALIDATION_FAILED');
    expect(err.message).toContain('user_name');
    expect(err.message).toContain('default');
    expect(err.hint).toContain('Every value must declare a `default`');
  });

  it('reports every value missing `default` (not just the first)', async () => {
    const err = await parseSchema(path.join(FIXTURES, 'invalid-multiple-missing-defaults.yaml')).catch(e => e);
    expect(err.code).toBe('SCHEMA_VALIDATION_FAILED');
    expect(err.message).toContain('alpha');
    expect(err.message).toContain('beta');
    expect(err.message).not.toContain('gamma');
  });

  it('silently ignores the dead `partials` field on modules (v5 → v6 tolerance)', async () => {
    const schema = await parseSchema(path.join(FIXTURES, 'valid-partials-tolerated.yaml'));
    const mod = schema.modules['legacy_mod']!;
    expect(mod.label).toBe('Has v5 partials field');
    expect(mod.paths).toEqual(['legacy/']);
    expect('partials' in mod).toBe(false);
  });

  it('accepts type-matching empty/falsey literal defaults ("", false, 0, [])', async () => {
    const schema = await parseSchema(path.join(FIXTURES, 'valid-sentinel-defaults.yaml'));
    expect(Object.keys(schema.values)).toHaveLength(4);
    expect(schema.values['empty_string_default']!.default).toBe('');
    expect(schema.values['false_default']!.default).toBe(false);
    expect(schema.values['zero_default']!.default).toBe(0);
    expect(schema.values['empty_list_default']!.default).toEqual([]);
  });

  it('rejects literal `default: null` — null does not match any value type', async () => {
    const err = await parseSchema(path.join(FIXTURES, 'invalid-default-null.yaml')).catch(e => e);
    expect(err.code).toBe('SCHEMA_VALIDATION_FAILED');
    expect(err.message).toContain('default');
    expect(err.message).toContain('string');
  });

  it('reports every reserved-name collision when multiple', async () => {
    const fs = await import('node:fs/promises');
    const tmp = tmpYaml('schema-reserved');
    await fs.writeFile(tmp, [
      'schema_version: 1',
      'values:',
      '  shard:',
      '    type: string',
      '    required: true',
      '    message: "x"',
      '    group: setup',
      '  install_date:',
      '    type: string',
      '    required: true',
      '    message: "y"',
      '    group: setup',
      'groups:',
      '  - { id: setup, label: "Setup" }',
      'modules: {}',
      'signals: []',
      'frontmatter: {}',
      'migrations: []',
      '',
    ].join('\n'));

    try {
      const err = await parseSchema(tmp).catch(e => e);
      expect(err.code).toBe('SCHEMA_RESERVED_NAME');
      expect(err.message).toContain('shard');
      expect(err.message).toContain('install_date');
    } finally {
      await fs.unlink(tmp);
    }
  });

  it('exposes the full reserved-name list in the hint so authors can self-serve', async () => {
    const err = await parseSchema(path.join(FIXTURES, 'invalid-reserved-name.yaml')).catch(e => e);
    expect(err.hint).toContain('shard');
    expect(err.hint).toContain('install_date');
    expect(err.hint).toContain('year');
    expect(err.hint).toContain('included_modules');
    expect(err.hint).toContain('values');
  });
});

describe('buildValuesValidator', () => {
  it('generates correct validators for all 6 types', async () => {
    const schema = await parseSchema(path.join(FIXTURES, 'valid-all-types.yaml'));
    const validator = buildValuesValidator(schema);

    const valid = validator.parse({
      user_name: 'Alice',
      dark_mode: true,
      max_notes: 50,
      vault_purpose: 'engineering',
      plugins: ['dataview', 'templater'],
      tags: ['notes'],
    });
    expect(valid.user_name).toBe('Alice');
    expect(valid.dark_mode).toBe(true);
    expect(valid.max_notes).toBe(50);
    expect(valid.vault_purpose).toBe('engineering');
    expect(valid.plugins).toEqual(['dataview', 'templater']);
    expect(valid.tags).toEqual(['notes']);
  });

  it('enforces min/max on number type', async () => {
    const schema = await parseSchema(path.join(FIXTURES, 'valid-all-types.yaml'));
    const validator = buildValuesValidator(schema);

    expect(() => validator.parse({ user_name: 'A', vault_purpose: 'engineering', max_notes: 0 })).toThrow();
    expect(() => validator.parse({ user_name: 'A', vault_purpose: 'engineering', max_notes: 101 })).toThrow();
  });

  it('enforces min/max array length on multiselect type', async () => {
    const schema = await parseSchema(path.join(FIXTURES, 'valid-multiselect-per-option-default.yaml'));
    const validator = buildValuesValidator(schema);

    // `agents` has min: 1 — an empty selection must be rejected.
    expect(() => validator.parse({ agents: [] })).toThrow();
    // A single valid selection passes.
    expect(validator.parse({ agents: ['codex'] }).agents).toEqual(['codex']);
    // Omitting `agents` falls back to the synthesized default ['claude'] (length 1, ok).
    expect(validator.parse({}).agents).toEqual(['claude']);
  });

  it('rejects invalid select values', async () => {
    const schema = await parseSchema(path.join(FIXTURES, 'valid-all-types.yaml'));
    const validator = buildValuesValidator(schema);

    expect(() => validator.parse({ user_name: 'A', vault_purpose: 'invalid_option' })).toThrow();
  });

  it('applies .optional() for non-required values', async () => {
    const schema = await parseSchema(path.join(FIXTURES, 'valid-all-types.yaml'));
    const validator = buildValuesValidator(schema);

    // Only required fields: user_name (required: true), vault_purpose (required: true)
    const result = validator.parse({
      user_name: 'Alice',
      vault_purpose: 'engineering',
    });
    expect(result.user_name).toBe('Alice');
  });

  it('applies .default() for non-computed defaults', async () => {
    const schema = await parseSchema(path.join(FIXTURES, 'valid-all-types.yaml'));
    const validator = buildValuesValidator(schema);

    const result = validator.parse({
      user_name: 'Alice',
      vault_purpose: 'engineering',
    });
    expect(result.dark_mode).toBe(true);
    expect(result.max_notes).toBe(10);
    expect(result.tags).toEqual(['notes', 'vault']);
  });

  it('skips .default() for computed defaults ({{ expressions }})', async () => {
    const schema = await parseSchema(path.join(FIXTURES, 'valid-computed-defaults.yaml'));
    const validator = buildValuesValidator(schema);

    // is_engineering has a computed default — should not be applied as zod default
    // Passing without is_engineering should work (it's optional) but not pre-fill
    const result = validator.parse({ vault_purpose: 'engineering' });
    expect(result.is_engineering).toBeUndefined();
  });
});

describe('isComputedDefault', () => {
  it('detects {{ }} expressions', () => {
    expect(isComputedDefault("{{ vault_purpose == 'engineering' }}")).toBe(true);
    expect(isComputedDefault("  {{ something }}")).toBe(true);
  });

  it('rejects plain strings and non-strings', () => {
    expect(isComputedDefault('hello')).toBe(false);
    expect(isComputedDefault(42)).toBe(false);
    expect(isComputedDefault(true)).toBe(false);
    expect(isComputedDefault(null)).toBe(false);
  });
});
