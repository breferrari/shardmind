import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveVaultRoot, loadState, getIncludedModules } from '../../source/runtime/state.js';
import { loadValues, validateValues } from '../../source/runtime/values.js';
import { loadSchema } from '../../source/runtime/schema.js';
import { validateFrontmatter } from '../../source/runtime/frontmatter.js';
import type { ShardSchema } from '../../source/runtime/types.js';

let mockVault: string;
const originalCwd = process.cwd;

async function createMockVault(): Promise<string> {
  const dir = path.join(os.tmpdir(), `shardmind-vault-${crypto.randomUUID()}`);
  await fs.mkdir(path.join(dir, '.shardmind'), { recursive: true });

  // state.json
  await fs.writeFile(path.join(dir, '.shardmind', 'state.json'), JSON.stringify({
    schema_version: 1,
    shard: 'shardmind/minimal',
    source: 'github:shardmind/minimal',
    version: '0.1.0',
    installed_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
    values_hash: 'abc123',
    modules: { brain: 'included', extras: 'excluded' },
    files: {},
  }));

  // shard-values.yaml
  await fs.writeFile(path.join(dir, 'shard-values.yaml'), [
    'user_name: Alice',
    'org_name: Acme',
    'vault_purpose: engineering',
    'qmd_enabled: false',
  ].join('\n'));

  // shard-schema.yaml
  await fs.writeFile(path.join(dir, '.shardmind', 'shard-schema.yaml'), [
    'schema_version: 1',
    'values:',
    '  user_name:',
    '    type: string',
    '    required: true',
    '    message: "Your name"',
    '    group: setup',
    '  org_name:',
    '    type: string',
    '    message: "Organization"',
    '    default: Independent',
    '    group: setup',
    '  vault_purpose:',
    '    type: select',
    '    required: true',
    '    message: "Purpose"',
    '    options:',
    '      - { value: engineering, label: Engineering }',
    '      - { value: research, label: Research }',
    '    group: setup',
    '  qmd_enabled:',
    '    type: boolean',
    '    message: "Enable QMD?"',
    '    default: false',
    '    group: setup',
    'groups:',
    '  - id: setup',
    '    label: Setup',
    'modules: {}',
    'signals: []',
    'frontmatter:',
    '  global:',
    '    required: [date, tags]',
    '  brain-note:',
    '    required: [date, description]',
    '    path_match: "brain/*.md"',
    'migrations: []',
  ].join('\n'));

  return dir;
}

describe('resolveVaultRoot', () => {
  beforeEach(async () => {
    mockVault = await createMockVault();
    process.cwd = () => mockVault;
  });

  afterEach(async () => {
    process.cwd = originalCwd;
    await fs.rm(mockVault, { recursive: true, force: true });
  });

  it('finds vault root from cwd', () => {
    const root = resolveVaultRoot();
    expect(root).toBe(mockVault);
  });

  it('finds vault root from subdirectory', async () => {
    const subDir = path.join(mockVault, 'brain', 'deep');
    await fs.mkdir(subDir, { recursive: true });
    process.cwd = () => subDir;

    const root = resolveVaultRoot();
    expect(root).toBe(mockVault);
  });

  it('throws when not inside a vault', () => {
    process.cwd = () => os.tmpdir();
    try {
      resolveVaultRoot();
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('VAULT_NOT_FOUND');
    }
  });
});

describe('loadValues', () => {
  beforeEach(async () => {
    mockVault = await createMockVault();
    process.cwd = () => mockVault;
  });

  afterEach(async () => {
    process.cwd = originalCwd;
    await fs.rm(mockVault, { recursive: true, force: true });
  });

  it('reads and parses shard-values.yaml', async () => {
    const values = await loadValues();
    expect(values['user_name']).toBe('Alice');
    expect(values['org_name']).toBe('Acme');
    expect(values['vault_purpose']).toBe('engineering');
    expect(values['qmd_enabled']).toBe(false);
  });
});

