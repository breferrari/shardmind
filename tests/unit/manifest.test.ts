import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { parseManifest, ShardManifestSchema, assertEngineCompatible } from '../../source/core/manifest.js';
import type { ShardManifest } from '../../source/runtime/types.js';

// Unique tmp filename per call. `Date.now()` collides under parallel
// vitest workers (two tests within the same millisecond share a path,
// and the second `unlink` throws ENOENT after the first cleans up).
// `randomUUID()` is collision-resistant under cryptographic guarantees.
const tmpYaml = (prefix: string): string =>
  path.join(os.tmpdir(), `${prefix}-${crypto.randomUUID()}.yaml`);

const FIXTURE_DIR = path.resolve('examples/minimal-shard');
const VALID_MANIFEST = path.join(FIXTURE_DIR, '.shardmind', 'shard.yaml');

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
    const tmp = tmpYaml('manifest-test');
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
    const tmp = tmpYaml('manifest-test');
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
    const tmp = tmpYaml('manifest-test');
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
    const tmp = tmpYaml('manifest-test');
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
    const tmp = tmpYaml('manifest-test');
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
    const tmp = tmpYaml('manifest-test');
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
    const tmp = tmpYaml('manifest-test');
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

describe('hooks.timeout_ms validation', () => {
  const base = {
    apiVersion: 'v1' as const,
    name: 'test',
    namespace: 'ns',
    version: '1.0.0',
  };

  it('accepts a valid integer inside 1_000..600_000', () => {
    const parsed = ShardManifestSchema.parse({
      ...base,
      hooks: { 'post-install': 'h.ts', timeout_ms: 60_000 },
    });
    expect(parsed.hooks.timeout_ms).toBe(60_000);
  });

  it('accepts the lower bound (1_000) and the upper bound (600_000)', () => {
    expect(
      ShardManifestSchema.parse({ ...base, hooks: { timeout_ms: 1_000 } }).hooks.timeout_ms,
    ).toBe(1_000);
    expect(
      ShardManifestSchema.parse({ ...base, hooks: { timeout_ms: 600_000 } }).hooks.timeout_ms,
    ).toBe(600_000);
  });

  it('rejects a value below the 1_000 ms floor', () => {
    // Below one second is almost always an authoring bug — even a warm-cache
    // `git init` hits ~50ms but cold runs are ~200ms. Blocking these keeps
    // authors from shipping a shard that flakes on cold-start machines.
    expect(() =>
      ShardManifestSchema.parse({ ...base, hooks: { timeout_ms: 500 } }),
    ).toThrow();
  });

  it('rejects a value above the 600_000 ms ceiling', () => {
    // Anything over ten minutes exceeds any legitimate first-run setup we
    // want to block the install TUI on. Authors who need more should run
    // their work in a background process and return.
    expect(() =>
      ShardManifestSchema.parse({ ...base, hooks: { timeout_ms: 700_000 } }),
    ).toThrow();
  });

  it('rejects a non-integer value', () => {
    expect(() =>
      ShardManifestSchema.parse({ ...base, hooks: { timeout_ms: 1500.5 } }),
    ).toThrow();
  });

  it('rejects a negative value', () => {
    expect(() =>
      ShardManifestSchema.parse({ ...base, hooks: { timeout_ms: -1 } }),
    ).toThrow();
  });

  it('accepts hooks block without timeout_ms (the field is optional)', () => {
    const parsed = ShardManifestSchema.parse({
      ...base,
      hooks: { 'post-install': 'h.ts' },
    });
    expect(parsed.hooks['post-install']).toBe('h.ts');
    expect(parsed.hooks.timeout_ms).toBeUndefined();
  });
});

