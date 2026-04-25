/**
 * Shared internals for tarball-builder helpers
 * (`tarball.ts`, `obsidian-mind-tarball.ts`).
 *
 * The two helpers diverge in *what* they mutate (minimal-shard's bumps
 * Home.md content + adds Changelog at v0.2.0; obsidian-mind-like adds
 * a whole module + edits CLAUDE.md), but the infrastructure underneath
 * — copy a fixture tree, hash it for cache invalidation, check that
 * cached tarballs still exist on disk, unpack a tarball into a working
 * dir — is identical. Sharing here keeps a future change to (e.g.)
 * symlink rejection or Buffer-equality from drifting between the two.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Recursively copy `src` to `dst`. Throws on symlinks / sockets / FIFOs
 * — silently dropping them would produce a subtly-broken tarball the
 * CLI would install without complaint.
 */
export async function copyDir(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const sFrom = path.join(src, entry.name);
    const sTo = path.join(dst, entry.name);
    if (entry.isDirectory()) await copyDir(sFrom, sTo);
    else if (entry.isFile()) await fs.copyFile(sFrom, sTo);
    else {
      throw new Error(
        `copyDir: unsupported entry type at ${sFrom} ` +
          `(isSymbolicLink=${entry.isSymbolicLink()}). Extend the copier if you need this.`,
      );
    }
  }
}

/**
 * SHA-256 over `(relPath, content)` pairs of every file under `dir`,
 * sorted by path. Used as a cache key for "have I built tarballs from
 * this fixture before this process". Order-stable across runs.
 */
export async function hashSourceTree(dir: string): Promise<string> {
  const hasher = crypto.createHash('sha256');
  const stack: string[] = [dir];
  const entries: string[] = [];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const kids = await fs.readdir(current, { withFileTypes: true });
    for (const k of kids) {
      const full = path.join(current, k.name);
      if (k.isDirectory()) stack.push(full);
      else if (k.isFile()) entries.push(full);
    }
  }
  entries.sort();
  for (const entry of entries) {
    const rel = path.relative(dir, entry).replace(/\\/g, '/');
    hasher.update(rel);
    hasher.update('\0');
    hasher.update(await fs.readFile(entry));
    hasher.update('\0');
  }
  return hasher.digest('hex');
}

/**
 * True when every tarball path in `byVersion` is still readable. The
 * cache invalidates if a prior run's tempdir was cleaned externally
 * but the in-process cache still points at those paths.
 */
export async function cachedFilesExist(
  byVersion: Record<string, string>,
): Promise<boolean> {
  for (const tarPath of Object.values(byVersion)) {
    try {
      await fs.access(tarPath);
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Extract a `tar.gz` into `into`. Strips the leading `<repo>-<sha>/`
 * prefix that GitHub-shaped tarballs (and our fixtures) always carry.
 * Used by inline tarball scaffolds in describe-blocks that need a
 * structurally-different variant of an existing fixture (prerelease
 * version stamping, tiny timeout_ms, symlink, etc.).
 */
export async function unpackInto(tarPath: string, into: string): Promise<void> {
  const { x } = await import('tar');
  await fs.mkdir(into, { recursive: true });
  await x({ file: tarPath, cwd: into, strip: 1 });
}