describe('loadState', () => {
  beforeEach(async () => {
    mockVault = await createMockVault();
    process.cwd = () => mockVault;
  });

  afterEach(async () => {
    process.cwd = originalCwd;
    await fs.rm(mockVault, { recursive: true, force: true });
  });

  it('reads and parses state.json', async () => {
    const state = await loadState();
    expect(state).not.toBeNull();
    expect(state!.shard).toBe('shardmind/minimal');
    expect(state!.modules['brain']).toBe('included');
    expect(state!.modules['extras']).toBe('excluded');
  });

  it('returns null when state.json is missing', async () => {
    await fs.rm(path.join(mockVault, '.shardmind', 'state.json'));
    const state = await loadState();
    expect(state).toBeNull();
  });
});

describe('loadSchema', () => {
  beforeEach(async () => {
    mockVault = await createMockVault();
    process.cwd = () => mockVault;
  });

  afterEach(async () => {
    process.cwd = originalCwd;
    await fs.rm(mockVault, { recursive: true, force: true });
  });

  it('reads and parses shard-schema.yaml', async () => {
    const schema = await loadSchema();
    expect(schema.schema_version).toBe(1);
    expect(Object.keys(schema.values)).toContain('user_name');
  });
});

describe('getIncludedModules', () => {
  beforeEach(async () => {
    mockVault = await createMockVault();
    process.cwd = () => mockVault;
  });

  afterEach(async () => {
    process.cwd = originalCwd;
    await fs.rm(mockVault, { recursive: true, force: true });
  });

  it('returns only included module IDs', async () => {
    const modules = await getIncludedModules();
    expect(modules).toEqual(['brain']);
  });

  it('returns empty array when state is missing', async () => {
    await fs.rm(path.join(mockVault, '.shardmind', 'state.json'));
    const modules = await getIncludedModules();
    expect(modules).toEqual([]);
  });
});

describe('validateValues', () => {
  let schema: ShardSchema;

  beforeEach(async () => {
    mockVault = await createMockVault();
    process.cwd = () => mockVault;
    schema = await loadSchema();
  });

  afterEach(async () => {
    process.cwd = originalCwd;
    await fs.rm(mockVault, { recursive: true, force: true });
  });

  it('validates correct values', () => {
    const result = validateValues(
      { user_name: 'Alice', vault_purpose: 'engineering' },
      schema,
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects missing required values', () => {
    const result = validateValues({}, schema);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects invalid select values', () => {
    const result = validateValues(
      { user_name: 'Alice', vault_purpose: 'invalid' },
      schema,
    );
    expect(result.valid).toBe(false);
  });
});

describe('validateFrontmatter', () => {
  let schema: ShardSchema;

  beforeEach(async () => {
    mockVault = await createMockVault();
    process.cwd = () => mockVault;
    schema = await loadSchema();
  });

  afterEach(async () => {
    process.cwd = originalCwd;
    await fs.rm(mockVault, { recursive: true, force: true });
  });

  it('validates complete frontmatter', () => {
    const content = '---\ndate: 2026-04-01\ntags:\n  - test\n---\n# Note\n';
    const result = validateFrontmatter('notes/test.md', content, schema);
    expect(result.valid).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  it('detects missing required fields', () => {
    const content = '---\ntitle: Test\n---\n# Note\n';
    const result = validateFrontmatter('notes/test.md', content, schema);
    expect(result.valid).toBe(false);
    expect(result.missing).toContain('date');
    expect(result.missing).toContain('tags');
  });

  it('matches note type by path_match', () => {
    const content = '---\ndate: 2026-04-01\ndescription: Goal\ntags:\n  - brain\n---\n# Goal\n';
    const result = validateFrontmatter('brain/goals.md', content, schema);
    expect(result.noteType).toBe('brain-note');
    expect(result.valid).toBe(true);
  });

  it('returns valid for content without frontmatter', () => {
    const result = validateFrontmatter('README.md', '# README\nNo frontmatter here.\n', schema);
    expect(result.valid).toBe(true);
    expect(result.noteType).toBeNull();
  });
});