describe('requires.shardmind parsing (#121)', () => {
  const base = {
    apiVersion: 'v1' as const,
    name: 'test',
    namespace: 'ns',
    version: '1.0.0',
  };

  it('accepts a valid semver range', () => {
    const parsed = ShardManifestSchema.parse({ ...base, requires: { shardmind: '>=0.2.0' } });
    expect(parsed.requires?.shardmind).toBe('>=0.2.0');
  });

  it('accepts caret/tilde and complex ranges', () => {
    expect(ShardManifestSchema.parse({ ...base, requires: { shardmind: '^0.2.0' } }).requires?.shardmind).toBe('^0.2.0');
    expect(ShardManifestSchema.parse({ ...base, requires: { shardmind: '>=0.2 <0.4' } }).requires?.shardmind).toBe('>=0.2 <0.4');
  });

  it('coexists with obsidian and node', () => {
    const parsed = ShardManifestSchema.parse({
      ...base,
      requires: { obsidian: '>=1.5.0', node: '>=22.0.0', shardmind: '>=0.2.0' },
    });
    expect(parsed.requires).toEqual({ obsidian: '>=1.5.0', node: '>=22.0.0', shardmind: '>=0.2.0' });
  });

  it('rejects a garbage range at parse time', async () => {
    const yaml = [
      'apiVersion: v1',
      'name: test',
      'namespace: ns',
      'version: 1.0.0',
      'requires:',
      '  shardmind: "not a range"',
    ].join('\n');
    const tmp = tmpYaml('manifest-test');
    await fs.writeFile(tmp, yaml);
    try {
      const err = await parseManifest(tmp).catch((e) => e);
      expect(err.code).toBe('MANIFEST_VALIDATION_FAILED');
      expect(err.message).toContain('shardmind');
    } finally {
      await fs.unlink(tmp);
    }
  });

  // semver.validRange('') and whitespace-only strings normalize to '*'
  // (match-all). Left unguarded, a declared-but-empty range would parse
  // clean and silently disable the check. Reject at parse time instead.
  it.each(['""', '" "', '"   "'])('rejects an empty/whitespace range %s at parse time', async (val) => {
    const yaml = [
      'apiVersion: v1',
      'name: test',
      'namespace: ns',
      'version: 1.0.0',
      'requires:',
      `  shardmind: ${val}`,
    ].join('\n');
    const tmp = tmpYaml('manifest-test');
    await fs.writeFile(tmp, yaml);
    try {
      const err = await parseManifest(tmp).catch((e) => e);
      expect(err.code).toBe('MANIFEST_VALIDATION_FAILED');
      expect(err.message).toContain('shardmind');
    } finally {
      await fs.unlink(tmp);
    }
  });

  it('accepts a deliberate match-all wildcard (* and x)', () => {
    expect(ShardManifestSchema.parse({ ...base, requires: { shardmind: '*' } }).requires?.shardmind).toBe('*');
    expect(ShardManifestSchema.parse({ ...base, requires: { shardmind: 'x' } }).requires?.shardmind).toBe('x');
  });
});

describe('assertEngineCompatible (#121)', () => {
  const make = (shardmind?: string): ShardManifest =>
    ShardManifestSchema.parse({
      apiVersion: 'v1',
      name: 'test',
      namespace: 'ns',
      version: '1.0.0',
      ...(shardmind ? { requires: { shardmind } } : {}),
    }) as ShardManifest;

  it('passes when the engine satisfies the range', () => {
    expect(() => assertEngineCompatible(make('>=0.2.0'), '0.3.1')).not.toThrow();
  });

  it('passes at the exact lower bound', () => {
    expect(() => assertEngineCompatible(make('>=0.2.0'), '0.2.0')).not.toThrow();
  });

  it('passes when the range requires a lower engine than installed', () => {
    expect(() => assertEngineCompatible(make('>=0.1.0'), '0.9.9')).not.toThrow();
  });

  it('throws SHARDMIND_VERSION_MISMATCH when the engine is too old', () => {
    const err = (() => {
      try {
        assertEngineCompatible(make('>=0.2.0'), '0.1.3');
      } catch (e) {
        return e as { code?: string; message?: string; hint?: string };
      }
    })();
    expect(err?.code).toBe('SHARDMIND_VERSION_MISMATCH');
    expect(err?.message).toContain('>=0.2.0');
    expect(err?.message).toContain('0.1.3');
  });

  it('is a no-op when the manifest declares no requires.shardmind', () => {
    expect(() => assertEngineCompatible(make(), '0.0.1')).not.toThrow();
  });

  it('treats a deliberate match-all (*) range as satisfied by any engine', () => {
    expect(() => assertEngineCompatible(make('*'), '0.0.1')).not.toThrow();
  });

  it('skips the check when the engine version is unknown (undefined)', () => {
    // resolveEngineVersion() returns undefined when the engine cannot locate
    // its own package.json — a bundle-layout quirk must not hard-block a real
    // install. See cli-version.ts PKG_VERSION_FALLBACK.
    expect(() => assertEngineCompatible(make('>=99.0.0'), undefined)).not.toThrow();
  });

  it('skips the check when the engine version is not valid semver', () => {
    expect(() => assertEngineCompatible(make('>=99.0.0'), 'garbage')).not.toThrow();
  });

  it('lets a prerelease engine ahead of the floor satisfy a stable range (includePrerelease)', () => {
    // A prerelease engine *ahead* of the required floor (0.3.0-beta.1 > 0.2.0)
    // must not be blocked. Default semver.satisfies rejects any prerelease
    // against a non-prerelease range; includePrerelease is what allows it.
    expect(() => assertEngineCompatible(make('>=0.2.0'), '0.3.0-beta.1')).not.toThrow();
  });

  it('still blocks a prerelease of the required version (it is genuinely older)', () => {
    // 0.2.0-beta.1 sorts BEFORE the 0.2.0 release, so >=0.2.0 is correctly
    // unsatisfied — even under includePrerelease. Refusing is the right call.
    expect(() => assertEngineCompatible(make('>=0.2.0'), '0.2.0-beta.1')).toThrow();
  });
});

