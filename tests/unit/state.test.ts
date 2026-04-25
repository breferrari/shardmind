import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
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
} from '../../source/core/state.js';
import type { ShardState, ShardManifest, ShardSchema } from '../../source/runtime/types.js';
import { ShardMindError } from '../../source/runtime/types.js';
import { makeShardSource, makeShardState, makeFileState } from '../helpers/index.js';
import { sha256 } from '../../source/core/fs-utils.js';

function makeState(overrides: Partial<ShardState> = {}): ShardState {
  return {
    schema_version: 1,
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

    it('throws STATE_UNSUPPORTED_VERSION when schema_version differs from supported', async () => {
      await fsp.mkdir(path.join(vault, '.shardmind'), { recursive: true });
      await fsp.writeFile(
        path.join(vault, '.shardmind', 'state.json'),
        JSON.stringify(makeState({ schema_version: 2 })),
        'utf-8',
      );

      await expect(readState(vault)).rejects.toMatchObject({
        code: 'STATE_UNSUPPORTED_VERSION',
      });
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

      const result = await rehashManagedFiles(vault, state);
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
      // Simulate a hook editing the file:
      const newHash = await writeManagedFile('brain/Index.md', 'after edit');

      const result = await rehashManagedFiles(vault, state);
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
      await writeManagedFile('iter.md', 'new');

      const result = await rehashManagedFiles(vault, state);
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
      await fsp.unlink(path.join(vault, 'gone.md'));

      const result = await rehashManagedFiles(vault, state);
      expect(result.missing).toEqual(['gone.md']);
      expect(result.changed).toEqual([]);
      expect(result.state.files['gone.md']!.rendered_hash).toBe(priorHash);
    });

    it('ignores files the hook added that are not in state.files (unmanaged)', async () => {
      const aHash = await writeManagedFile('a.md', 'one');
      // Hook adds an unmanaged file:
      await writeManagedFile('side-effect.md', 'unmanaged content');

      const state = makeShardState({
        files: { 'a.md': makeFileState({ rendered_hash: aHash }) },
      });
      const result = await rehashManagedFiles(vault, state);
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
      // Hook: modifies a.md, deletes b.md, adds an unmanaged d.md.
      const aNewHash = await writeManagedFile('a.md', 'a-new');
      await fsp.unlink(path.join(vault, 'b.md'));
      await writeManagedFile('d.md', 'd-from-hook');

      const result = await rehashManagedFiles(vault, state);
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
      const result = await rehashManagedFiles(vault, state);
      expect(result).toEqual({ state, changed: [], missing: [], failed: [] });
    });

    it('hashes 50 managed files correctly under the concurrency cap', async () => {
      const files: Record<string, ReturnType<typeof makeFileState>> = {};
      const expected: Record<string, string> = {};
      for (let i = 0; i < 50; i++) {
        const rel = `f-${i.toString().padStart(3, '0')}.md`;
        const hash = await writeManagedFile(rel, `content-${i}`);
        // Seed state with stale hashes so changed[] surfaces every entry.
        files[rel] = makeFileState({ rendered_hash: 'stale' });
        expected[rel] = hash;
      }
      const state = makeShardState({ files });
      const result = await rehashManagedFiles(vault, state);
      expect(result.changed).toHaveLength(50);
      expect(result.missing).toEqual([]);
      expect(result.failed).toEqual([]);
      for (const [rel, hash] of Object.entries(expected)) {
        expect(result.state.files[rel]!.rendered_hash).toBe(hash);
      }
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
        await fsp.chmod(abs, 0o000);
        try {
          const state = makeShardState({
            files: { 'locked.md': makeFileState({ rendered_hash: priorHash }) },
          });
          const result = await rehashManagedFiles(vault, state);
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
