import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseSchema, buildValuesValidator, isComputedDefault } from '../../source/core/schema.js';

const FIXTURES = path.resolve('tests/fixtures/schema');
const EXAMPLE_SCHEMA = path.resolve('examples/minimal-shard/.shardmind/shard-schema.yaml');

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
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const tmp = path.join(os.tmpdir(), `schema-test-${Date.now()}.yaml`);
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

  it('rejects values missing the required `default` field', async () => {
    const err = await parseSchema(path.join(FIXTURES, 'invalid-missing-default.yaml')).catch(e => e);
    expect(err.code).toBe('SCHEMA_VALIDATION_FAILED');
    expect(err.message).toContain('user_name');
    expect(err.message).toContain('default');
    expect(err.hint).toContain('Every value must declare a `default`');
  });

  it('reports every value missing `default` (not just the first)', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const tmp = path.join(os.tmpdir(), `schema-no-default-${Date.now()}.yaml`);
    await fs.writeFile(tmp, [
      'schema_version: 1',
      'values:',
      '  alpha:',
      '    type: string',
      '    message: "x"',
      '    group: setup',
      '  beta:',
      '    type: number',
      '    message: "y"',
      '    group: setup',
      '  gamma:',
      '    type: string',
      '    message: "z"',
      '    default: ""',
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
      expect(err.code).toBe('SCHEMA_VALIDATION_FAILED');
      expect(err.message).toContain('alpha');
      expect(err.message).toContain('beta');
      expect(err.message).not.toContain('gamma');
    } finally {
      await fs.unlink(tmp);
    }
  });

  it('silently ignores the dead `partials` field on modules (v5 → v6 tolerance)', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const tmp = path.join(os.tmpdir(), `schema-partials-${Date.now()}.yaml`);
    await fs.writeFile(tmp, [
      'schema_version: 1',
      'values:',
      '  user_name:',
      '    type: string',
      '    message: "Your name"',
      '    default: ""',
      '    group: setup',
      'groups:',
      '  - { id: setup, label: "Setup" }',
      'modules:',
      '  legacy_mod:',
      '    label: "Has v5 partials field"',
      '    paths: ["legacy/"]',
      '    partials: ["claude/_legacy.md.njk"]',
      '    removable: true',
      'signals: []',
      'frontmatter: {}',
      'migrations: []',
      '',
    ].join('\n'));

    try {
      const schema = await parseSchema(tmp);
      const mod = schema.modules['legacy_mod']!;
      expect(mod.label).toBe('Has v5 partials field');
      expect(mod.paths).toEqual(['legacy/']);
      expect((mod as Record<string, unknown>)['partials']).toBeUndefined();
    } finally {
      await fs.unlink(tmp);
    }
  });

  it('accepts sentinel default values (null, empty string, false, 0, empty list)', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const tmp = path.join(os.tmpdir(), `schema-sentinel-defaults-${Date.now()}.yaml`);
    await fs.writeFile(tmp, [
      'schema_version: 1',
      'values:',
      '  null_default:',
      '    type: string',
      '    message: "a"',
      '    default: null',
      '    group: setup',
      '  empty_string_default:',
      '    type: string',
      '    message: "b"',
      '    default: ""',
      '    group: setup',
      '  false_default:',
      '    type: boolean',
      '    message: "c"',
      '    default: false',
      '    group: setup',
      '  zero_default:',
      '    type: number',
      '    message: "d"',
      '    default: 0',
      '    group: setup',
      '  empty_list_default:',
      '    type: list',
      '    message: "e"',
      '    default: []',
      '    group: setup',
      '  bare_default:',
      '    type: string',
      '    message: "f"',
      '    default:',
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
      const schema = await parseSchema(tmp);
      expect(Object.keys(schema.values)).toHaveLength(6);
      expect(schema.values['null_default']!.default).toBeNull();
      expect(schema.values['empty_string_default']!.default).toBe('');
      expect(schema.values['false_default']!.default).toBe(false);
      expect(schema.values['zero_default']!.default).toBe(0);
      expect(schema.values['empty_list_default']!.default).toEqual([]);
      expect(schema.values['bare_default']!.default).toBeNull();
    } finally {
      await fs.unlink(tmp);
    }
  });

  it('reports every reserved-name collision when multiple', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const tmp = path.join(os.tmpdir(), `schema-reserved-${Date.now()}.yaml`);
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