describe('hooks lifecycle slots (#102)', () => {
  const base = {
    apiVersion: 'v1' as const,
    name: 'test',
    namespace: 'ns',
    version: '1.0.0',
  };

  it('normalizes the bare-string bootstrap form into { script }', () => {
    const parsed = ShardManifestSchema.parse({
      ...base,
      hooks: { bootstrap: '.shardmind/hooks/bootstrap.ts' },
    });
    expect(parsed.hooks.bootstrap).toEqual({ script: '.shardmind/hooks/bootstrap.ts' });
  });

  it('accepts the object bootstrap form with a fingerprint', () => {
    const parsed = ShardManifestSchema.parse({
      ...base,
      hooks: { bootstrap: { script: 'b.ts', fingerprint: 'qmd-v1' } },
    });
    expect(parsed.hooks.bootstrap).toEqual({ script: 'b.ts', fingerprint: 'qmd-v1' });
  });

  it('accepts the object bootstrap form without a fingerprint', () => {
    const parsed = ShardManifestSchema.parse({
      ...base,
      hooks: { bootstrap: { script: 'b.ts' } },
    });
    expect(parsed.hooks.bootstrap).toEqual({ script: 'b.ts' });
    expect(parsed.hooks.bootstrap?.fingerprint).toBeUndefined();
  });

  it('parses all three new slots together', () => {
    const parsed = ShardManifestSchema.parse({
      ...base,
      hooks: {
        bootstrap: 'b.ts',
        personalize: 'p.ts',
        'post-update': 'u.ts',
      },
    });
    expect(parsed.hooks.bootstrap).toEqual({ script: 'b.ts' });
    expect(parsed.hooks.personalize).toBe('p.ts');
    expect(parsed.hooks['post-update']).toBe('u.ts');
  });

  it('rejects a bootstrap object missing its script', () => {
    expect(() =>
      ShardManifestSchema.parse({ ...base, hooks: { bootstrap: { fingerprint: 'x' } } }),
    ).toThrow();
  });

  it('throws HOOK_SLOT_CONFLICT when post-install coexists with bootstrap', async () => {
    const yaml = [
      'apiVersion: v1',
      'name: test',
      'namespace: ns',
      'version: 1.0.0',
      'hooks:',
      '  post-install: hooks/post-install.ts',
      '  bootstrap: .shardmind/hooks/bootstrap.ts',
    ].join('\n');
    const tmp = tmpYaml('manifest-test');
    await fs.writeFile(tmp, yaml);
    try {
      const err = await parseManifest(tmp).catch((e) => e);
      expect(err.code).toBe('HOOK_SLOT_CONFLICT');
    } finally {
      await fs.unlink(tmp);
    }
  });

  it('throws HOOK_SLOT_CONFLICT when post-install coexists with personalize', async () => {
    const yaml = [
      'apiVersion: v1',
      'name: test',
      'namespace: ns',
      'version: 1.0.0',
      'hooks:',
      '  post-install: hooks/post-install.ts',
      '  personalize: hooks/personalize.ts',
    ].join('\n');
    const tmp = tmpYaml('manifest-test');
    await fs.writeFile(tmp, yaml);
    try {
      const err = await parseManifest(tmp).catch((e) => e);
      expect(err.code).toBe('HOOK_SLOT_CONFLICT');
    } finally {
      await fs.unlink(tmp);
    }
  });

  it('still accepts a lone legacy post-install (deprecated but valid)', async () => {
    const yaml = [
      'apiVersion: v1',
      'name: test',
      'namespace: ns',
      'version: 1.0.0',
      'hooks:',
      '  post-install: hooks/post-install.ts',
      '  post-update: hooks/post-update.ts',
    ].join('\n');
    const tmp = tmpYaml('manifest-test');
    await fs.writeFile(tmp, yaml);
    try {
      const manifest = await parseManifest(tmp);
      expect(manifest.hooks['post-install']).toBe('hooks/post-install.ts');
      expect(manifest.hooks.bootstrap).toBeUndefined();
    } finally {
      await fs.unlink(tmp);
    }
  });
});
