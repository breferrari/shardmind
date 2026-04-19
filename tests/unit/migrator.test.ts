import { describe, it, expect } from 'vitest';
import type { Migration } from '../../source/runtime/types.js';
import { applyMigrations, selectApplicable } from '../../source/core/migrator.js';

describe('selectApplicable', () => {
  it('keeps migrations whose from_version sits in (current, target]', () => {
    const migrations: Migration[] = [
      { from_version: '3.0.0', changes: [] },
      { from_version: '3.5.0', changes: [] },
      { from_version: '3.7.0', changes: [] },
      { from_version: '4.0.0', changes: [] },
      { from_version: '4.1.0', changes: [] },
    ];
    const picked = selectApplicable(migrations, '3.5.0', '4.0.0').map((m) => m.from_version);
    expect(picked).toEqual(['3.7.0', '4.0.0']);
  });

  it('sorts ascending even when input is disordered', () => {
    const migrations: Migration[] = [
      { from_version: '4.0.0', changes: [] },
      { from_version: '3.7.0', changes: [] },
      { from_version: '3.6.0', changes: [] },
    ];
    const picked = selectApplicable(migrations, '3.5.0', '4.0.0').map((m) => m.from_version);
    expect(picked).toEqual(['3.6.0', '3.7.0', '4.0.0']);
  });

  it('drops migrations with invalid from_version strings', () => {
    const migrations: Migration[] = [
      { from_version: 'latest', changes: [] },
      { from_version: '3.6.0', changes: [] },
    ];
    const picked = selectApplicable(migrations, '3.5.0', '4.0.0').map((m) => m.from_version);
    expect(picked).toEqual(['3.6.0']);
  });

  it('returns an empty list when already at target', () => {
    const migrations: Migration[] = [{ from_version: '3.7.0', changes: [] }];
    expect(selectApplicable(migrations, '4.0.0', '4.0.0')).toEqual([]);
  });
});

