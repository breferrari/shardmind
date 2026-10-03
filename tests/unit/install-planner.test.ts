import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  resolveComputedDefaults,
  detectCollisions,
  mergePrefill,
  missingValueKeys,
  defaultModuleSelections,
  hashValues,
  splitByOwnContent,
} from '../../source/core/install-planner.js';
import { sha256 } from '../../source/core/fs-utils.js';
import { makeShardState } from '../helpers/shard-state.js';
import {
  backupCollisions,
  restoreBackups,
  carryOverBackups,
} from '../../source/core/install-executor.js';
import { ShardMindError, type ShardSchema } from '../../source/runtime/types.js';

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

describe('splitByOwnContent', () => {
  let vault: string;

  beforeEach(async () => {
    vault = path.join(os.tmpdir(), `shardmind-own-${crypto.randomUUID()}`);
    await fsp.mkdir(vault, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(vault, { recursive: true, force: true });
  });

  const fileState = (content: string) => ({
    template: null,
    rendered_hash: sha256(content),
    ownership: 'managed' as const,
  });
  const paths = (cs: Array<{ outputPath: string }>) => cs.map((c) => c.outputPath);

  it('counts every collision as own content when there is no previous install', async () => {
    await fsp.writeFile(path.join(vault, 'a.md'), 'mine');
    const collisions = await detectCollisions(vault, ['a.md']);
    const { own, untouched } = await splitByOwnContent(collisions, null);
    expect(paths(own)).toEqual(['a.md']);
    expect(untouched).toEqual([]);
  });

  it("separates a previous install's untouched files from the user's own content (#55)", async () => {
    await fsp.writeFile(path.join(vault, 'engine.md'), 'rendered');
    await fsp.writeFile(path.join(vault, 'edited.md'), 'my edit');
    await fsp.writeFile(path.join(vault, 'stranger.md'), 'not tracked');
    await fsp.mkdir(path.join(vault, 'dir.md'));
    const collisions = await detectCollisions(vault, ['engine.md', 'edited.md', 'stranger.md', 'dir.md']);
    const previous = makeShardState({
      files: {
        'engine.md': fileState('rendered'),
        'edited.md': fileState('the original render'),
        'dir.md': fileState('was a file'),
      },
    });
    const { own, untouched } = await splitByOwnContent(collisions, previous);
    expect(paths(own)).toEqual(['edited.md', 'stranger.md', 'dir.md']);
    expect(paths(untouched)).toEqual(['engine.md']);
  });

  it('counts a file it cannot read as own content rather than failing', async () => {
    await fsp.writeFile(path.join(vault, 'gone.md'), 'rendered');
    const collisions = await detectCollisions(vault, ['gone.md']);
    await fsp.rm(path.join(vault, 'gone.md'));
    const previous = makeShardState({ files: { 'gone.md': fileState('rendered') } });
    const { own } = await splitByOwnContent(collisions, previous);
    expect(paths(own)).toEqual(['gone.md']);
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

describe('carryOverBackups', () => {
  let vault: string;

  beforeEach(async () => {
    vault = path.join(os.tmpdir(), `shardmind-carry-${crypto.randomUUID()}`);
    await fsp.mkdir(vault, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(vault, { recursive: true, force: true });
  });

  it("moves an old state dir's backups into the new one, merging with any there (#55)", async () => {
    const old = path.join(vault, 'old-state');
    await fsp.mkdir(path.join(old, 'backups', 'update-1', 'files'), { recursive: true });
    await fsp.writeFile(path.join(old, 'backups', 'update-1', 'files', 'note.md'), 'only copy');
    await fsp.mkdir(path.join(vault, '.shardmind', 'backups', 'adopt-2'), { recursive: true });
    await carryOverBackups(old, vault);
    expect(await fsp.readFile(path.join(vault, '.shardmind', 'backups', 'update-1', 'files', 'note.md'), 'utf-8')).toBe('only copy');
    expect((await fsp.stat(path.join(vault, '.shardmind', 'backups', 'adopt-2'))).isDirectory()).toBe(true);
  });

  it('does nothing when the old state dir has no backups', async () => {
    const old = path.join(vault, 'old-state');
    await fsp.mkdir(old, { recursive: true });
    await carryOverBackups(old, vault);
    await expect(fsp.stat(path.join(vault, '.shardmind', 'backups'))).rejects.toThrow();
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

  it('reports each move as it happens, so an interrupt can undo it (#55)', async () => {
    const a = path.join(vault, 'a.md');
    const b = path.join(vault, 'b.md');
    await fsp.writeFile(a, 'a');
    await fsp.writeFile(b, 'b');
    const seen: string[] = [];
    const records = await backupCollisions(
      [
        { outputPath: 'a.md', absolutePath: a, size: 1, mtime: new Date(), kind: 'file' },
        { outputPath: 'b.md', absolutePath: b, size: 1, mtime: new Date(), kind: 'file' },
      ],
      new Date(),
      (r) => seen.push(r.originalPath),
    );
    expect(seen).toEqual([a, b]);
    expect(records.map((r) => r.originalPath)).toEqual(seen);
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

  it('names the collision "kind" in the error message when backup fails', async () => {
    // Covers both the file and the directory branch: the thrown error
    // reads "Could not back up existing <kind>: <path>", not the legacy
    // always-"file" wording. Directory collisions happen for real — a
    // shard with a module path that matches an existing vault folder —
    // so the message has to be accurate.
    const filePath = path.join(vault, 'file-in-missing-parent', 'x.md');
    const dirPath = path.join(vault, 'dir-in-missing-parent', 'subdir');
    // Parent directories do not exist → fsp.rename throws ENOENT for both.

    const fileErr = await backupCollisions(
      [{ outputPath: 'x.md', absolutePath: filePath, size: 0, mtime: new Date(), kind: 'file' }],
      new Date('2026-04-18T10:30:00.000Z'),
    ).catch((e: unknown) => e);
    expect(fileErr).toBeInstanceOf(ShardMindError);
    expect((fileErr as ShardMindError).message).toMatch(/Could not back up existing file:/);

    const dirErr = await backupCollisions(
      [{ outputPath: 'subdir', absolutePath: dirPath, size: 0, mtime: new Date(), kind: 'directory' }],
      new Date('2026-04-18T10:30:00.000Z'),
    ).catch((e: unknown) => e);
    expect(dirErr).toBeInstanceOf(ShardMindError);
    expect((dirErr as ShardMindError).message).toMatch(/Could not back up existing directory:/);
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

  it('restores earlier backups when a later rename fails — vault ends byte-identical', async () => {
    // Three collisions: first two succeed, third fails because the target
    // path sits inside a missing directory we can't create via rename. The
    // transactional contract says: the first two renames must be walked
    // back so the vault looks pre-call, even though the error throws.
    const a = path.join(vault, 'A.md');
    const b = path.join(vault, 'B.md');
    const c = path.join(vault, 'missing-dir', 'C.md');
    await fsp.writeFile(a, 'alpha', 'utf-8');
    await fsp.writeFile(b, 'bravo', 'utf-8');
    // Intentionally do NOT create missing-dir, so the fsp.rename on `c`
    // fails with ENOENT (the parent of the backup path doesn't exist
    // because rename preserves the directory component).
    // Actually rename on nonexistent SOURCE (c itself) also throws ENOENT,
    // which is what we want for deterministic failure.

    await expect(
      backupCollisions(
        [
          { outputPath: 'A.md', absolutePath: a, size: 5, mtime: new Date(), kind: 'file' },
          { outputPath: 'B.md', absolutePath: b, size: 5, mtime: new Date(), kind: 'file' },
          // Third entry points at a path that doesn't exist — rename will ENOENT
          { outputPath: 'missing-dir/C.md', absolutePath: c, size: 0, mtime: new Date(), kind: 'file' },
        ],
        new Date('2026-04-18T10:30:00.000Z'),
      ),
    ).rejects.toMatchObject({ code: 'BACKUP_FAILED' });

    // Pre-call state: A.md and B.md exist with their original contents; no
    // .shardmind-backup-* artifacts linger.
    expect(await fsp.readFile(a, 'utf-8')).toBe('alpha');
    expect(await fsp.readFile(b, 'utf-8')).toBe('bravo');
    const siblings = await fsp.readdir(vault);
    expect(siblings.sort()).toEqual(['A.md', 'B.md'].sort());
  });

  it('names the orphaned backup path in the hint when restore also fails', async () => {
    // Force a restore-walk failure by intercepting the third fsp.rename
    // call with a mocked EACCES. Earlier drafts of this test tried to
    // trigger a real EEXIST by pre-seeding a file at the original path,
    // but that's racy under Windows' rename-over-existing semantics;
    // a mocked errno is deterministic on every OS and matches how
    // backupCollisions actually rolls back in production (it re-throws
    // whatever the OS returns).
    const a = path.join(vault, 'A.md');
    const missing = path.join(vault, 'missing.md');
    await fsp.writeFile(a, 'alpha', 'utf-8');

    // Three-call rename sequence:
    //   1. A → backup       (succeed, via the real rename)
    //   2. missing → backup (throw ENOENT — triggers the restore-walk)
    //   3. restore-walk of A (throw EACCES — forces an orphaned path)
    // The mock returns a typed Promise-based shim so no unsafe casts leak
    // into the test source.
    const realRename = fsp.rename;
    const spy = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (spy.mock.calls.length === 1) return realRename(from, to);
      if (spy.mock.calls.length === 2) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    });

    try {
      const err = await backupCollisions(
        [
          { outputPath: 'A.md', absolutePath: a, size: 5, mtime: new Date(), kind: 'file' },
          { outputPath: 'missing.md', absolutePath: missing, size: 0, mtime: new Date(), kind: 'file' },
        ],
        new Date('2026-04-18T10:30:00.000Z'),
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      const hint = err instanceof ShardMindError ? err.hint : null;
      expect(hint).toContain('Partial backups could not be restored');
      expect(hint).toContain(`${a}.shardmind-backup-2026-04-18T10-30-00`);
    } finally {
      spy.mockRestore();
    }
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

  it('terminates on cyclic values without stack overflow', () => {
    // YAML anchors can produce cyclic object graphs — e.g.
    //   a: &x
    //     self: *x
    // `yaml.parse` returns a real cycle. Without a cycle guard the
    // recursive walk stack-overflows on hostile input; here we just
    // assert the call returns a string.
    const cyclic: Record<string, unknown> = { name: 'alice' };
    cyclic['self'] = cyclic;
    const hash = hashValues(cyclic);
    expect(typeof hash).toBe('string');
    expect(hash).toHaveLength(64);
  });

  it('produces a stable hash across two cyclic references to the same graph', () => {
    // Two callers producing equivalent cyclic shapes hash to the same
    // value — the cycle-break emits `null` at the recursion point, and
    // null is deterministic.
    const a: Record<string, unknown> = { name: 'alice' };
    a['self'] = a;
    const b: Record<string, unknown> = { name: 'alice' };
    b['self'] = b;
    expect(hashValues(a)).toBe(hashValues(b));
  });

  it('hashes YAML-alias sibling sharing identically to the anchor-free equivalent', () => {
    // YAML `a: &x {k: 1}\nb: *x` resolves to `{a, b}` with both keys
    // pointing at the SAME object reference. The cycle guard must
    // distinguish a real cycle (re-encounter during descent) from a
    // shared-but-non-cyclic sibling (re-encounter AFTER descent
    // finished). Emitting `null` for the second sibling — as a
    // persistent visited-ever set would — silently changes the hash
    // vs. anchor-free YAML, which would produce `values_hash` drift
    // every time a shard author added or removed an anchor.
    const shared = { k: 1 };
    const withAnchor = { a: shared, b: shared };
    const expanded = { a: { k: 1 }, b: { k: 1 } };
    expect(hashValues(withAnchor)).toBe(hashValues(expanded));
  });

  it('distinguishes a real cycle from shared non-cyclic siblings', () => {
    // Guard against the other direction of regression: if descent
    // tracking ever stops firing at all, the cycle case would hash
    // identically to a non-cyclic "just a shared sibling" graph. They
    // are genuinely different shapes.
    const cyclic: Record<string, unknown> = { name: 'a' };
    cyclic['self'] = cyclic;
    const shared = { name: 'a' };
    const nonCyclic = { name: 'a', self: shared };
    expect(hashValues(cyclic)).not.toBe(hashValues(nonCyclic));
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
