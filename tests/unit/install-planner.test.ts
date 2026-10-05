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
  staleOutputs,
  detectStale,
  stillFiles,
} from '../../source/core/install-planner.js';
import { sha256 } from '../../source/core/fs-utils.js';
import { makeShardState } from '../helpers/shard-state.js';
import { carryOverBackups, discardSetAside, carryOverUserEntries } from '../../source/core/vault-transaction.js';
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

  it('keeps an old backup whose name is taken under a new name, not dropping it', async () => {
    const old = path.join(vault, 'old-state');
    await fsp.mkdir(path.join(old, 'backups', 'update-1'), { recursive: true });
    await fsp.writeFile(path.join(old, 'backups', 'update-1', 'old.md'), 'old copy');
    await fsp.mkdir(path.join(vault, '.shardmind', 'backups', 'update-1'), { recursive: true });
    await carryOverBackups(old, vault);
    const names = await fsp.readdir(path.join(vault, '.shardmind', 'backups'));
    expect(names.sort()).toEqual(['update-1', 'update-1-1']);
    expect(await fsp.readFile(path.join(vault, '.shardmind', 'backups', 'update-1-1', 'old.md'), 'utf-8')).toBe('old copy');
  });

  it('does nothing when the old state dir has no backups', async () => {
    const old = path.join(vault, 'old-state');
    await fsp.mkdir(old, { recursive: true });
    await carryOverBackups(old, vault);
    await expect(fsp.stat(path.join(vault, '.shardmind', 'backups'))).rejects.toThrow();
  });
});

