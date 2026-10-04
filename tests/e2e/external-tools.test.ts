/**
 * External tools through the built CLI (#138), on all three OSes. A tool is
 * a script on a PATH the test controls: a `.cmd` shim on Windows (read
 * through cmd.exe, as npm installs one), an executable script elsewhere.
 * The tool leaves a marker each time it runs, so a dry run and `validate`
 * can be shown never to run it.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGitHubStub, type GitHubStub } from './helpers/github-stub.js';
import { ensureBuilt } from './helpers/build-once.js';
import { spawnCli } from './helpers/spawn-cli.js';
import { buildMutatedShard } from './tui/helpers/build-fixture-shard.js';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const isWindows = process.platform === 'win32';
const SLUG = 'acme/tools';
const VALUES = { user_name: 'Alice', org_name: 'Acme Labs', vault_purpose: 'engineering', qmd_enabled: true };

let stub: GitHubStub;
let scratch: string;
let toolDir: string;
let marker: string;
const dirs: string[] = [];

/** A shard declaring `fakeqmd` with this range, served at `#<ref>`. */
async function shardWith(ref: string, tool: Record<string, unknown>): Promise<string> {
  const tarPath = await buildMutatedShard({
    version: '0.1.0',
    prefix: `tools-${ref}`,
    outDir: scratch,
    dropHooks: true,
    mutate: async (workDir) => {
      const manifestPath = path.join(workDir, '.shardmind', 'shard.yaml');
      const manifest = parseYaml(await fs.readFile(manifestPath, 'utf-8')) as Record<string, unknown>;
      manifest['external_tools'] = { fakeqmd: { package: 'fake-qmd', command: 'fakeqmd', ...tool } };
      await fs.writeFile(manifestPath, stringifyYaml(manifest), 'utf-8');
    },
  });
  stub.setRef(SLUG, ref, 'b'.repeat(40), tarPath);
  return tarPath;
}

/** PATH holding only the fake tool, plus what node and cmd.exe need. */
function env(): Record<string, string> {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH')) as Record<string, string>;
  const system = isWindows ? [path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32')] : ['/bin', '/usr/bin'];
  const searchPath = [toolDir, path.dirname(process.execPath), ...system].join(path.delimiter);
  return {
    ...base,
    // spawnCli merges the parent env first, which on Windows spells it Path:
    // set both spellings so the child sees one search path.
    PATH: searchPath,
    Path: searchPath,
    SHARDMIND_GITHUB_API_BASE: stub.url,
    SHARDMIND_NO_UPDATE_CHECK: '1',
  };
}

async function freshVault(name: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `shardmind-e2e-tools-${name}-`));
  dirs.push(dir);
  return dir;
}

const toolRan = () => fs.stat(marker).then(() => true, () => false);

beforeAll(async () => {
  await ensureBuilt();
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'shardmind-e2e-tools-'));
  toolDir = path.join(scratch, 'bin');
  marker = path.join(scratch, 'tool-ran');
  await fs.mkdir(toolDir, { recursive: true });
  if (isWindows) {
    await fs.writeFile(path.join(toolDir, 'fakeqmd.cmd'), `@echo off\r\necho ran> "${marker}"\r\necho fakeqmd 2.5.3\r\n`);
  } else {
    await fs.writeFile(path.join(toolDir, 'fakeqmd'), `#!/bin/sh\ntouch '${marker}'\necho fakeqmd 2.5.3\n`, { mode: 0o755 });
  }
  stub = await createGitHubStub({ shards: { [SLUG]: { versions: {}, latest: '0.1.0' } } });
}, 120_000);

afterEach(async () => {
  await fs.rm(marker, { force: true });
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

afterAll(async () => {
  await stub?.close();
  if (scratch) await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5 });
});

async function install(vault: string, ref: string, extra: string[] = []) {
  const valuesFile = path.join(vault, '..', `${path.basename(vault)}-values.yaml`);
  await fs.writeFile(valuesFile, stringifyYaml(VALUES), 'utf-8');
  dirs.push(valuesFile);
  return spawnCli(['install', `github:${SLUG}#${ref}`, '--values', valuesFile, '--yes', ...extra], { cwd: vault, env: env() });
}

describe('external tools through the CLI (#138)', () => {
  it('installs when the tool on PATH is in range, having run it', async () => {
    await shardWith('in-range', { version: '>=2.5.0' });
    const vault = await freshVault('in-range');
    const result = await install(vault, 'in-range');
    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    expect(await toolRan()).toBe(true);
    await expect(fs.stat(path.join(vault, '.shardmind', 'state.json'))).resolves.toBeTruthy();
  }, 120_000);

  it('refuses when the tool is below the range, before writing, with an in-range hint', async () => {
    await shardWith('too-old', { version: '>=3.0.0' });
    const vault = await freshVault('too-old');
    const result = await install(vault, 'too-old');
    expect(result.exitCode).not.toBe(0);
    const out = result.stdout + result.stderr;
    expect(out).toContain('EXTERNAL_TOOL_UNMET');
    expect(out).toContain('fakeqmd: found 2.5.3, needs >=3.0.0');
    expect(out).toContain('npm i -g fake-qmd@">=3.0.0"');
    await expect(fs.stat(path.join(vault, '.shardmind'))).rejects.toThrow();
  }, 120_000);

  it('skips the tool when its when value is false', async () => {
    await shardWith('gated', { version: '>=3.0.0', when: 'qmd_enabled' });
    const vault = await freshVault('gated');
    const valuesFile = path.join(scratch, 'gated-values.yaml');
    await fs.writeFile(valuesFile, stringifyYaml({ ...VALUES, qmd_enabled: false }), 'utf-8');
    const result = await spawnCli(['install', `github:${SLUG}#gated`, '--values', valuesFile, '--yes'], { cwd: vault, env: env() });
    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    expect(await toolRan()).toBe(false);
  }, 120_000);

  it('never runs the tool on a dry run', async () => {
    await shardWith('dry-run', { version: '>=3.0.0' });
    const vault = await freshVault('dry-run');
    const result = await install(vault, 'dry-run', ['--dry-run']);
    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain('external tools not checked (dry run)');
    expect(await toolRan()).toBe(false);
  }, 120_000);

  it('validate checks the declaration and never runs the tool', async () => {
    const tarPath = await shardWith('validate', { version: '>=3.0.0' });
    const shardDir = await freshVault('validate-shard');
    const tar = await import('tar');
    await tar.x({ file: tarPath, cwd: shardDir, strip: 1 });
    const result = await spawnCli(['validate', shardDir, '--json'], { cwd: scratch, env: env() });
    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    expect(await toolRan()).toBe(false);
  }, 120_000);
});
