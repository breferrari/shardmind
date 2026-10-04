/**
 * A copy of `dist/` whose root command module a test can replace, to make a
 * crash real (#225). The copy sits in a temp dir with a link to the repo's
 * `node_modules`, so its imports resolve as the real build's do.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureBuilt } from './build-once.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

export interface BrokenDist {
  /** The copy's root: a cwd outside any vault. */
  readonly root: string;
  /** `dist/cli.js` in the copy. */
  readonly cli: string;
  /** Replace the root command's module (`dist/commands/index.js`). */
  setRootCommand(source: string): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createBrokenDist(): Promise<BrokenDist> {
  await ensureBuilt();
  const root = path.join(os.tmpdir(), `shardmind-crash-${crypto.randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  await fs.cp(path.join(REPO_ROOT, 'dist'), path.join(root, 'dist'), { recursive: true });
  await fs.copyFile(path.join(REPO_ROOT, 'package.json'), path.join(root, 'package.json'));
  await fs.symlink(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  return {
    root,
    cli: path.join(root, 'dist', 'cli.js'),
    setRootCommand: (source) => fs.writeFile(path.join(root, 'dist', 'commands', 'index.js'), source),
    cleanup: () => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }),
  };
}
