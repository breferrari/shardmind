/**
 * The files of a shard directory as its release tarball would hold them
 * (#320). Spec: docs/IMPLEMENTATION.md §4.22 step 9.
 *
 * A release tarball holds the files tracked at the tag. Inside a git work
 * tree, `validate` checks those, not the working tree's ignored folders
 * (`node_modules/`, build output) or untracked files. Git runs without a
 * shell; with no work tree, nothing tracked there, or no `git` on PATH, the
 * answer is `null` and the caller walks the directory as before.
 */

import { execFile } from 'node:child_process';

/** Run `git` with `args` in `cwd`; its stdout, or a rejection. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<string>;

/**
 * The folder's own repository decides, whatever the caller's environment
 * says: a `GIT_DIR` or `GIT_INDEX_FILE` set by a git hook that runs validate
 * would point the listing at another repository. `core.fsmonitor` off: the
 * folder's `.git/config` could name a command for it to run, and validate
 * never runs shard code.
 */
const runGit: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
    execFile('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, env, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

export interface GitFiles {
  /** Whether a path, relative to the directory with POSIX separators, is tracked, or a folder holding a tracked file. */
  tracked: (relPath: string) => boolean;
  /** Untracked files git does not ignore, relative to the directory; a wholly untracked folder is one entry ending in `/`. */
  untracked: string[];
}

export async function gitFiles(dir: string, run: GitRunner = runGit): Promise<GitFiles | null> {
  try {
    // Relative to `cwd`, so a shard in a subfolder of a repository reads as
    // its own root; `-z` keeps names with spaces or non-ASCII as they are.
    // Outside a work tree `ls-files` fails, and the catch answers null.
    const [tracked, untracked, ignoreCase] = await Promise.all([
      run(['ls-files', '-z'], dir),
      run(['ls-files', '-z', '--others', '--exclude-standard', '--directory', '--no-empty-directory'], dir),
      run(['config', '--bool', 'core.ignorecase'], dir).then((out) => out.trim() === 'true', () => false),
    ]);
    const paths = split(tracked);
    // Nothing tracked here (a folder the repository ignores, or nothing
    // committed yet): no release to compare with, so the whole folder is checked.
    if (paths.length === 0) return null;
    return { tracked: trackedFilter(paths, ignoreCase), untracked: split(untracked) };
  } catch {
    // Not a work tree, no git, or git failed (a listing past `maxBuffer`):
    // the directory is walked as it is, as before #320.
    return null;
  }
}

/**
 * Git's index names and the names `readdir` returns can differ in Unicode
 * form (macOS), or in case where git ignores it: both compare folded.
 */
function trackedFilter(paths: readonly string[], ignoreCase: boolean): (relPath: string) => boolean {
  const fold = (p: string): string => (ignoreCase ? p.normalize('NFC').toLowerCase() : p.normalize('NFC'));
  const keys = new Set<string>();
  for (const file of paths) {
    const key = fold(file);
    keys.add(key);
    for (let at = key.lastIndexOf('/'); at > 0; at = key.lastIndexOf('/', at - 1)) keys.add(key.slice(0, at));
  }
  return (relPath) => keys.has(fold(relPath));
}

function split(output: string): string[] {
  return output.split('\0').filter((entry) => entry !== '');
}
