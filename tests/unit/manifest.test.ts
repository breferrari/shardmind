import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { describe, it, expect } from 'vitest';
import { parseManifest, ShardManifestSchema } from '../../source/core/manifest.js';

const FIXTURE_DIR = path.resolve('examples/minimal-shard');
const VALID_MANIFEST = path.join(FIXTURE_DIR, 'shard.yaml');

describe('parseManifest', () => {
  it('parses valid shard.yaml from minimal-shard fixture', async () => {
    const manifest = await parseManifest(VALID_MANIFEST);
    expect(manifest.apiVersion).toBe('v1');
    expect(manifest.name).toBe('minimal');
    expect(manifest.namespace).toBe('shardmind');
    expect(manifest.version).toBe('0.1.0');
    expect(manifest.description).toBe('Minimal shard for development and testing');
    expect(manifest.persona).toBe('Developers testing ShardMind');
    expect(manifest.license).toBe('MIT');
    expect(manifest.homepage).toBe('https://github.com/breferrari/shardmind');
    expect(manifest.requires).toEqual({ node: '>=18.0.0' });
    expect(manifest.hooks).toEqual({ 'post-install': 'hooks/post-install.ts' });
  });

  it('defaults dependencies to [] and hooks to {} when omitted', async () => {
    const yaml = `apiVersion: v1\nname: test\nnamespace: dev\nversion: 1.0.0`;
    const tmp = path.join(os.tmpdir(), `manifest-test-${Date.now()}.yaml`);
    await fs.writeFile(tmp, yaml);
    try {
      const manifest = await parseManifest(tmp);
      expect(manifest.dependencies).toEqual([]);
      expect(manifest.hooks).toEqual({});
    } finally {
      await fs.unlink(tmp);
    }
  });

  it('parses manifest with all optional fields including dependencies', async () => {
    const yaml = [
      'apiVersion: v1',
      'name: full-shard',
      'namespace: acme',
      'version: 2.3.1',
      'description: Full example',
      'persona: Engineers',
      'license: MIT',
      'homepage: https://example.com',
      'requires:',
      '  obsidian: ">=1.12.0"',
      '  node: ">=18.0.0"',
      'dependencies:',
      '  - name: skills',
      '    namespace: kepano',
      '    version: "^1.0.0"',
      'hooks:',
      '  post-install: hooks/post-install.ts',
      '  post-update: hooks/post-update.ts',
    ].join('\n');
    const tmp = path.join(os.tmpdir(), `manifest-test-${Date.now()}.yaml`);
    await fs.writeFile(tmp, yaml);
    try {
      const manifest = await parseManifest(tmp);
      expect(manifest.dependencies).toHaveLength(1);
      expect(manifest.dependencies[0]).toEqual({ name: 'skills', namespace: 'kepano', version: '^1.0.0' });
      expect(manifest.hooks['post-install']).toBe('hooks/post-install.ts');
      expect(manifest.hooks['post-update']).toBe('hooks/post-update.ts');
    } finally {
      await fs.unlink(tmp);
    }
  });

  it('rejects non-existent file', async () => {
    const err = await parseManifest('/no/such/file.yaml').catch(e => e);
    expect(err.code).toBe('MANIFEST_NOT_FOUND');
  });

  it('rejects invalid YAML syntax', async () => {
    const tmp = path.join(os.tmpdir(), `manifest-test-${Date.now()}.yaml`);
    await fs.writeFile(tmp, ':\n  bad:\n    - [\ninvalid');
    try {
      const err = await parseManifest(tmp).catch(e => e);
      expect(err.code).toBe('MANIFEST_INVALID_YAML');
    } finally {
      await fs.unlink(tmp);
    }
  });

  it('rejects missing required field (apiVersion)', async () => {
    const yaml = `name: test\nnamespace: dev\nversion: 1.0.0`;
    const tmp = path.join(os.tmpdir(), `manifest-test-${Date.now()}.yaml`);
    await fs.writeFile(tmp, yaml);
    try {
      const err = await parseManifest(tmp).catch(e => e);
      expect(err.code).toBe('MANIFEST_VALIDATION_FAILED');
      expect(err.message).toContain('apiVersion');
    } finally {
      await fs.unlink(tmp);
    }
  });

  it('rejects invalid semver version', async () => {
    const yaml = `apiVersion: v1\nname: test\nnamespace: dev\nversion: not-a-version`;
    const tmp = path.join(os.tmpdir(), `manifest-test-${Date.now()}.yaml`);
    await fs.writeFile(tmp, yaml);
    try {
      const err = await parseManifest(tmp).catch(e => e);
      expect(err.code).toBe('MANIFEST_VALIDATION_FAILED');
      expect(err.message).toContain('version');
    } finally {
      await fs.unlink(tmp);
    }
  });

  it('rejects name with uppercase letters', async () => {
    const yaml = `apiVersion: v1\nname: BadName\nnamespace: dev\nversion: 1.0.0`;
    const tmp = path.join(os.tmpdir(), `manifest-test-${Date.now()}.yaml`);
    await fs.writeFile(tmp, yaml);
    try {
      const err = await parseManifest(tmp).catch(e => e);
      expect(err.code).toBe('MANIFEST_VALIDATION_FAILED');
      expect(err.message).toContain('name');
    } finally {
      await fs.unlink(tmp);
    }
  });

  it('rejects namespace with spaces', async () => {
    const yaml = `apiVersion: v1\nname: test\nnamespace: "bad space"\nversion: 1.0.0`;
    const tmp = path.join(os.tmpdir(), `manifest-test-${Date.now()}.yaml`);
    await fs.writeFile(tmp, yaml);
    try {
      const err = await parseManifest(tmp).catch(e => e);
      expect(err.code).toBe('MANIFEST_VALIDATION_FAILED');
      expect(err.message).toContain('namespace');
    } finally {
      await fs.unlink(tmp);
    }
  });
});

describe('ShardManifestSchema', () => {
  it('is exported for reuse', () => {
    expect(ShardManifestSchema).toBeDefined();
    expect(ShardManifestSchema.parse).toBeTypeOf('function');
  });
});