describe('applyMigrations — rename', () => {
  it('moves the value to the new key and deletes the old', () => {
    const result = applyMigrations(
      { legacy_name: 'brenno', other: 1 },
      '1.0.0',
      '2.0.0',
      [
        {
          from_version: '2.0.0',
          changes: [{ type: 'rename', old: 'legacy_name', new: 'user_name' }],
        },
      ],
    );
    expect(result.values).toEqual({ user_name: 'brenno', other: 1 });
    expect(result.applied).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it('warns and skips when the source key is missing', () => {
    const result = applyMigrations(
      { other: 1 },
      '1.0.0',
      '2.0.0',
      [
        {
          from_version: '2.0.0',
          changes: [{ type: 'rename', old: 'legacy_name', new: 'user_name' }],
        },
      ],
    );
    expect(result.values).toEqual({ other: 1 });
    expect(result.applied).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('legacy_name');
  });
});

describe('applyMigrations — added', () => {
  it('sets the default when the key is missing', () => {
    const result = applyMigrations(
      { user_name: 'brenno' },
      '1.0.0',
      '2.0.0',
      [
        {
          from_version: '2.0.0',
          changes: [{ type: 'added', key: 'qmd_enabled', default: false }],
        },
      ],
    );
    expect(result.values).toEqual({ user_name: 'brenno', qmd_enabled: false });
    expect(result.applied).toHaveLength(1);
  });

  it('does not overwrite a key that already exists', () => {
    const result = applyMigrations(
      { qmd_enabled: true },
      '1.0.0',
      '2.0.0',
      [
        {
          from_version: '2.0.0',
          changes: [{ type: 'added', key: 'qmd_enabled', default: false }],
        },
      ],
    );
    expect(result.values).toEqual({ qmd_enabled: true });
    expect(result.applied).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe('applyMigrations — removed', () => {
  it('drops the key and warns', () => {
    const result = applyMigrations(
      { legacy_flag: true, user_name: 'x' },
      '1.0.0',
      '2.0.0',
      [
        {
          from_version: '2.0.0',
          changes: [{ type: 'removed', key: 'legacy_flag' }],
        },
      ],
    );
    expect(result.values).toEqual({ user_name: 'x' });
    expect(result.applied).toHaveLength(1);
    expect(result.warnings[0]).toContain('legacy_flag');
  });

  it('no-ops when the key is already absent', () => {
    const result = applyMigrations(
      { user_name: 'x' },
      '1.0.0',
      '2.0.0',
      [
        {
          from_version: '2.0.0',
          changes: [{ type: 'removed', key: 'legacy_flag' }],
        },
      ],
    );
    expect(result.applied).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe('applyMigrations — type_changed', () => {
  it('applies the transform expression', () => {
    const result = applyMigrations(
      { qmd_enabled: true },
      '1.0.0',
      '2.0.0',
      [
        {
          from_version: '2.0.0',
          changes: [
            {
              type: 'type_changed',
              key: 'qmd_enabled',
              from: 'boolean',
              to: 'string',
              transform: 'value ? "enabled" : "disabled"',
            },
          ],
        },
      ],
    );
    expect(result.values).toEqual({ qmd_enabled: 'enabled' });
  });

  it('warns and preserves the original value when the transform throws', () => {
    const result = applyMigrations(
      { qmd_enabled: true },
      '1.0.0',
      '2.0.0',
      [
        {
          from_version: '2.0.0',
          changes: [
            {
              type: 'type_changed',
              key: 'qmd_enabled',
              from: 'boolean',
              to: 'string',
              transform: 'value.nope.boom',
            },
          ],
        },
      ],
    );
    expect(result.values).toEqual({ qmd_enabled: true });
    expect(result.warnings[0]).toContain('qmd_enabled');
  });

  it('warns and skips when the key is missing', () => {
    const result = applyMigrations(
      {},
      '1.0.0',
      '2.0.0',
      [
        {
          from_version: '2.0.0',
          changes: [
            {
              type: 'type_changed',
              key: 'qmd_enabled',
              from: 'boolean',
              to: 'string',
              transform: 'String(value)',
            },
          ],
        },
      ],
    );
    expect(result.values).toEqual({});
    expect(result.warnings[0]).toContain('qmd_enabled');
  });
});

describe('applyMigrations — chain', () => {
  it('applies migrations in semver order across several versions', () => {
    const migrations: Migration[] = [
      {
        from_version: '3.0.0',
        changes: [{ type: 'rename', old: 'a', new: 'b' }],
      },
      {
        from_version: '3.7.0',
        changes: [
          { type: 'added', key: 'c', default: 42 },
          { type: 'removed', key: 'dead' },
        ],
      },
      {
        from_version: '4.0.0',
        changes: [
          {
            type: 'type_changed',
            key: 'b',
            from: 'string',
            to: 'number',
            transform: 'Number(value)',
          },
        ],
      },
    ];

    const result = applyMigrations(
      { a: '17', dead: true, kept: 'x' },
      '2.5.0',
      '4.0.0',
      migrations,
    );

    expect(result.values).toEqual({ b: 17, c: 42, kept: 'x' });
    expect(result.applied.map((c) => c.type)).toEqual([
      'rename',
      'added',
      'removed',
      'type_changed',
    ]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('dead');
  });

  it('is a no-op when current equals target', () => {
    const result = applyMigrations(
      { x: 1 },
      '1.2.3',
      '1.2.3',
      [{ from_version: '1.2.3', changes: [{ type: 'added', key: 'y', default: 2 }] }],
    );
    expect(result.values).toEqual({ x: 1 });
    expect(result.applied).toEqual([]);
  });

  it('throws on invalid semver input', () => {
    expect(() => applyMigrations({}, 'not-a-version', '1.0.0', [])).toThrow(
      /Invalid semver/,
    );
  });
});
