/**
 * A vault's tree as a rollback test compares it (#267, #186): every entry
 * under `root` by POSIX path with case, mapped to `dir`, `link:<target>` or
 * the file's sha256. Two trees are equal when nothing was added, removed,
 * retyped or rewritten.
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

export async function treeOf(root: string): Promise<Map<string, string>> {
  const tree = new Map<string, string>();
  const walk = async (dir: string) => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (entry.isSymbolicLink()) tree.set(rel, `link:${await fsp.readlink(abs)}`);
      else if (entry.isDirectory()) {
        tree.set(rel, 'dir');
        await walk(abs);
      } else tree.set(rel, crypto.createHash('sha256').update(await fsp.readFile(abs)).digest('hex'));
    }
  };
  await walk(root);
  return tree;
}
