/**
 * The files of a shard directory as its release tarball would hold them
 * (#320). Spec: docs/IMPLEMENTATION.md §4.22 step 9.
 *
 * A release tarball holds the files tracked at the tag. Inside a git work
 * tree, `validate` checks those, not the working tree's ignored folders
 * (`node_modules/`, build output) or untracked files. Git runs without a
 * shell; with no work tree, or no `git` on PATH, the answer is `null` and
 * the caller walks the directory as before.
 */

import { execFile } from 'node:child_process';

/** Run `git` with `args` in `cwd`; its stdout, or a rejection. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<string>;

const runGit: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile('git', [...args], { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

export interface GitFiles {
  /** Tracked files, relative to `dir`, POSIX separators. */
  tracked: Set<string>;
  /** Untracked files git does not ignore, relative to `dir`. */
  untracked: string[];
}

export async function gitFiles(dir: string, run: GitRunner = runGit): Promise<GitFiles | null> {
  try {
    if ((await run(['rev-parse', '--is-inside-work-tree'], dir)).trim() !== 'true') return null;
    // Relative to `cwd`, so a shard in a subfolder of a repository reads as
    // its own root; `-z` keeps names with spaces or non-ASCII as they are.
    const [tracked, untracked] = await Promise.all([
      run(['ls-files', '-z'], dir),
      run(['ls-files', '-z', '--others', '--exclude-standard'], dir),
    ]);
    return { tracked: new Set(split(tracked)), untracked: split(untracked) };
  } catch {
    // Not a work tree, or no git: the directory is walked as it is.
    return null;
  }
}

function split(output: string): string[] {
  return output.split('\0').filter((entry) => entry !== '');
}
