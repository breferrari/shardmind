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
} from '../../source/core/state.js';
import type { ShardState, ShardManifest, ShardSchema } from '../../source/runtime/types.js';
import { ShardMindError } from '../../source/runtime/types.js';

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
    it('copies templates/ from temp to .shardmind/templates/', async () => {
      const tempDir = path.join(os.tmpdir(), `shardmind-src-${crypto.randomUUID()}`);
      await fsp.mkdir(path.join(tempDir, 'templates', 'nested'), { recursive: true });
      await fsp.writeFile(path.join(tempDir, 'templates', 'a.md'), 'hello', 'utf-8');
      await fsp.writeFile(path.join(tempDir, 'templates', 'nested', 'b.md'), 'world', 'utf-8');

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
      const tempDir = path.join(os.tmpdir(), `shardmind-src-${crypto.randomUUID()}`);
      await fsp.mkdir(path.join(tempDir, 'templates'), { recursive: true });
      await fsp.writeFile(path.join(tempDir, 'templates', 'new.md'), 'new', 'utf-8');

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

    it('throws when source templates/ is missing', async () => {
      const tempDir = path.join(os.tmpdir(), `shardmind-empty-${crypto.randomUUID()}`);
      await fsp.mkdir(tempDir, { recursive: true });

      try {
        await expect(cacheTemplates(vault, tempDir)).rejects.toMatchObject({
          code: 'STATE_CACHE_MISSING_TEMPLATES',
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
});
