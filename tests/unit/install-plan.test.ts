import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  resolveComputedDefaults,
  detectCollisions,
  backupCollisions,
  restoreBackups,
  mergePrefill,
  missingValueKeys,
  defaultModuleSelections,
} from '../../source/core/install-plan.js';
import { hashValues } from '../../source/core/install-runner.js';
import type { ShardSchema } from '../../source/runtime/types.js';

function schema(values: ShardSchema['values'], modules: ShardSchema['modules'] = {}): ShardSchema {
  return {
    schema_version: 1,
    values,
    groups: [{ id: 'setup', label: 'Setup' }],
    modules,
    signals: [],
    frontmatter: {},
    migrations: [],
  };
}

describe('resolveComputedDefaults', () => {
  it('evaluates a boolean expression using collected values', () => {
    const s = schema({
      vault_purpose: { type: 'select', required: true, message: '', group: 'setup', options: [{ value: 'engineering', label: 'Eng' }, { value: 'research', label: 'Res' }] },
      qmd_enabled: { type: 'boolean', message: '', default: "{{ vault_purpose == 'engineering' }}", group: 'setup' },
    });

    const result = resolveComputedDefaults(s, { vault_purpose: 'engineering' });
    expect(result['qmd_enabled']).toBe(true);

    const result2 = resolveComputedDefaults(s, { vault_purpose: 'research' });
    expect(result2['qmd_enabled']).toBe(false);
  });

  it('leaves already-answered values untouched', () => {
    const s = schema({
      x: { type: 'boolean', message: '', default: '{{ true }}', group: 'setup' },
    });

    const result = resolveComputedDefaults(s, { x: false });
    expect(result['x']).toBe(false);
  });

  it('coerces numbers', () => {
    const s = schema({
      n: { type: 'number', message: '', default: '{{ 40 + 2 }}', group: 'setup' },
    });

    const result = resolveComputedDefaults(s, {});
    expect(result['n']).toBe(42);
  });

  it('coerces JSON arrays for list type', () => {
    const s = schema({
      tags: { type: 'list', message: '', default: '{{ ["a", "b"] | dump }}', group: 'setup' },
    });

    const result = resolveComputedDefaults(s, {});
    expect(result['tags']).toEqual(['a', 'b']);
  });

  it('throws with code when boolean coercion fails', () => {
    const s = schema({
      x: { type: 'boolean', message: '', default: '{{ "maybe" }}', group: 'setup' },
    });

    expect(() => resolveComputedDefaults(s, {})).toThrowError(
      expect.objectContaining({ code: 'COMPUTED_DEFAULT_INVALID' }),
    );
  });

  it('skips values without a computed default', () => {
    const s = schema({
      name: { type: 'string', required: true, message: '', group: 'setup' },
    });

    const result = resolveComputedDefaults(s, { name: 'alice' });
    expect(result).toEqual({ name: 'alice' });
  });
});

