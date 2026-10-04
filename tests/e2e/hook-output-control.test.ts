/**
 * Hook output reaches the user only through Ink (#204): HookProgress while the
 * hook runs and HookSummarySection after. This runs a hook that prints
 * terminal control sequences through the real CLI, piped (the `--yes` /
 * non-TTY path) and in a faked terminal, and asserts none of them reach
 * stdout or stderr while the hook's text does.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIST_CLI, ensureBuilt } from './helpers/build-once.js';
import { createGitHubStub, type GitHubStub } from './helpers/github-stub.js';
import { createEmptyVault, type Vault } from './helpers/vault.js';
import { FAKE_TTY_IMPORT } from '../helpers/fake-tty.js';

const ESC = '\x1b';
const SEQUENCES: Record<string, string> = {
  'OSC 52 clipboard write': `${ESC}]52;c;aGk=`,
  'OSC 0 title': `${ESC}]0;pwned`,
  'OSC 8 hyperlink': `${ESC}]8;;https://evil.example`,
  'cursor-up': `${ESC}[1A`,
  BEL: '\x07',
  BS: '\x08',
  'a lone CR': 'progress 10%\r',
};

// The hook builds its bytes with String.fromCharCode, so nothing here relies
// on escape sequences surviving a round trip through source text.
const HOOK_SOURCE = [
  'export default async function () {',
  '  const E = String.fromCharCode(27);',
  '  const BEL = String.fromCharCode(7);',
  '  const BS = String.fromCharCode(8);',
  '  const ST = E + String.fromCharCode(92);',
  "  process.stdout.write('HOOK-BEFORE ' + E + ']52;c;aGk=' + BEL + E + ']0;pwned' + ST + E + '[1A');",
  "  process.stdout.write(E + ']8;;https://evil.example' + BEL + 'HOOK-LINK' + E + ']8;;' + BEL);",
  "  process.stdout.write(' bell' + BEL + ' bs' + BS + ' HOOK-AFTER\\n');",
  "  process.stdout.write('progress 10%' + String.fromCharCode(13) + 'progress 100%\\n');",
  "  process.stderr.write(E + ']52;c;aGk=' + BEL + 'HOOK-STDERR\\n');",
  '}',
  '',
].join('\n');

const DEFAULT_VALUES = 'user_name: "Alice"\norg_name: "Acme Labs"\nvault_purpose: "engineering"\nqmd_enabled: true\n';

let stub: GitHubStub;
let scratch: string;

async function copyTree(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await fs.copyFile(from, to);
  }
}

beforeAll(async () => {
  await ensureBuilt();
  const tar = await import('tar');
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'shardmind-e2e-hook-ctrl-'));
  const prefix = 'hook-ctrl-0.1.0';
  const workRoot = path.join(scratch, 'work');
  const workDir = path.join(workRoot, prefix);
  await copyTree(fileURLToPath(new URL('../../examples/minimal-shard', import.meta.url)), workDir);
  await fs.mkdir(path.join(workDir, 'hooks'), { recursive: true });
  await fs.writeFile(path.join(workDir, 'hooks', 'post-install.ts'), HOOK_SOURCE, 'utf-8');
  const tarball = path.join(scratch, `${prefix}.tar.gz`);
  await tar.c({ file: tarball, gzip: true, cwd: workRoot }, [prefix]);
  stub = await createGitHubStub({
    shards: { 'acme/hook-ctrl': { versions: { '0.1.0': tarball }, latest: '0.1.0' } },
  });
}, 60_000);

afterAll(async () => {
  await stub?.close();
  if (scratch) await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// Async on purpose: the GitHub stub serves from this process, so a
// synchronous spawn would block the event loop it answers on.
function install(
  vault: Vault,
  valuesPath: string,
  tty: boolean,
): Promise<{ stdout: string; stderr: string; status: number | null }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('SHARDMIND_')) delete env[key];
  Object.assign(env, {
    SHARDMIND_GITHUB_API_BASE: stub.url,
    SHARDMIND_NO_UPDATE_CHECK: '1',
    TERM: 'xterm-256color',
    FORCE_COLOR: '1',
  });
  const child = spawn(
    process.execPath,
    [...(tty ? ['--import', FAKE_TTY_IMPORT] : []), DIST_CLI, 'install', 'github:acme/hook-ctrl', '--yes', '--values', valuesPath],
    { cwd: vault.root, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf-8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf-8').on('data', (chunk: string) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`install timed out\n${stdout}\n${stderr}`));
    }, 60_000);
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, status });
    });
  });
}

describe.each([false, true])('a hook printing control sequences, TTY %s', (tty) => {
  it("shows the hook's text and none of its sequences", async () => {
    const vault = await createEmptyVault(`hook-ctrl-${tty ? 'tty' : 'pipe'}`);
    try {
      const valuesPath = path.join(vault.root, '.values.yaml');
      await fs.writeFile(valuesPath, DEFAULT_VALUES, 'utf-8');
      const { stdout, stderr, status } = await install(vault, valuesPath, tty);
      expect(status, stderr).toBe(0);
      const all = stdout + stderr;
      for (const text of ['HOOK-BEFORE', 'HOOK-LINK', 'HOOK-AFTER', 'HOOK-STDERR', 'progress 100%']) {
        expect(all).toContain(text);
      }
      for (const [name, bytes] of Object.entries(SEQUENCES)) {
        // In a terminal Ink moves the cursor up itself to redraw its frame,
        // so a cursor-up there proves nothing about the hook; the piped run
        // checks it.
        if (tty && name === 'cursor-up') continue;
        expect(all, name).not.toContain(bytes);
      }
    } finally {
      await vault.cleanup();
    }
  }, 90_000);
});