describe('discardSetAside', () => {
  let vault: string;

  beforeEach(async () => {
    vault = path.join(os.tmpdir(), `shardmind-discard-${crypto.randomUUID()}`);
    await fsp.mkdir(vault, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(vault, { recursive: true, force: true });
  });

  it("deletes what was set aside after carrying the old state's backups over (#55)", async () => {
    const oldState = path.join(vault, '.shardmind.shardmind-backup-x');
    await fsp.mkdir(path.join(oldState, 'backups', 'adopt-1'), { recursive: true });
    const note = path.join(vault, 'Home.md.shardmind-backup-x');
    await fsp.writeFile(note, 'replaced');
    const stateRecord = { originalPath: path.join(vault, '.shardmind'), backupPath: oldState };
    await discardSetAside([stateRecord, { originalPath: path.join(vault, 'Home.md'), backupPath: note }], stateRecord.originalPath, vault);
    await expect(fsp.stat(oldState)).rejects.toThrow();
    await expect(fsp.stat(note)).rejects.toThrow();
    expect((await fsp.stat(path.join(vault, '.shardmind', 'backups', 'adopt-1'))).isDirectory()).toBe(true);
  });

  it('returns each set-aside copy it could not delete, so it is never reported as removed (#228)', async () => {
    const note = path.join(vault, 'Old.md.shardmind-backup-x');
    await fsp.writeFile(note, 'stale');
    const realRm = fsp.rm;
    const spy = vi.spyOn(fsp, 'rm').mockImplementation(async (p, opts) => {
      if (p === note) throw Object.assign(new Error('simulated EBUSY'), { code: 'EBUSY' });
      return realRm(p, opts);
    });
    const record = { originalPath: path.join(vault, 'Old.md'), backupPath: note };
    try {
      expect(await discardSetAside([record], undefined, vault)).toEqual([record]);
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps the old state aside when its backups cannot be carried over, and never throws', async () => {
    const oldState = path.join(vault, '.shardmind.shardmind-backup-x');
    await fsp.mkdir(path.join(oldState, 'backups', 'adopt-1'), { recursive: true });
    // A file where the new backups/ dir must go makes the carry-over fail.
    await fsp.mkdir(path.join(vault, '.shardmind'), { recursive: true });
    await fsp.writeFile(path.join(vault, '.shardmind', 'backups'), 'in the way');
    const stateRecord = { originalPath: path.join(vault, '.shardmind'), backupPath: oldState };
    await discardSetAside([stateRecord], stateRecord.originalPath, vault);
    expect((await fsp.stat(path.join(oldState, 'backups', 'adopt-1'))).isDirectory()).toBe(true);
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

describe('carryOverUserEntries (#237)', () => {
  let root: string;
  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'carry-own-'));
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  async function setUp(oldEntries: Record<string, string>, newEntries: Record<string, string> = {}) {
    const old = path.join(root, '.shardmind.shardmind-backup-x');
    const vault = path.join(root, 'vault');
    for (const [dir, entries] of [[old, oldEntries], [path.join(vault, '.shardmind'), newEntries]] as const) {
      for (const [rel, content] of Object.entries(entries)) {
        await fsp.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
        await fsp.writeFile(path.join(dir, rel), content);
      }
    }
    return { old, vault };
  }

  it("moves the owner's entries and leaves every engine entry behind", async () => {
    const { old, vault } = await setUp({
      'boundary-ignore': 'archive/\n',
      'notes/why.md': 'mine\n',
      'state.json': '{}',
      'update-check.json': '{}',
      'templates/a.md': 'x',
      'Logs/bootstrap.log': 'engine log, user-cased folder',
    });
    await carryOverUserEntries(old, vault);
    expect((await fsp.readdir(path.join(vault, '.shardmind'))).sort()).toEqual(['boundary-ignore', 'notes']);
    expect((await fsp.readdir(old)).sort()).toEqual(['Logs', 'state.json', 'templates', 'update-check.json']);
  });

  it('keeps both when the new folder already has the name', async () => {
    const { old, vault } = await setUp({ 'boundary-ignore': 'old\n' }, { 'boundary-ignore': 'new\n' });
    await carryOverUserEntries(old, vault);
    const sm = path.join(vault, '.shardmind');
    expect(await fsp.readFile(path.join(sm, 'boundary-ignore'), 'utf-8')).toBe('new\n');
    expect(await fsp.readFile(path.join(sm, 'boundary-ignore-1'), 'utf-8')).toBe('old\n');
  });
});

describe('staleOutputs (#228)', () => {
  const file = { template: null, rendered_hash: 'h', ownership: 'managed' as const };

  it('lists the previous files no planned output names, and nothing without a previous install', () => {
    const previous = makeShardState({
      files: { 'Home.md': file, 'people/alice.md': file, 'people/bob.md': file },
    });
    expect(staleOutputs(previous, ['Home.md', 'people/alice.md'])).toEqual(['people/bob.md']);
    expect(staleOutputs(null, ['Home.md'])).toEqual([]);
  });

  it('compares exactly: a case-only rename leaves the old spelling stale', () => {
    // A different file on a case-sensitive filesystem; on a case-folding
    // one the vault path guard refuses the install before this runs.
    const previous = makeShardState({ files: { 'Notes/Home.md': file } });
    expect(staleOutputs(previous, ['notes/home.md'])).toEqual(['Notes/Home.md']);
  });

  it('never returns a key that would leave the vault', () => {
    const previous = makeShardState({
      files: { '../outside.md': file, 'a/../../b.md': file, '/etc/x.md': file, 'C:\\x.md': file, 'ok.md': file },
    });
    expect(staleOutputs(previous, [])).toEqual(['ok.md']);
  });
});

describe('detectStale and stillFiles (#228)', () => {
  let vault: string;
  beforeEach(async () => {
    vault = await fsp.mkdtemp(path.join(os.tmpdir(), 'stale-'));
  });
  afterEach(async () => {
    await fsp.rm(vault, { recursive: true, force: true });
  });

  it('skips a stale path it cannot check, and one that is gone', async () => {
    await fsp.writeFile(path.join(vault, 'Archive'), 'a file where a folder was');
    await fsp.writeFile(path.join(vault, 'kept.md'), 'x');
    await fsp.writeFile(path.join(vault, 'locked.md'), 'x');
    // ENOTDIR through a file is ENOENT on Windows; EACCES is the same on all.
    const realStat = fsp.stat;
    const spy = vi.spyOn(fsp, 'stat').mockImplementation((async (p: string, o?: unknown) => {
      if (p === path.join(vault, 'locked.md')) throw Object.assign(new Error('simulated EACCES'), { code: 'EACCES' });
      return (realStat as (p: string, o?: unknown) => Promise<unknown>)(p, o);
    }) as typeof fsp.stat);
    try {
      const found = await detectStale(vault, ['Archive/x.md', 'gone.md', 'locked.md', 'kept.md']);
      expect(found.map((c) => c.outputPath)).toEqual(['kept.md']);
    } finally {
      spy.mockRestore();
    }
  });

  it('stillFiles keeps only paths that are plain files now', async () => {
    await fsp.writeFile(path.join(vault, 'a.md'), 'x');
    await fsp.mkdir(path.join(vault, 'b.md'));
    const collisions = ['a.md', 'b.md', 'c.md'].map((rel) => ({
      outputPath: rel,
      absolutePath: path.join(vault, rel),
      kind: 'file' as const,
    }));
    expect(await stillFiles(vault, collisions as never)).toEqual(['a.md']);
  });
});
