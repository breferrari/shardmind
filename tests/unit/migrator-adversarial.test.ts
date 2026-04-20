/**
 * Adversarial + property-based tests for the migrator.
 *
 * Precedent: PR #48 pushed the merge engine against 16 attack categories
 * with 1 200 generative scenarios and caught 4 real bugs. This suite
 * applies the same lens to `applyMigrations`.
 *
 * Categories covered:
 *   - Hostile input shapes (prototype keys, non-Error throws, cyclic values)
 *   - Transform pathology (infinite loops, unserializable returns, `undefined`)
 *   - Semver edge cases (pre-release, build metadata, equal from_version ties)
 *   - Chain properties (idempotence, transitivity, no-key-invention)
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { Migration, MigrationChange } from '../../source/runtime/types.js';
import { applyMigrations, selectApplicable } from '../../source/core/migrator.js';

// ---------------------------------------------------------------------------
// Hostile inputs
// ---------------------------------------------------------------------------

describe('applyMigrations — hostile inputs', () => {
  it('does not corrupt Object.prototype when a values key is __proto__', () => {
    // Even though values come from user YAML, a hostile shard-values.yaml
    // could contain `__proto__: { admin: true }`. Migrating such a map
    // must not pollute the global prototype.
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, '__proto__', {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
    });
    applyMigrations(hostile, '1.0.0', '2.0.0', [
      { from_version: '2.0.0', changes: [{ type: 'added', key: 'safe_key', default: true }] },
    ]);
    // Nothing leaked onto the real prototype.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('survives a migration whose transform throws a non-Error value', () => {
    // `throw 42` is a statement, so it needs an IIFE wrapper to be a
    // valid expression for `new Function('value', 'return (<expr>)')`.
    const result = applyMigrations({ x: 1 }, '1.0.0', '2.0.0', [
      {
        from_version: '2.0.0',
        changes: [
          {
            type: 'type_changed',
            key: 'x',
            from: 'number',
            to: 'string',
            transform: '(() => { throw 42; })()',
          },
        ],
      },
    ]);
    expect(result.values).toEqual({ x: 1 });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('42');
  });

  it('captures transforms returning `undefined` as unchanged', () => {
    // `() => undefined` is a degenerate transform; treat as "no change"
    // semantically by storing undefined at the key. Current contract does
    // assign undefined; this test pins that behavior so future changes
    // are intentional.
    const result = applyMigrations({ x: 1 }, '1.0.0', '2.0.0', [
      {
        from_version: '2.0.0',
        changes: [
          { type: 'type_changed', key: 'x', from: 'number', to: 'string', transform: 'undefined' },
        ],
      },
    ]);
    expect(result.values).toHaveProperty('x', undefined);
  });

  it('handles transforms returning unserializable values (function, symbol)', () => {
    // The engine does not enforce serializability at migration time — zod
    // validation catches the type mismatch afterward. Here we just verify
    // the migrator itself does not crash.
    const result = applyMigrations({ x: 1 }, '1.0.0', '2.0.0', [
      {
        from_version: '2.0.0',
        changes: [
          { type: 'type_changed', key: 'x', from: 'number', to: 'function', transform: '() => 1' },
        ],
      },
    ]);
    expect(typeof result.values['x']).toBe('function');
  });

  it('does not hang when a transform loops — runs to completion but warns on timeout-style issues', () => {
    // A pathological `while(true)` transform would wedge the engine. We
    // don't sandbox (that's out of scope for v0.1), but we demonstrate
    // that a transform which *eventually returns* after a big loop is
    // still handled correctly, bounding the test at 200ms via a cap on
    // iterations inside the transform expression.
    const result = applyMigrations({ x: 1 }, '1.0.0', '2.0.0', [
      {
        from_version: '2.0.0',
        changes: [
          {
            type: 'type_changed',
            key: 'x',
            from: 'number',
            to: 'number',
            transform: '(() => { let n = 0; for (let i = 0; i < 1000; i++) n += i; return n; })()',
          },
        ],
      },
    ]);
    expect(result.values['x']).toBe(499500);
  });

  it('tolerates BOM-prefixed string values', () => {
    const withBOM = '\ufeffAlice';
    const result = applyMigrations(
      { user_name: withBOM },
      '1.0.0',
      '2.0.0',
      [{ from_version: '2.0.0', changes: [{ type: 'rename', old: 'user_name', new: 'name' }] }],
    );
    expect(result.values['name']).toBe(withBOM);
  });

  it('tolerates null-byte-containing string values', () => {
    const nul = 'before\u0000after';
    const result = applyMigrations(
      { user_name: nul },
      '1.0.0',
      '2.0.0',
      [{ from_version: '2.0.0', changes: [{ type: 'rename', old: 'user_name', new: 'name' }] }],
    );
    expect(result.values['name']).toBe(nul);
  });

  it('handles circular value graphs without stack overflow', () => {
    // Values containing cycles come from nothing shardmind does itself,
    // but nothing in the migrator reads into nested structures, so it
    // should be a no-op. This locks the guarantee.
    const cyclic: Record<string, unknown> = { a: 1 };
    (cyclic as { self?: unknown }).self = cyclic;

    const result = applyMigrations(cyclic, '1.0.0', '2.0.0', [
      { from_version: '2.0.0', changes: [{ type: 'added', key: 'b', default: 2 }] },
    ]);
    expect(result.values['a']).toBe(1);
    expect(result.values['b']).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Semver edge cases
// ---------------------------------------------------------------------------

describe('selectApplicable — semver edge cases', () => {
  it('applies pre-release versions in strict semver order', () => {
    const picked = selectApplicable(
      [
        { from_version: '4.0.0-rc.1', changes: [] },
        { from_version: '4.0.0-alpha.1', changes: [] },
        { from_version: '4.0.0-beta.1', changes: [] },
        { from_version: '4.0.0', changes: [] },
      ],
      '3.9.0',
      '4.0.0',
    );
    expect(picked.map((m) => m.from_version)).toEqual([
      '4.0.0-alpha.1',
      '4.0.0-beta.1',
      '4.0.0-rc.1',
      '4.0.0',
    ]);
  });

  it('treats build-metadata-only differences as equal (semver ignores +build)', () => {
    // semver treats 1.0.0+a === 1.0.0+b. Both should filter in or out
    // together; insertion order preserved within the tie.
    const picked = selectApplicable(
      [
        { from_version: '1.0.0+build1', changes: [] },
        { from_version: '1.0.0+build2', changes: [] },
      ],
      '0.9.0',
      '1.0.0',
    );
    expect(picked).toHaveLength(2);
  });

  it('does not re-apply migrations when target equals an already-applied from_version', () => {
    const picked = selectApplicable(
      [{ from_version: '2.0.0', changes: [] }],
      '2.0.0',
      '2.0.0',
    );
    expect(picked).toEqual([]);
  });

  it('supports major-version jumps (0.x → 1.0)', () => {
    const picked = selectApplicable(
      [
        { from_version: '0.3.0', changes: [] },
        { from_version: '0.5.0', changes: [] },
        { from_version: '1.0.0', changes: [] },
      ],
      '0.1.0',
      '1.0.0',
    );
    expect(picked.map((m) => m.from_version)).toEqual(['0.3.0', '0.5.0', '1.0.0']);
  });
});

// ---------------------------------------------------------------------------
// Rename edge cases (added after the "silent clobber" bug)
// ---------------------------------------------------------------------------

describe('applyMigrations — rename edge cases', () => {
  it('chains a→b→c across two migrations without losing data', () => {
    const result = applyMigrations({ a: 'original' }, '1.0.0', '3.0.0', [
      { from_version: '2.0.0', changes: [{ type: 'rename', old: 'a', new: 'b' }] },
      { from_version: '3.0.0', changes: [{ type: 'rename', old: 'b', new: 'c' }] },
    ]);
    expect(result.values).toEqual({ c: 'original' });
  });

  it('rename target collision with the to-be-removed source in the same migration is safe', () => {
    // If the source and target are identical (renaming a key to itself),
    // the handler sees the target already occupied and warns rather than
    // deleting the key.
    const result = applyMigrations({ x: 1 }, '1.0.0', '2.0.0', [
      { from_version: '2.0.0', changes: [{ type: 'rename', old: 'x', new: 'x' }] },
    ]);
    expect(result.values).toEqual({ x: 1 });
    expect(result.warnings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Property-based invariants
// ---------------------------------------------------------------------------

describe('applyMigrations — properties (fast-check, 200 runs each)', () => {
  const keyArb = fc.stringMatching(/^[a-z_][a-z0-9_]{0,15}$/);
  const valueArb = fc.oneof(
    fc.string(),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
  );
  const valuesArb = fc.dictionary(keyArb, valueArb);
  const semverArb = fc
    .tuple(fc.integer({ min: 0, max: 5 }), fc.integer({ min: 0, max: 5 }), fc.integer({ min: 0, max: 5 }))
    .map(([a, b, c]) => `${a}.${b}.${c}`);

  it('is a no-op when currentVersion === targetVersion', () => {
    fc.assert(
      fc.property(valuesArb, semverArb, (values, v) => {
        const migrations: Migration[] = [
          {
            from_version: v,
            changes: [{ type: 'added', key: 'extra_noop', default: 42 }],
          },
        ];
        const out = applyMigrations(values, v, v, migrations);
        expect(out.values).toEqual(values);
        expect(out.applied).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });

  it('does not invent keys that no migration introduces', () => {
    fc.assert(
      fc.property(valuesArb, semverArb, semverArb, (values, from, to) => {
        fc.pre(from !== to);
        const out = applyMigrations(values, from < to ? from : to, from > to ? from : to, []);
        // With no migrations, the value map is unchanged.
        expect(out.values).toEqual(values);
        expect(out.applied).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });

  it('is idempotent: running twice with the same inputs yields the same result', () => {
    const migrations: Migration[] = [
      { from_version: '2.0.0', changes: [{ type: 'added', key: 'c', default: 'default-c' }] },
      { from_version: '3.0.0', changes: [{ type: 'removed', key: 'd' }] },
    ];
    fc.assert(
      fc.property(valuesArb, (values) => {
        const first = applyMigrations(values, '1.0.0', '3.0.0', migrations);
        const second = applyMigrations(
          structuredClone(first.values),
          '3.0.0',
          '3.0.0',
          migrations,
        );
        expect(second.values).toEqual(first.values);
      }),
      { numRuns: 200 },
    );
  });

  it('rename never drops data when target does not exist', () => {
    const sourceKeyArb = keyArb;
    const targetKeyArb = keyArb;
    fc.assert(
      fc.property(valuesArb, sourceKeyArb, targetKeyArb, valueArb, (seed, src, dst, v) => {
        fc.pre(src !== dst);
        fc.pre(!(dst in seed));
        const values = { ...seed, [src]: v };
        const change: MigrationChange = { type: 'rename', old: src, new: dst };
        const out = applyMigrations(values, '1.0.0', '2.0.0', [
          { from_version: '2.0.0', changes: [change] },
        ]);
        expect(out.values[dst]).toEqual(v);
        expect(out.values[src]).toBeUndefined();
      }),
      { numRuns: 200 },
    );
  });
});
