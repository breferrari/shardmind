/**
 * core/flows/values.ts: the values check every run makes before it writes
 * (#346). A value that doesn't fit the schema is the user's or the shard
 * author's to fix, so it must fail as a known error naming the key, never as
 * a raw zod error that the error view reports as a shardmind bug.
 */

import { describe, it, expect } from 'vitest';
import { validateValues, answersWithoutPrompting } from '../../source/core/flows/values.js';
import { describeError } from '../../source/core/bug-report.js';
import { ShardMindError, type ShardSchema } from '../../source/runtime/types.js';

const schema = {
  schema_version: 1,
  values: {
    qmd_enabled: { type: 'boolean', message: 'QMD?', default: false },
    retention_days: { type: 'number', message: 'Days?', default: 30, min: 1 },
    user_name: { type: 'string', message: 'Name?', required: true },
  },
  groups: [],
  modules: {},
  signals: [],
  frontmatter: {},
  migrations: [],
} as unknown as ShardSchema;

function failure(fn: () => unknown): ShardMindError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ShardMindError);
    return err as ShardMindError;
  }
  throw new Error('expected a throw');
}

describe('validateValues (#346)', () => {
  it('returns the values when they fit the schema', () => {
    expect(validateValues(schema, { qmd_enabled: true, retention_days: 7, user_name: 'Ada' }, 'answers')).toEqual({
      qmd_enabled: true,
      retention_days: 7,
      user_name: 'Ada',
    });
  });

  it('fails as VALUES_INVALID naming each key and what it expected', () => {
    const err = failure(() => validateValues(schema, { qmd_enabled: 'enabled', retention_days: 0, user_name: 'Ada' }, 'answers'));
    expect(err.code).toBe('VALUES_INVALID');
    expect(err.message).toContain('qmd_enabled');
    expect(err.message).toMatch(/boolean/);
    expect(err.message).toContain('retention_days');
  });

  it('is a known error to the error view, not a shardmind bug', () => {
    let thrown: unknown;
    try {
      validateValues(schema, { qmd_enabled: 'enabled', user_name: 'Ada' }, 'answers');
    } catch (err) {
      thrown = err;
    }
    expect(describeError(thrown, '0.0.0').kind).toBe('known');
  });

  it("names the --values file and the prompts for install and adopt's answers", () => {
    const err = failure(() => validateValues(schema, { qmd_enabled: 'yes', user_name: 'Ada' }, 'answers'));
    expect(err.hint).toContain('--values file');
    expect(err.hint).toContain('prompts');
  });

  it('treats undefined as unset: the default applies, a required key fails', () => {
    expect(validateValues(schema, { qmd_enabled: undefined, user_name: 'Ada' }, 'vault')).toMatchObject({ qmd_enabled: false });
    expect(failure(() => validateValues(schema, { user_name: undefined }, 'vault')).message).toContain('user_name');
  });

  it("names shard-values.yaml, a just-entered answer, and the shard's author for an update", () => {
    const err = failure(() => validateValues(schema, { qmd_enabled: 'enabled', user_name: 'Ada' }, 'vault'));
    expect(err.hint).toContain('shard-values.yaml');
    expect(err.hint).toContain('just entered');
    expect(err.hint).toContain("shard's author");
  });

  it('carries the same check through answersWithoutPrompting', () => {
    const err = failure(() => answersWithoutPrompting(schema, { qmd_enabled: 'enabled', user_name: 'Ada' }, false));
    expect(err.code).toBe('VALUES_INVALID');
    expect(err.hint).toContain('--values file');
  });
});
