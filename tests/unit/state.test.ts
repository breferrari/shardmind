import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { SHARDMIND_DIR } from '../../source/runtime/vault-paths.js';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  readState,
  writeState,
  initShardDir,
  cacheTemplates,
  cacheManifest,
  rehashManagedFiles,
  snapshotTrackedHashes,
  removeEngineWrites,
  createBackupDir,
} from '../../source/core/state.js';
import type { ShardState, ShardManifest, ShardSchema } from '../../source/runtime/types.js';
import { ShardMindError } from '../../source/runtime/types.js';
import { makeShardSource, makeShardState, makeFileState } from '../helpers/index.js';
import { sha256 } from '../../source/core/fs-utils.js';

function makeState(overrides: Partial<ShardState> = {}): ShardState {
  return {
    schema_version: 2,
    shard: 'breferrari/obsidian-mind',
    source: 'github:breferrari/obsidian-mind',
    version: '3.5.0',
    installed_at: '2026-04-18T00:00:00.000Z',
    updated_at: '2026-04-18T00:00:00.000Z',
    values_hash: 'abc123',
    modules: { core: 'included', research: 'excluded' },
    files: {},
    ...overrides,
  };
}

describe('core/state', () => {
  let vault: string;

  beforeEach(async () => {
    vault = path.join(os.tmpdir(), `shardmind-test-${crypto.randomUUID()}`);
    await fsp.mkdir(vault, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(vault, { recursive: true, force: true });
  });

  describe('readState', () => {
    it('returns null when state.json does not exist', async () => {
      const state = await readState(vault);
      expect(state).toBeNull();
    });

    it('roundtrips a written state', async () => {
      const original = makeState();
      await writeState(vault, original);
      const loaded = await readState(vault);
      expect(loaded).toEqual(original);
    });

    it('throws STATE_CORRUPT on invalid JSON', async () => {
      await fsp.mkdir(path.join(vault, '.shardmind'), { recursive: true });
      await fsp.writeFile(path.join(vault, '.shardmind', 'state.json'), '{not json', 'utf-8');

      await expect(readState(vault)).rejects.toMatchObject({
        code: 'STATE_CORRUPT',
      });
    });

    it('throws STATE_CORRUPT when schema_version is missing', async () => {
      await fsp.mkdir(path.join(vault, '.shardmind'), { recursive: true });
      await fsp.writeFile(
        path.join(vault, '.shardmind', 'state.json'),
        JSON.stringify({ shard: 'foo/bar' }),
        'utf-8',
      );

      await expect(readState(vault)).rejects.toMatchObject({
        code: 'STATE_CORRUPT',
      });
    });

    it('throws STATE_UNSUPPORTED_VERSION when no migration chain reaches the supported version', async () => {
      await fsp.mkdir(path.join(vault, '.shardmind'), { recursive: true });
      await fsp.writeFile(
        path.join(vault, '.shardmind', 'state.json'),
        JSON.stringify(makeState({ schema_version: 99 })),
        'utf-8',
      );

      await expect(readState(vault)).rejects.toMatchObject({
        code: 'STATE_UNSUPPORTED_VERSION',
      });
    });

    it('forward-migrates a v1 state.json to the current schema (#102)', async () => {
      await fsp.mkdir(path.join(vault, '.shardmind'), { recursive: true });
      // A pre-#102 state.json: schema_version 1, no bootstrap_fingerprint.
      const v1 = { ...makeState(), schema_version: 1 };
      await fsp.writeFile(
        path.join(vault, '.shardmind', 'state.json'),
        JSON.stringify(v1),
        'utf-8',
      );

      const state = await readState(vault);
      expect(state).not.toBeNull();
      expect(state!.schema_version).toBe(2);
      expect(state!.bootstrap_fingerprint).toBeUndefined();
      // Content survives the migration.
      expect(state!.shard).toBe('breferrari/obsidian-mind');
    });
  });

  describe('writeState', () => {
    it('creates .shardmind/ if missing', async () => {
      await writeState(vault, makeState());
      const statePath = path.join(vault, '.shardmind', 'state.json');
      await expect(fsp.access(statePath)).resolves.toBeUndefined();
    });

    it('serializes with 2-space indent and trailing newline', async () => {
      await writeState(vault, makeState());
      const raw = await fsp.readFile(path.join(vault, '.shardmind', 'state.json'), 'utf-8');
      expect(raw).toMatch(/\n$/);
      expect(raw).toContain('  "shard":');
    });

    it('rejects unsupported schema_version', async () => {
      await expect(
        writeState(vault, makeState({ schema_version: 99 })),
      ).rejects.toMatchObject({ code: 'STATE_UNSUPPORTED_VERSION' });
    });
  });

  describe('initShardDir', () => {
    it('creates .shardmind/templates/', async () => {
      await initShardDir(vault);
      const templatesPath = path.join(vault, '.shardmind', 'templates');
      const stat = await fsp.stat(templatesPath);
      expect(stat.isDirectory()).toBe(true);
    });

    it('is idempotent', async () => {
      await initShardDir(vault);
      await initShardDir(vault);
      const templatesPath = path.join(vault, '.shardmind', 'templates');
      const stat = await fsp.stat(templatesPath);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe('cacheTemplates', () => {
    async function makeTempShardSource(): Promise<string> {
      return makeShardSource(path.join(os.tmpdir(), `shardmind-src-${crypto.randomUUID()}`));
    }

    it('copies the post-walk source set into .shardmind/templates/', async () => {
      const tempDir = await makeTempShardSource();
      await fsp.mkdir(path.join(tempDir, 'nested'), { recursive: true });
      await fsp.writeFile(path.join(tempDir, 'a.md'), 'hello', 'utf-8');
      await fsp.writeFile(path.join(tempDir, 'nested', 'b.md'), 'world', 'utf-8');

      try {
        await cacheTemplates(vault, tempDir);
        const aContent = await fsp.readFile(
          path.join(vault, '.shardmind', 'templates', 'a.md'),
          'utf-8',
        );
        const bContent = await fsp.readFile(
          path.join(vault, '.shardmind', 'templates', 'nested', 'b.md'),
          'utf-8',
        );
        expect(aContent).toBe('hello');
        expect(bContent).toBe('world');
      } finally {
        await fsp.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('clears existing .shardmind/templates/ before copying', async () => {
      const tempDir = await makeTempShardSource();
      await fsp.writeFile(path.join(tempDir, 'new.md'), 'new', 'utf-8');

      await fsp.mkdir(path.join(vault, '.shardmind', 'templates'), { recursive: true });
      await fsp.writeFile(
        path.join(vault, '.shardmind', 'templates', 'stale.md'),
        'stale',
        'utf-8',
      );

      try {
        await cacheTemplates(vault, tempDir);
        await expect(
          fsp.access(path.join(vault, '.shardmind', 'templates', 'stale.md')),
        ).rejects.toThrow();
      } finally {
        await fsp.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('rides out a Windows hold on the old cache while clearing it (#191)', async () => {
      const tempDir = await makeTempShardSource();
      await fsp.writeFile(path.join(tempDir, 'new.md'), 'new', 'utf-8');
      await fsp.mkdir(path.join(vault, '.shardmind', 'templates'), { recursive: true });
      await fsp.writeFile(path.join(vault, '.shardmind', 'templates', 'stale.md'), 'stale', 'utf-8');
      // The first remove of the old cache fails as a held file makes it fail.
      const realRm = fsp.rm.bind(fsp);
      let held = true;
      vi.spyOn(fsp, 'rm').mockImplementation(async (p, opts) => {
        if (held && String(p).endsWith('templates')) {
          held = false;
          throw Object.assign(new Error('ENOTEMPTY: directory not empty'), { code: 'ENOTEMPTY' });
        }
        return realRm(p, opts);
      });
      try {
        await cacheTemplates(vault, tempDir);
        expect(held).toBe(false);
        await expect(fsp.access(path.join(vault, '.shardmind', 'templates', 'stale.md'))).rejects.toThrow();
        expect(await fsp.readFile(path.join(vault, '.shardmind', 'templates', 'new.md'), 'utf-8')).toBe('new');
      } finally {
        vi.restoreAllMocks();
        await fsp.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('skips Tier 1 paths when caching', async () => {
      const tempDir = await makeTempShardSource();
      await fsp.writeFile(path.join(tempDir, 'keep.md'), 'keep', 'utf-8');
      await fsp.mkdir(path.join(tempDir, '.git'), { recursive: true });
      await fsp.writeFile(path.join(tempDir, '.git', 'HEAD'), 'ref', 'utf-8');

      try {
        await cacheTemplates(vault, tempDir);
        await fsp.access(path.join(vault, '.shardmind', 'templates', 'keep.md'));
        await expect(
          fsp.access(path.join(vault, '.shardmind', 'templates', '.git')),
        ).rejects.toThrow();
        // Source-side .shardmind/ is also Tier 1: never copied to the cache
        // (the installed-side .shardmind/ is written separately).
        await expect(
          fsp.access(path.join(vault, '.shardmind', 'templates', '.shardmind')),
        ).rejects.toThrow();
      } finally {
        await fsp.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('throws STATE_CACHE_MISSING_MANIFEST when .shardmind/shard.yaml is absent', async () => {
      const tempDir = path.join(os.tmpdir(), `shardmind-src-${crypto.randomUUID()}`);
      await fsp.mkdir(tempDir, { recursive: true });
      try {
        await expect(cacheTemplates(vault, tempDir)).rejects.toMatchObject({
          code: 'STATE_CACHE_MISSING_MANIFEST',
        });
      } finally {
        await fsp.rm(tempDir, { recursive: true, force: true });
      }
    });

  });

  describe('cacheManifest', () => {
    it('writes shard.yaml and shard-schema.yaml', async () => {
      const manifest: ShardManifest = {
        apiVersion: 'v1',
        name: 'obsidian-mind',
        namespace: 'breferrari',
        version: '3.5.0',
        dependencies: [],
        hooks: {},
      };
      const schema: ShardSchema = {
        schema_version: 1,
        values: {},
        groups: [],
        modules: {},
        signals: [],
        frontmatter: {},
        migrations: [],
      };

      await cacheManifest(vault, manifest, schema);

      const manifestYaml = await fsp.readFile(
        path.join(vault, '.shardmind', 'shard.yaml'),
        'utf-8',
      );
      const schemaYaml = await fsp.readFile(
        path.join(vault, '.shardmind', 'shard-schema.yaml'),
        'utf-8',
      );

      expect(manifestYaml).toContain('name: obsidian-mind');
      expect(manifestYaml).toContain('namespace: breferrari');
      expect(schemaYaml).toContain('schema_version: 1');
    });

    /**
     * Regression guard for #140. Re-serialising the parsed objects silently
     * discarded every comment and every quoting choice the shard author made —
     * measured on obsidian-mind 7.0.1, shard-schema.yaml lost all 74 of its
     * comment lines. Byte-identity is the assertion, because "contains the
     * right keys" is precisely what the lossy version also satisfied.
     */
    it('copies shard.yaml and shard-schema.yaml verbatim when sourceDir is given', async () => {
      const src = path.join(os.tmpdir(), `shardmind-src-${crypto.randomUUID()}`);
      await fsp.mkdir(path.join(src, '.shardmind'), { recursive: true });

      const manifestSource = [
        '# Leading comment that a YAML round-trip destroys.',
        'apiVersion: v1',
        'name: obsidian-mind',
        'namespace: breferrari',
        'version: "3.5.0" # trailing comment, and a deliberately quoted scalar',
        'dependencies: []',
        'hooks:',
        '  bootstrap:',
        '    script: .shardmind/hooks/bootstrap.ts',
        '    # Bump to force a re-bootstrap on update.',
        '    fingerprint: "qmd-v2"',
        '',
      ].join('\n');
      const schemaSource = [
        '# Schema comments are the only in-file guidance a user gets.',
        'schema_version: 1',
        'values: {}',
        'groups: []',
        'modules: {}',
        'signals: []',
        'frontmatter: {}',
        'migrations: []',
        '',
      ].join('\n');

      await fsp.writeFile(path.join(src, '.shardmind', 'shard.yaml'), manifestSource, 'utf-8');
      await fsp.writeFile(path.join(src, '.shardmind', 'shard-schema.yaml'), schemaSource, 'utf-8');

      // The parsed objects deliberately DISAGREE with the source bytes, so a
      // passing assertion can only come from copying, never from re-serialising.
      const manifest: ShardManifest = {
        apiVersion: 'v1',
        name: 'not-the-source',
        namespace: 'wrong',
        version: '0.0.0',
        dependencies: [],
        hooks: {},
      };
      const schema: ShardSchema = {
        schema_version: 1,
        values: {},
        groups: [],
        modules: {},
        signals: [],
        frontmatter: {},
        migrations: [],
      };

      await cacheManifest(vault, manifest, schema, src);

      const cachedManifest = await fsp.readFile(
        path.join(vault, '.shardmind', 'shard.yaml'),
        'utf-8',
      );
      const cachedSchema = await fsp.readFile(
        path.join(vault, '.shardmind', 'shard-schema.yaml'),
        'utf-8',
      );

      expect(cachedManifest).toBe(manifestSource);
      expect(cachedSchema).toBe(schemaSource);
      // The three things the round-trip specifically ate.
      expect(cachedManifest).toContain('# Leading comment');
      expect(cachedManifest).toContain('fingerprint: "qmd-v2"');
      expect(cachedSchema).toContain('# Schema comments are the only in-file guidance');

      await fsp.rm(src, { recursive: true, force: true });
    });

    it('falls back to serialization when the source files are unreadable', async () => {
      // A directory with no .shardmind/ inside: the copy must fail, and the
      // install must not fail with it.
      const emptySrc = path.join(os.tmpdir(), `shardmind-src-${crypto.randomUUID()}`);
      await fsp.mkdir(emptySrc, { recursive: true });

      const manifest: ShardManifest = {
        apiVersion: 'v1',
        name: 'obsidian-mind',
        namespace: 'breferrari',
        version: '3.5.0',
        dependencies: [],
        hooks: {},
      };
      const schema: ShardSchema = {
        schema_version: 1,
        values: {},
        groups: [],
        modules: {},
        signals: [],
        frontmatter: {},
        migrations: [],
      };

      await expect(cacheManifest(vault, manifest, schema, emptySrc)).resolves.toBeUndefined();

      const manifestYaml = await fsp.readFile(
        path.join(vault, '.shardmind', 'shard.yaml'),
        'utf-8',
      );
      expect(manifestYaml).toContain('name: obsidian-mind');

      await fsp.rm(emptySrc, { recursive: true, force: true });
    });
  });

  describe('errors are ShardMindError instances', () => {
    it('readState STATE_CORRUPT is a ShardMindError', async () => {
      await fsp.mkdir(path.join(vault, '.shardmind'), { recursive: true });
      await fsp.writeFile(path.join(vault, '.shardmind', 'state.json'), '{', 'utf-8');

      await expect(readState(vault)).rejects.toBeInstanceOf(ShardMindError);
    });
  });

  describe('rehashManagedFiles', () => {
    async function writeManagedFile(rel: string, content: string): Promise<string> {
      const abs = path.join(vault, rel);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, content, 'utf-8');
      return sha256(content);
    }

    it('returns the input state unchanged when nothing on disk has shifted', async () => {
      const helloHash = await writeManagedFile('a.md', 'hello');
      const state = makeShardState({
        files: { 'a.md': makeFileState({ rendered_hash: helloHash }) },
      });

      const result = await rehashManagedFiles(vault, state, await snapshotTrackedHashes(vault, state));
      expect(result.changed).toEqual([]);
      expect(result.missing).toEqual([]);
      expect(result.failed).toEqual([]);
      expect(result.state.files['a.md']!.rendered_hash).toBe(helloHash);
    });

    it('updates rendered_hash for the single file a hook modified', async () => {
      const oldHash = await writeManagedFile('brain/Index.md', 'before');
      await writeManagedFile('brain/Static.md', 'static');
      const staticHash = sha256('static');

      const state = makeShardState({
        files: {
          'brain/Index.md': makeFileState({ rendered_hash: oldHash }),
          'brain/Static.md': makeFileState({ rendered_hash: staticHash }),
        },
      });
      const baseline = await snapshotTrackedHashes(vault, state);
      // Simulate a hook editing the file:
      const newHash = await writeManagedFile('brain/Index.md', 'after edit');

      const result = await rehashManagedFiles(vault, state, baseline);
      expect(result.changed).toEqual(['brain/Index.md']);
      expect(result.missing).toEqual([]);
      expect(result.failed).toEqual([]);
      expect(result.state.files['brain/Index.md']!.rendered_hash).toBe(newHash);
      expect(result.state.files['brain/Static.md']!.rendered_hash).toBe(staticHash);
    });

    it('preserves FileState fields (ownership, template, iterator_key) on a rehash', async () => {
      const oldHash = await writeManagedFile('iter.md', 'old');
      const state = makeShardState({
        files: {
          'iter.md': makeFileState({
            rendered_hash: oldHash,
            template: 'iter.md.njk',
            ownership: 'managed',
            iterator_key: 'persona-1',
          }),
        },
      });
      const baseline = await snapshotTrackedHashes(vault, state);
      await writeManagedFile('iter.md', 'new');

      const result = await rehashManagedFiles(vault, state, baseline);
      expect(result.state.files['iter.md']).toMatchObject({
        template: 'iter.md.njk',
        ownership: 'managed',
        iterator_key: 'persona-1',
      });
    });

    it('reports a hook-deleted managed file via `missing` and leaves the prior hash intact', async () => {
      const priorHash = await writeManagedFile('gone.md', 'orig');
      const state = makeShardState({
        files: { 'gone.md': makeFileState({ rendered_hash: priorHash }) },
      });
      const baseline = await snapshotTrackedHashes(vault, state);
      await fsp.unlink(path.join(vault, 'gone.md'));

      const result = await rehashManagedFiles(vault, state, baseline);
      expect(result.missing).toEqual(['gone.md']);
      expect(result.changed).toEqual([]);
      expect(result.state.files['gone.md']!.rendered_hash).toBe(priorHash);
    });

    it('does not report a file that was already missing before the hook phase', async () => {
      const state = makeShardState({
        files: { 'gone.md': makeFileState({ rendered_hash: sha256('orig') }) },
      });
      const baseline = await snapshotTrackedHashes(vault, state);

      const result = await rehashManagedFiles(vault, state, baseline);
      expect(result.missing).toEqual([]);
      expect(result.changed).toEqual([]);
    });

    it('records a tracked file a hook created after it was missing at snapshot time', async () => {
      const state = makeShardState({
        files: { 'restored.md': makeFileState({ rendered_hash: sha256('orig') }) },
      });
      const baseline = await snapshotTrackedHashes(vault, state);
      const newHash = await writeManagedFile('restored.md', 'from hook');

      const result = await rehashManagedFiles(vault, state, baseline);
      expect(result.changed).toEqual(['restored.md']);
      expect(result.state.files['restored.md']!.rendered_hash).toBe(newHash);
    });

    it('ignores files the hook added that are not in state.files (unmanaged)', async () => {
      const aHash = await writeManagedFile('a.md', 'one');
      const state = makeShardState({
        files: { 'a.md': makeFileState({ rendered_hash: aHash }) },
      });
      const baseline = await snapshotTrackedHashes(vault, state);
      // Hook adds an unmanaged file:
      await writeManagedFile('side-effect.md', 'unmanaged content');

      const result = await rehashManagedFiles(vault, state, baseline);
      expect(Object.keys(result.state.files)).toEqual(['a.md']);
      expect(result.changed).toEqual([]);
    });

    it('handles a mixed scenario — modified + deleted + unmanaged-added — in one pass', async () => {
      const aHash = await writeManagedFile('a.md', 'a-old');
      const bHash = await writeManagedFile('b.md', 'b-orig');
      const cHash = await writeManagedFile('c.md', 'c-untouched');
      const state = makeShardState({
        files: {
          'a.md': makeFileState({ rendered_hash: aHash }),
          'b.md': makeFileState({ rendered_hash: bHash }),
          'c.md': makeFileState({ rendered_hash: cHash }),
        },
      });
      const baseline = await snapshotTrackedHashes(vault, state);
      // Hook: modifies a.md, deletes b.md, adds an unmanaged d.md.
      const aNewHash = await writeManagedFile('a.md', 'a-new');
      await fsp.unlink(path.join(vault, 'b.md'));
      await writeManagedFile('d.md', 'd-from-hook');

      const result = await rehashManagedFiles(vault, state, baseline);
      expect(result.changed).toEqual(['a.md']);
      expect(result.missing).toEqual(['b.md']);
      expect(result.failed).toEqual([]);
      expect(result.state.files['a.md']!.rendered_hash).toBe(aNewHash);
      expect(result.state.files['b.md']!.rendered_hash).toBe(bHash);
      expect(result.state.files['c.md']!.rendered_hash).toBe(cHash);
      expect(Object.keys(result.state.files)).toHaveLength(3);
    });

    it('returns input untouched on an empty managed-file set', async () => {
      const state = makeShardState({ files: {} });
      const result = await rehashManagedFiles(vault, state, new Map());
      expect(result).toEqual({ state, changed: [], rebaselined: [], missing: [], failed: [], current: new Map() });
    });

    it('hashes 50 managed files correctly under the concurrency cap', async () => {
      const files: Record<string, ReturnType<typeof makeFileState>> = {};
      for (let i = 0; i < 50; i++) {
        const rel = `f-${i.toString().padStart(3, '0')}.md`;
        files[rel] = makeFileState({ rendered_hash: await writeManagedFile(rel, `before-${i}`) });
      }
      const state = makeShardState({ files });
      const baseline = await snapshotTrackedHashes(vault, state);
      const expected: Record<string, string> = {};
      for (const rel of Object.keys(files)) {
        expected[rel] = await writeManagedFile(rel, `after-${rel}`);
      }

      const result = await rehashManagedFiles(vault, state, baseline);
      expect(result.changed).toHaveLength(50);
      expect(result.missing).toEqual([]);
      expect(result.failed).toEqual([]);
      for (const [rel, hash] of Object.entries(expected)) {
        expect(result.state.files[rel]!.rendered_hash).toBe(hash);
        expect(result.current.get(rel)).toBe(hash);
      }
    });

    // #150: the re-hash recorded every tracked file's current bytes, so a
    // user's pre-update edit became the baseline and the next update read
    // it as engine-owned and overwrote it.
    it('does not re-baseline a file the user edited before the hook phase', async () => {
      const engineHash = sha256('engine render');
      await writeManagedFile('mine.md', 'the user edit');
      const state = makeShardState({
        files: { 'mine.md': makeFileState({ rendered_hash: engineHash, ownership: 'modified' }) },
      });

      const result = await rehashManagedFiles(vault, state, await snapshotTrackedHashes(vault, state));
      expect(result.changed).toEqual([]);
      expect(result.state.files['mine.md']!.rendered_hash).toBe(engineHash);
    });

    it('does not re-baseline a user-edited file even when a hook rewrites it', async () => {
      const engineHash = sha256('engine render');
      await writeManagedFile('mine.md', 'the user edit');
      const state = makeShardState({
        files: { 'mine.md': makeFileState({ rendered_hash: engineHash, ownership: 'modified' }) },
      });
      const baseline = await snapshotTrackedHashes(vault, state);
      await writeManagedFile('mine.md', 'the user edit + a hook line');

      const result = await rehashManagedFiles(vault, state, baseline);
      // Reported as a hook write (bootstrap's boundary check needs it) …
      expect(result.changed).toEqual(['mine.md']);
      // … but the engine's baseline stands.
      expect(result.state.files['mine.md']!.rendered_hash).toBe(engineHash);
    });

    // A path that could not be READ at snapshot time (EBUSY, EACCES, a
    // directory in the way) is not a path that was absent: it may hold the
    // user's edit, so it is never re-baselined. Simulated with a directory,
    // which fails the read on every platform.
    it('does not re-baseline a file that was unreadable at snapshot time', async () => {
      const engineHash = sha256('engine render');
      await fsp.mkdir(path.join(vault, 'locked.md'));
      const state = makeShardState({
        files: { 'locked.md': makeFileState({ rendered_hash: engineHash, ownership: 'modified' }) },
      });
      const baseline = await snapshotTrackedHashes(vault, state);
      await fsp.rmdir(path.join(vault, 'locked.md'));
      await writeManagedFile('locked.md', 'the user edit');

      const result = await rehashManagedFiles(vault, state, baseline);
      expect(result.changed).toEqual([]);
      expect(result.state.files['locked.md']!.rendered_hash).toBe(engineHash);
    });

    // Permission-denied / EACCES — POSIX only. Windows lacks meaningful
    // chmod for read-bit removal, and the unprivileged tests run as root
    // on some CI images (which can read 000 files anyway). This test is
    // skipped on those paths.
    const isPosixUnprivileged =
      process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;

    it.skipIf(!isPosixUnprivileged)(
      'reports an EACCES read failure via `failed` and keeps the prior hash',
      async () => {
        const priorHash = await writeManagedFile('locked.md', 'sealed');
        const abs = path.join(vault, 'locked.md');
        const state = makeShardState({
          files: { 'locked.md': makeFileState({ rendered_hash: priorHash }) },
        });
        const baseline = await snapshotTrackedHashes(vault, state);
        await fsp.chmod(abs, 0o000);
        try {
          const result = await rehashManagedFiles(vault, state, baseline);
          expect(result.failed).toHaveLength(1);
          expect(result.failed[0]!.path).toBe('locked.md');
          expect(result.changed).toEqual([]);
          expect(result.missing).toEqual([]);
          expect(result.state.files['locked.md']!.rendered_hash).toBe(priorHash);
        } finally {
          // Restore permissions so afterEach's rm can clean up.
          await fsp.chmod(abs, 0o644);
        }
      },
    );
  });
});

describe('removeEngineWrites (#215, #243)', () => {
  let vault: string;
  beforeEach(async () => {
    vault = path.join(os.tmpdir(), `engine-writes-${crypto.randomUUID()}`);
    const sm = path.join(vault, '.shardmind');
    await fsp.mkdir(path.join(sm, 'templates', 'brain'), { recursive: true });
    await fsp.writeFile(path.join(sm, 'templates', 'brain', 'a.md'), 'x');
    for (const f of ['state.json', 'shard.yaml', 'shard-schema.yaml']) await fsp.writeFile(path.join(sm, f), 'x');
    await fsp.writeFile(path.join(sm, 'boundary-ignore'), 'archive/\n');
  });
  afterEach(async () => {
    await fsp.rm(vault, { recursive: true, force: true });
  });

  it("removes the engine's entries and keeps the owner's, and the folder holding them", async () => {
    expect(await removeEngineWrites(vault, { removeEmptyDir: true })).toEqual([]);
    expect(await fsp.readdir(path.join(vault, '.shardmind'))).toEqual(['boundary-ignore']);
  });

  it("leaves an empty backups/ alone without a snapshot: it isn't this run's", async () => {
    await fsp.mkdir(path.join(vault, '.shardmind', 'backups'));
    await removeEngineWrites(vault, { removeEmptyDir: false });
    expect((await fsp.readdir(path.join(vault, '.shardmind'))).sort()).toEqual(['backups', 'boundary-ignore']);
  });

  it('removes the run snapshot, then backups/ and the folder once empty', async () => {
    await fsp.rm(path.join(vault, '.shardmind', 'boundary-ignore'));
    const snapshot = path.join(vault, '.shardmind', 'backups', 'adopt-1');
    await fsp.mkdir(path.join(snapshot, 'files'), { recursive: true });
    expect(await removeEngineWrites(vault, { snapshotDir: snapshot, removeEmptyDir: true })).toEqual([]);
    await expect(fsp.access(path.join(vault, '.shardmind'))).rejects.toThrow();
  });
});

describe('createBackupDir (#248)', () => {
  let vault: string;
  beforeEach(() => {
    vault = path.join(os.tmpdir(), `backup-dir-${crypto.randomUUID()}`);
  });
  afterEach(async () => {
    await fsp.rm(vault, { recursive: true, force: true });
  });

  it('gives two adopts in the same instant their own folders, the second suffixed', async () => {
    const now = new Date('2026-10-04T12:00:00.123Z');
    const a = await createBackupDir(vault, now, 'adopt');
    const b = await createBackupDir(vault, now, 'adopt');
    expect(path.basename(a)).toBe('adopt-2026-10-04T12-00-00-123');
    expect(path.basename(b)).toBe('adopt-2026-10-04T12-00-00-123-1');
  });

  it("throws the kind's write error, not a raw errno, when the folder cannot be made", async () => {
    // A file where .shardmind/ should be.
    await fsp.mkdir(vault, { recursive: true });
    await fsp.writeFile(path.join(vault, '.shardmind'), 'not a folder');
    await expect(createBackupDir(vault, new Date(), 'adopt')).rejects.toMatchObject({ code: 'ADOPT_WRITE_FAILED' });
  });

  it('wraps a failure creating the folder itself, such as EACCES', async () => {
    const realMkdir = fsp.mkdir;
    const spy = vi.spyOn(fsp, 'mkdir').mockImplementation((async (p: string, opts?: { recursive?: boolean }) => {
      if (opts?.recursive === false) throw Object.assign(new Error('simulated EACCES'), { code: 'EACCES' });
      return realMkdir(p, opts);
    }) as typeof fsp.mkdir);
    try {
      await expect(createBackupDir(vault, new Date(), 'adopt')).rejects.toMatchObject({
        code: 'ADOPT_WRITE_FAILED',
        message: expect.stringMatching(/simulated EACCES/),
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('stops when the name keeps reporting ENOENT after its parents were made', async () => {
    const realMkdir = fsp.mkdir;
    const spy = vi.spyOn(fsp, 'mkdir').mockImplementation((async (p: string, opts?: { recursive?: boolean }) => {
      if (opts?.recursive === false) throw Object.assign(new Error('simulated ENOENT'), { code: 'ENOENT' });
      return realMkdir(p, opts);
    }) as typeof fsp.mkdir);
    try {
      await expect(createBackupDir(vault, new Date(), 'update')).rejects.toMatchObject({ code: 'UPDATE_WRITE_FAILED' });
      // Once for the name, once for the parents, once more for the name.
      expect(spy.mock.calls.filter(([, o]) => (o as { recursive?: boolean })?.recursive === false)).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('removes the folders it made on the way when it cannot create the snapshot folder (#269)', async () => {
    await fsp.mkdir(vault, { recursive: true });
    const realMkdir = fsp.mkdir;
    let exclusive = 0;
    const spy = vi.spyOn(fsp, 'mkdir').mockImplementation((async (p: string, opts?: { recursive?: boolean }) => {
      // The first try finds no parents (ENOENT), they are made, and the
      // second, the snapshot folder itself, fails.
      if (opts?.recursive === false && ++exclusive === 2) {
        throw Object.assign(new Error('simulated EACCES'), { code: 'EACCES' });
      }
      return realMkdir(p, opts);
    }) as typeof fsp.mkdir);
    try {
      await expect(createBackupDir(vault, new Date(), 'adopt')).rejects.toMatchObject({ code: 'ADOPT_WRITE_FAILED' });
    } finally {
      spy.mockRestore();
    }
    expect(await fsp.readdir(vault)).toEqual([]);
  });

  it("keeps a .shardmind/ that was there when it cannot create the snapshot folder (#269)", async () => {
    await fsp.mkdir(path.join(vault, '.shardmind'), { recursive: true });
    await fsp.writeFile(path.join(vault, '.shardmind', 'boundary-ignore'), 'archive/\n');
    const realMkdir = fsp.mkdir;
    let exclusive = 0;
    const spy = vi.spyOn(fsp, 'mkdir').mockImplementation((async (p: string, opts?: { recursive?: boolean }) => {
      // The first try finds no parents (ENOENT), they are made, and the
      // second, the snapshot folder itself, fails.
      if (opts?.recursive === false && ++exclusive === 2) {
        throw Object.assign(new Error('simulated EACCES'), { code: 'EACCES' });
      }
      return realMkdir(p, opts);
    }) as typeof fsp.mkdir);
    try {
      await expect(createBackupDir(vault, new Date(), 'update')).rejects.toMatchObject({ code: 'UPDATE_WRITE_FAILED' });
    } finally {
      spy.mockRestore();
    }
    // backups/ was made on the way and goes; .shardmind/ and the user's file stay.
    expect(await fsp.readdir(path.join(vault, '.shardmind'))).toEqual(['boundary-ignore']);
  });

  it('never reuses a folder that is already there, even an empty one', async () => {
    const now = new Date('2026-10-04T12:00:00.000Z');
    const taken = path.join(vault, '.shardmind', 'backups', 'adopt-2026-10-04T12-00-00-000');
    await fsp.mkdir(taken, { recursive: true });
    expect(await createBackupDir(vault, now, 'adopt')).toBe(`${taken}-1`);
  });
});

describe('createBackupDir — concurrency and clock edge cases', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'update-backup-'));
    // Seed .shardmind/ so createBackupDir can write under it.
    await fsp.mkdir(path.join(tempRoot, SHARDMIND_DIR), { recursive: true });
  });
  afterEach(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  it('allocates distinct directories when called twice at the exact same instant', async () => {
    const frozen = new Date('2026-04-20T10:30:45.123Z');
    const a = await createBackupDir(tempRoot, frozen, 'update');
    const b = await createBackupDir(tempRoot, frozen, 'update');
    expect(a).not.toBe(b);
    const statA = await fsp.stat(a);
    const statB = await fsp.stat(b);
    expect(statA.isDirectory()).toBe(true);
    expect(statB.isDirectory()).toBe(true);
  });

  it('the second call lands under -1 when the first took the un-suffixed name', async () => {
    const frozen = new Date('2026-04-20T10:30:45.999Z');
    const a = await createBackupDir(tempRoot, frozen, 'update');
    const b = await createBackupDir(tempRoot, frozen, 'update');
    expect(path.basename(b)).toMatch(/-1$/);
    expect(a).not.toBe(b);
  });
});
