import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseSchema } from '../../source/core/schema.js';
import { valuesAreDefaults } from '../../source/core/values-defaults.js';
import type { ShardSchema } from '../../source/runtime/types.js';

const FIXTURES = path.resolve('tests/fixtures/schema');

async function load(name: string): Promise<ShardSchema> {
  return parseSchema(path.join(FIXTURES, name));
}

describe('valuesAreDefaults', () => {
  describe('literal defaults', () => {
    it('returns true when every value matches the schema default', async () => {
      const schema = await load('valid-all-types.yaml');
      expect(
        valuesAreDefaults(
          {
            user_name: '',
            dark_mode: true,
            max_notes: 10,
            vault_purpose: 'engineering',
            plugins: [],
            tags: ['notes', 'vault'],
          },
          schema,
        ),
      ).toBe(true);
    });

    it('returns false when any single value differs from its default', async () => {
      const schema = await load('valid-all-types.yaml');
      expect(
        valuesAreDefaults(
          {
            user_name: 'alice',
            dark_mode: true,
            max_notes: 10,
            vault_purpose: 'engineering',
            plugins: [],
            tags: ['notes', 'vault'],
          },
          schema,
        ),
      ).toBe(false);
    });

    it('treats sentinel defaults — "", false, 0, [] — as defaults when matched', async () => {
      const schema = await load('valid-sentinel-defaults.yaml');
      const allDefaults = Object.fromEntries(
        Object.entries(schema.values).map(([k, def]) => [k, def.default]),
      );
      expect(valuesAreDefaults(allDefaults, schema)).toBe(true);
    });
  });

  describe('strict deep-equal', () => {
    it('discriminates by string whitespace', async () => {
      const schema = await load('valid-minimal.yaml');
      // valid-minimal default is the empty string.
      expect(valuesAreDefaults({ user_name: '' }, schema)).toBe(true);
      expect(valuesAreDefaults({ user_name: ' ' }, schema)).toBe(false);
    });

    it('discriminates by string case', async () => {
      const schema = await load('valid-all-types.yaml');
      const base = {
        user_name: '',
        dark_mode: true,
        max_notes: 10,
        vault_purpose: 'engineering',
        plugins: [],
        tags: ['notes', 'vault'],
      };
      expect(valuesAreDefaults({ ...base, vault_purpose: 'Engineering' }, schema)).toBe(false);
    });

    it('discriminates by number / string type coercion', async () => {
      const schema = await load('valid-all-types.yaml');
      const base = {
        user_name: '',
        dark_mode: true,
        max_notes: 10,
        vault_purpose: 'engineering',
        plugins: [],
        tags: ['notes', 'vault'],
      };
      expect(valuesAreDefaults({ ...base, max_notes: '10' }, schema)).toBe(false);
    });

    it('treats array order as significant', async () => {
      const schema = await load('valid-all-types.yaml');
      const base = {
        user_name: '',
        dark_mode: true,
        max_notes: 10,
        vault_purpose: 'engineering',
        plugins: [],
        tags: ['vault', 'notes'],
      };
      expect(valuesAreDefaults(base, schema)).toBe(false);
    });

    it('treats null and undefined as distinct', async () => {
      const schema: ShardSchema = {
        schema_version: 1,
        values: {
          opt: {
            type: 'string',
            required: false,
            message: 'opt',
            default: '',
            group: 'setup',
          },
        },
        groups: [{ id: 'setup', label: 'Setup' }],
        modules: {},
        signals: [],
        frontmatter: {},
        migrations: [],
      };
      expect(valuesAreDefaults({ opt: '' }, schema)).toBe(true);
      expect(valuesAreDefaults({ opt: null }, schema)).toBe(false);
      expect(valuesAreDefaults({}, schema)).toBe(false);
    });
  });

  describe('computed defaults', () => {
    it('resolves computed defaults against the literal-default map', async () => {
      const schema = await load('valid-computed-defaults.yaml');
      // vault_purpose default is "engineering"; is_engineering default is
      // `{{ vault_purpose == 'engineering' }}` → true.
      expect(
        valuesAreDefaults(
          { vault_purpose: 'engineering', is_engineering: true },
          schema,
        ),
      ).toBe(true);
    });

    it('returns false when the user changed the literal value the computed default depends on', async () => {
      const schema = await load('valid-computed-defaults.yaml');
      // User chose research; computed default of is_engineering is now
      // false against the would-be-default map. User passing
      // is_engineering=true (the engineering-default value) cannot make
      // valuesAreDefaults true because vault_purpose itself isn't default.
      expect(
        valuesAreDefaults(
          { vault_purpose: 'research', is_engineering: true },
          schema,
        ),
      ).toBe(false);
    });

    it('returns false when a literal-default-derived computed cannot be matched', async () => {
      const schema = await load('valid-computed-defaults.yaml');
      // vault_purpose at default; user keeps is_engineering wrong.
      expect(
        valuesAreDefaults(
          { vault_purpose: 'engineering', is_engineering: false },
          schema,
        ),
      ).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('returns true on a schema with zero values', async () => {
      const schema: ShardSchema = {
        schema_version: 1,
        values: {},
        groups: [],
        modules: {},
        signals: [],
        frontmatter: {},
        migrations: [],
      };
      expect(valuesAreDefaults({}, schema)).toBe(true);
    });

    it('ignores extra user keys not in the schema', async () => {
      const schema = await load('valid-minimal.yaml');
      expect(
        valuesAreDefaults({ user_name: '', extra: 'noise' }, schema),
      ).toBe(true);
    });

    it('returns false defensively when a schema value has no default', async () => {
      // Post-#74 the parser rejects schemas without defaults; we still
      // guard the runtime path so a hand-constructed `ShardSchema`
      // (e.g., a future migration framework) cannot crash hook-context
      // construction.
      const schema: ShardSchema = {
        schema_version: 1,
        values: {
          legacy: {
            type: 'string',
            required: false,
            message: 'legacy',
            default: undefined,
            group: 'setup',
          },
        },
        groups: [{ id: 'setup', label: 'Setup' }],
        modules: {},
        signals: [],
        frontmatter: {},
        migrations: [],
      };
      expect(valuesAreDefaults({ legacy: '' }, schema)).toBe(false);
    });

    it('returns false when a computed default fails to coerce', async () => {
      // A `type: number` value with a computed default that resolves to
      // a non-numeric string — `resolveComputedDefaults` throws a
      // COMPUTED_DEFAULT_INVALID error. The function must swallow the
      // throw (hook context construction is non-fatal) and return false.
      const schema: ShardSchema = {
        schema_version: 1,
        values: {
          bad_number: {
            type: 'number',
            required: false,
            message: 'computed default that cannot coerce to number',
            default: '{{ "not-a-number" }}',
            group: 'setup',
          },
        },
        groups: [{ id: 'setup', label: 'Setup' }],
        modules: {},
        signals: [],
        frontmatter: {},
        migrations: [],
      };
      expect(valuesAreDefaults({ bad_number: 0 }, schema)).toBe(false);
    });
  });
});