describe('detectCollisions', () => {
  let vault: string;

  beforeEach(async () => {
    vault = path.join(os.tmpdir(), `shardmind-coll-${crypto.randomUUID()}`);
    await fsp.mkdir(vault, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(vault, { recursive: true, force: true });
  });

  it('returns empty when no planned paths exist on disk', async () => {
    const result = await detectCollisions(vault, ['Home.md', 'brain/North Star.md']);
    expect(result).toEqual([]);
  });

  it('flags existing files with size and mtime', async () => {
    await fsp.writeFile(path.join(vault, 'Home.md'), 'user content', 'utf-8');

    const result = await detectCollisions(vault, ['Home.md', 'brain/New.md']);
    expect(result).toHaveLength(1);
    expect(result[0]?.outputPath).toBe('Home.md');
    expect(result[0]?.size).toBe('user content'.length);
    expect(result[0]?.mtime).toBeInstanceOf(Date);
  });

  it('flags existing directories at planned paths (would cause EISDIR on write)', async () => {
    await fsp.mkdir(path.join(vault, 'Home.md'), { recursive: true });

    const result = await detectCollisions(vault, ['Home.md']);
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe('directory');
  });
});

describe('backupCollisions', () => {
  let vault: string;

  beforeEach(async () => {
    vault = path.join(os.tmpdir(), `shardmind-bkup-${crypto.randomUUID()}`);
    await fsp.mkdir(vault, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(vault, { recursive: true, force: true });
  });

  it('renames each colliding file with a timestamped backup suffix', async () => {
    const original = path.join(vault, 'Home.md');
    await fsp.writeFile(original, 'user content', 'utf-8');

    const records = await backupCollisions(
      [{ outputPath: 'Home.md', absolutePath: original, size: 12, mtime: new Date(), kind: 'file' }],
      new Date('2026-04-18T10:30:00.123Z'),
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.backupPath).toBe(`${original}.shardmind-backup-2026-04-18T10-30-00`);

    await expect(fsp.access(original)).rejects.toThrow();
    const backup = await fsp.readFile(records[0]!.backupPath, 'utf-8');
    expect(backup).toBe('user content');
  });

  it('appends a counter when a backup path already exists (same-second collisions)', async () => {
    const original = path.join(vault, 'Home.md');
    const stamp = '2026-04-18T10-30-00';
    // Pre-seed a stale backup at the canonical name
    await fsp.writeFile(`${original}.shardmind-backup-${stamp}`, 'stale', 'utf-8');
    await fsp.writeFile(original, 'new user content', 'utf-8');

    const records = await backupCollisions(
      [{ outputPath: 'Home.md', absolutePath: original, size: 16, mtime: new Date(), kind: 'file' }],
      new Date('2026-04-18T10:30:00.000Z'),
    );

    expect(records[0]?.backupPath).toBe(`${original}.shardmind-backup-${stamp}.1`);
    const stale = await fsp.readFile(`${original}.shardmind-backup-${stamp}`, 'utf-8');
    expect(stale).toBe('stale'); // untouched
  });
});

describe('restoreBackups', () => {
  let vault: string;

  beforeEach(async () => {
    vault = path.join(os.tmpdir(), `shardmind-restore-${crypto.randomUUID()}`);
    await fsp.mkdir(vault, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(vault, { recursive: true, force: true });
  });

  it('moves backup files back to their original paths', async () => {
    const original = path.join(vault, 'Home.md');
    const backup = `${original}.shardmind-backup-2026-04-18T10-30-00`;
    await fsp.writeFile(backup, 'original content', 'utf-8');
    // Simulate a post-install artifact at the original path
    await fsp.writeFile(original, 'new install content', 'utf-8');

    const { restored, failed } = await restoreBackups([
      { originalPath: original, backupPath: backup },
    ]);

    expect(restored).toHaveLength(1);
    expect(failed).toHaveLength(0);
    const restoredContent = await fsp.readFile(original, 'utf-8');
    expect(restoredContent).toBe('original content');
    await expect(fsp.access(backup)).rejects.toThrow();
  });

  it('continues past individual failures and reports them', async () => {
    const goodOriginal = path.join(vault, 'good.md');
    const goodBackup = `${goodOriginal}.shardmind-backup-stamp`;
    await fsp.writeFile(goodBackup, 'good', 'utf-8');

    const missingBackup = path.join(vault, 'missing.md.shardmind-backup-stamp');

    const { restored, failed } = await restoreBackups([
      { originalPath: goodOriginal, backupPath: goodBackup },
      { originalPath: path.join(vault, 'missing.md'), backupPath: missingBackup },
    ]);

    expect(restored).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.originalPath).toContain('missing.md');
  });
});

describe('mergePrefill', () => {
  it('prefers prefill values over schema defaults', () => {
    const s = schema({
      org: { type: 'string', message: '', default: 'Independent', group: 'setup' },
      name: { type: 'string', required: true, message: '', group: 'setup' },
    });

    const merged = mergePrefill(s, { org: 'Acme', name: 'alice' });
    expect(merged).toEqual({ org: 'Acme', name: 'alice' });
  });

  it('uses static defaults when prefill is absent', () => {
    const s = schema({
      org: { type: 'string', message: '', default: 'Independent', group: 'setup' },
      name: { type: 'string', required: true, message: '', group: 'setup' },
    });

    const merged = mergePrefill(s, {});
    expect(merged).toEqual({ org: 'Independent' });
  });

  it('does not fill computed defaults (deferred to resolveComputedDefaults)', () => {
    const s = schema({
      purpose: { type: 'select', required: true, message: '', group: 'setup', options: [{ value: 'x', label: 'x' }] },
      qmd: { type: 'boolean', message: '', default: "{{ purpose == 'x' }}", group: 'setup' },
    });

    const merged = mergePrefill(s, { purpose: 'x' });
    expect(merged).toEqual({ purpose: 'x' });
    expect(merged['qmd']).toBeUndefined();
  });
});

describe('missingValueKeys', () => {
  it('returns keys that need prompting', () => {
    const s = schema({
      a: { type: 'string', required: true, message: '', group: 'setup' },
      b: { type: 'string', message: '', default: 'x', group: 'setup' },
      c: { type: 'string', required: true, message: '', group: 'setup' },
    });

    const missing = missingValueKeys(s, { a: 'hi', b: 'x' });
    expect(missing).toEqual(['c']);
  });

  it('excludes values with computed defaults', () => {
    const s = schema({
      a: { type: 'string', required: true, message: '', group: 'setup' },
      b: { type: 'boolean', message: '', default: '{{ true }}', group: 'setup' },
    });

    const missing = missingValueKeys(s, {});
    expect(missing).toEqual(['a']);
  });

  it('preserves schema declaration order', () => {
    const s = schema({
      z: { type: 'string', required: true, message: '', group: 'setup' },
      a: { type: 'string', required: true, message: '', group: 'setup' },
      m: { type: 'string', required: true, message: '', group: 'setup' },
    });

    const missing = missingValueKeys(s, {});
    expect(missing).toEqual(['z', 'a', 'm']);
  });
});

describe('hashValues', () => {
  it('is stable regardless of top-level key order', () => {
    const a = hashValues({ name: 'alice', org: 'acme' });
    const b = hashValues({ org: 'acme', name: 'alice' });
    expect(a).toBe(b);
  });

  it('is stable regardless of nested key order', () => {
    const a = hashValues({ opts: { foo: 1, bar: 2 }, list: [{ k: 'x' }] });
    const b = hashValues({ list: [{ k: 'x' }], opts: { bar: 2, foo: 1 } });
    expect(a).toBe(b);
  });

  it('preserves nested object keys (does not whitelist by top-level keys)', () => {
    // The previous `JSON.stringify(v, Object.keys(v).sort())` approach
    // applied top-level keys as a whitelist to nested objects too, so
    // different nested values hashed identically. Guard against regression.
    const a = hashValues({ outer: { inner_a: 1 } });
    const b = hashValues({ outer: { inner_b: 2 } });
    expect(a).not.toBe(b);
  });

  it('distinguishes arrays of objects by their contents', () => {
    const a = hashValues({ items: [{ x: 1 }, { x: 2 }] });
    const b = hashValues({ items: [{ x: 1 }, { x: 3 }] });
    expect(a).not.toBe(b);
  });
});

describe('defaultModuleSelections', () => {
  it('marks all modules as included by default', () => {
    const s = schema({}, {
      core: { label: 'Core', paths: ['core/'], removable: false },
      extras: { label: 'Extras', paths: ['extras/'], removable: true },
    });

    const selections = defaultModuleSelections(s);
    expect(selections).toEqual({ core: 'included', extras: 'included' });
  });
});
