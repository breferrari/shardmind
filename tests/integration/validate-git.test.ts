/**
 * `validate` in a shard repo checks the tracked files, as the release
 * tarball ships them (#320). Spec: docs/IMPLEMENTATION.md §4.22 step 9.
 * Real git repositories, built per test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateShard } from '../../source/core/validate-shard.js';
import { gitFiles } from '../../source/core/git-tracked.js';
import { symlinksWork } from '../helpers/fs-capabilities.js';

const MINIMAL_SHARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../examples/minimal-shard');
const canSymlink = await symlinksWork();
const gitWorks = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

let work: string;
beforeEach(async () => {
  work = path.join(os.tmpdir(), `shardmind-validate-git-${crypto.randomUUID()}`);
  await fsp.mkdir(work, { recursive: true });
});
afterEach(async () => {
  await fsp.rm(work, { recursive: true, force: true, maxRetries: 5 });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.symlinks=true', ...args], { cwd, stdio: 'pipe' });

/** The minimal shard at `dir`, committed in a repository rooted at `repo`. */
async function committedShard(repo: string, dir = repo): Promise<string> {
  await fsp.cp(MINIMAL_SHARD, dir, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'shard');
  return dir;
}

const errors = (report: Awaited<ReturnType<typeof validateShard>>) => report.findings.filter((f) => f.severity === 'error');

describe.runIf(gitWorks)('validate in a git work tree (#320)', () => {
  it('a committed shard validates clean', async () => {
    const shard = await committedShard(work);
    const report = await validateShard(shard, {});
    expect(errors(report)).toEqual([]);
    expect(report.findings.filter((f) => f.code === 'LINT_UNTRACKED_FILE')).toEqual([]);
  });

  it.runIf(canSymlink)('an ignored node_modules/.bin symlink never fails it', async () => {
    const shard = await committedShard(work);
    await fsp.appendFile(path.join(shard, '.gitignore'), '\nnode_modules/\n');
    git(work, 'commit', '-q', '-am', 'ignore node_modules');
    await fsp.mkdir(path.join(shard, 'node_modules', '.bin'), { recursive: true });
    await fsp.writeFile(path.join(shard, 'node_modules', 'tool.js'), '');
    await fsp.symlink(path.join(shard, 'node_modules', 'tool.js'), path.join(shard, 'node_modules', '.bin', 'tool'));
    const report = await validateShard(shard, {});
    expect(errors(report)).toEqual([]);
  });

  it.runIf(canSymlink)('a tracked symlink still fails WALK_SYMLINK_REJECTED', async () => {
    const shard = await committedShard(work);
    await fsp.symlink('Home.md.njk', path.join(shard, 'link.md'));
    git(work, 'add', 'link.md');
    git(work, 'commit', '-q', '-m', 'a link');
    const report = await validateShard(shard, {});
    expect(errors(report).map((f) => f.code)).toContain('WALK_SYMLINK_REJECTED');
  });

  it('an untracked file is a warning naming it, and is not validated', async () => {
    const shard = await committedShard(work);
    // A template that would fail to render, never committed.
    await fsp.writeFile(path.join(shard, 'Draft.md.njk'), '{{ broken(');
    const report = await validateShard(shard, {});
    expect(errors(report)).toEqual([]);
    expect(report.findings).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'LINT_UNTRACKED_FILE', path: 'Draft.md.njk' }));
  });

  it('an ignored file is neither warned about nor validated', async () => {
    const shard = await committedShard(work);
    await fsp.appendFile(path.join(shard, '.gitignore'), '\nscratch.md.njk\n');
    git(work, 'commit', '-q', '-am', 'ignore scratch');
    await fsp.writeFile(path.join(shard, 'scratch.md.njk'), '{{ broken(');
    const report = await validateShard(shard, {});
    expect(errors(report)).toEqual([]);
    expect(report.findings.filter((f) => f.code === 'LINT_UNTRACKED_FILE')).toEqual([]);
  });

  it('a shard in a subfolder of a repository reads its paths from the shard root', async () => {
    const shard = await committedShard(work, path.join(work, 'shards', 'mine'));
    await fsp.writeFile(path.join(shard, 'Draft.md.njk'), '{{ broken(');
    const report = await validateShard(shard, {});
    expect(errors(report)).toEqual([]);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'LINT_UNTRACKED_FILE', path: 'Draft.md.njk' }));
  });
});

describe('outside git, or without it (#320)', () => {
  it('a plain folder walks as before: an unreadable template fails it', async () => {
    const shard = path.join(work, 'shard');
    await fsp.cp(MINIMAL_SHARD, shard, { recursive: true });
    await fsp.writeFile(path.join(shard, 'Draft.md.njk'), '{{ broken(');
    const report = await validateShard(shard, {});
    expect(errors(report).length).toBeGreaterThan(0);
    expect(report.findings.filter((f) => f.code === 'LINT_UNTRACKED_FILE')).toEqual([]);
  });

  it('gitFiles is null without git on PATH, or outside a work tree', async () => {
    const noGit = async () => Promise.reject(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }));
    expect(await gitFiles(work, noGit)).toBeNull();
    expect(await gitFiles(work, async () => 'false\n')).toBeNull();
  });

  it('gitFiles splits NUL-separated names, spaces and Unicode kept', async () => {
    const run = async (args: readonly string[]) =>
      args[0] === 'rev-parse' ? 'true\n' : args.includes('--others') ? 'new note.md\0' : 'Home.md.njk\0brain/Café.md\0';
    expect(await gitFiles(work, run)).toEqual({ tracked: new Set(['Home.md.njk', 'brain/Café.md']), untracked: ['new note.md'] });
  });
});
