/**
 * A bug that no command's error view catches (#225).
 *
 * The crashes are made real: a copy of `dist/` whose root command module is
 * replaced. The copy sits in a temp dir with a link to the repo's
 * `node_modules`, so its imports resolve as the real build's do.
 *
 * - A module that throws when Pastel loads it escapes every command: the
 *   top-level handler in `cli.ts` prints it as plain text to stderr.
 * - A command that throws while it renders reaches the CrashBoundary in
 *   `commands/_app.tsx`, which shows it through the error view.
 *
 * Both exit 1, with the report link, instead of a bare trace (or Ink's own
 * overview and exit 0).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ensureBuilt } from './helpers/build-once.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

let root: string;
let version: string;

beforeAll(async () => {
  await ensureBuilt();
  version = (JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as { version: string }).version;
  root = path.join(os.tmpdir(), `shardmind-crash-${crypto.randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  await fs.cp(path.join(REPO_ROOT, 'dist'), path.join(root, 'dist'), { recursive: true });
  await fs.copyFile(path.join(REPO_ROOT, 'package.json'), path.join(root, 'package.json'));
  await fs.symlink(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'), 'junction');
}, 120_000);

afterAll(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

/** Replace the root command's module in the copy, and run `shardmind` with no arguments. */
async function runWithRootCommand(source: string) {
  await fs.writeFile(path.join(root, 'dist', 'commands', 'index.js'), source);
  return spawnSync(process.execPath, [path.join(root, 'dist', 'cli.js')], {
    cwd: root,
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
    encoding: 'utf-8',
    timeout: 60_000,
  });
}

describe('a bug no error view catches (#225)', () => {
  it('prints a throw that escapes every command with the report link and the stack, and exits 1', async () => {
    const result = await runWithRootCommand("throw new TypeError('boom from a broken command module');\n");
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('boom from a broken command module');
    expect(result.stderr).toContain('This is a bug in shardmind. Please report it:');
    expect(result.stderr).toContain(`https://github.com/breferrari/shardmind/issues/new?body=shardmind+${version}`);
    expect(result.stderr).toMatch(/TypeError: boom from a broken command module\s+at /);
    expect(result.stderr).not.toContain('\u001b');
  }, 60_000);

  it('shows a throw while a command renders through the error view, and exits 1, not 0', async () => {
    const result = await runWithRootCommand(
      "export default function Index() { throw new TypeError('boom while rendering'); }\n",
    );
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain('boom while rendering');
    expect(result.stdout).toContain('This is a bug in shardmind. Please report it:');
    expect(result.stdout).toContain(`issues/new?body=shardmind+${version}`);
  }, 60_000);
});
