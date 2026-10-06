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

// The machine's own git config (signing, template hooks) stays out of it: a
// global config file that does not exist reads as empty (Windows git cannot
// open os.devNull).
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), `shardmind-no-gitconfig-${crypto.randomUUID()}`), GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.symlinks=true', '-c', 'commit.gpgsign=false', ...args],
    { cwd, stdio: 'pipe', env: gitEnv },
  );

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

  it('an untracked .shardmind/ file is warned about: the release needs it', async () => {
    const shard = await committedShard(work);
    await fsp.mkdir(path.join(shard, '.shardmind', 'hooks'), { recursive: true });
    await fsp.writeFile(path.join(shard, '.shardmind', 'hooks', 'post-install.ts'), 'export default async () => {};\n');
    const report = await validateShard(shard, {});
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'LINT_UNTRACKED_FILE', path: '.shardmind/hooks/' }));
  });

  it('a wholly untracked folder is one warning, not one per file', async () => {
    const shard = await committedShard(work);
    await fsp.mkdir(path.join(shard, 'drafts'));
    for (const name of ['a.md', 'b.md', 'c.md']) await fsp.writeFile(path.join(shard, 'drafts', name), '');
    const report = await validateShard(shard, {});
    expect(report.findings.filter((f) => f.code === 'LINT_UNTRACKED_FILE').map((f) => f.path)).toEqual(['drafts/']);
  });

  it('an include of an ignored partial fails, as it would from the release', async () => {
    const shard = await committedShard(work);
    await fsp.appendFile(path.join(shard, '.gitignore'), '\npartials/\n');
    await fsp.writeFile(path.join(shard, 'Included.md.njk'), '{% include "partials/head.njk" %}\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'include a partial');
    await fsp.mkdir(path.join(shard, 'partials'));
    await fsp.writeFile(path.join(shard, 'partials', 'head.njk'), 'head\n');
    const report = await validateShard(shard, {});
    expect(errors(report)).toContainEqual(expect.objectContaining({ code: 'RENDER_TEMPLATE_ERROR', path: 'Included.md' }));
  });

  it('a folder the repository ignores is checked whole, as a plain folder', async () => {
    git(work, 'init', '-q');
    await fsp.writeFile(path.join(work, '.gitignore'), 'shard/\n');
    const shard = path.join(work, 'shard');
    await fsp.cp(MINIMAL_SHARD, shard, { recursive: true });
    await fsp.writeFile(path.join(shard, 'Draft.md.njk'), '{{ broken(');
    const report = await validateShard(shard, {});
    expect(errors(report).length).toBeGreaterThan(0);
  });

  it('a repository with nothing committed yet is checked whole', async () => {
    await fsp.cp(MINIMAL_SHARD, work, { recursive: true });
    git(work, 'init', '-q');
    await fsp.writeFile(path.join(work, 'Draft.md.njk'), '{{ broken(');
    const report = await validateShard(work, {});
    expect(errors(report).length).toBeGreaterThan(0);
  });

  it("a caller's GIT_DIR does not redirect the listing", async () => {
    const shard = await committedShard(work);
    const other = path.join(os.tmpdir(), `shardmind-validate-git-other-${crypto.randomUUID()}`);
    await fsp.mkdir(other);
    git(other, 'init', '-q');
    // Redirected, the listing would find nothing tracked and check the
    // untracked broken template too.
    await fsp.writeFile(path.join(shard, 'Draft.md.njk'), '{{ broken(');
    const before = process.env['GIT_DIR'];
    process.env['GIT_DIR'] = path.join(other, '.git');
    try {
      const report = await validateShard(shard, {});
      expect(errors(report)).toEqual([]);
      expect(report.findings).toContainEqual(expect.objectContaining({ code: 'LINT_UNTRACKED_FILE', path: 'Draft.md.njk' }));
    } finally {
      if (before === undefined) delete process.env['GIT_DIR'];
      else process.env['GIT_DIR'] = before;
      await fsp.rm(other, { recursive: true, force: true, maxRetries: 5 });
    }
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
  });

  const fakeGit = (ignoreCase: string) => async (args: readonly string[]) =>
    args[0] === 'config' ? ignoreCase : args.includes('--others') ? 'new note.md\0' : 'Home.md.njk\0brain/Café.md\0';

  it('gitFiles splits NUL-separated names, spaces and Unicode kept, folders of tracked files kept', async () => {
    const files = (await gitFiles(work, fakeGit('false\n')))!;
    expect(files.untracked).toEqual(['new note.md']);
    for (const kept of ['Home.md.njk', 'brain', 'brain/Café.md']) expect(files.tracked(kept), kept).toBe(true);
    for (const dropped of ['new note.md', 'bra', 'home.md.njk']) expect(files.tracked(dropped), dropped).toBe(false);
  });

  it('gitFiles compares names in one Unicode form, and folds case where git ignores it', async () => {
    const nfd = 'brain/Cafe\u0301.md';
    expect((await gitFiles(work, fakeGit('false\n')))!.tracked(nfd)).toBe(true);
    expect((await gitFiles(work, fakeGit('true\n')))!.tracked('BRAIN/café.md')).toBe(true);
    // Unset (`git config` exits 1): case counts.
    const unset = async (args: readonly string[]) => (args[0] === 'config' ? Promise.reject(new Error('exit 1')) : fakeGit('')(args));
    expect((await gitFiles(work, unset))!.tracked('home.md.njk')).toBe(false);
  });

  it('gitFiles is null when nothing is tracked', async () => {
    expect(await gitFiles(work, async (args) => (args[0] === 'config' ? 'false\n' : ''))).toBeNull();
  });
});
