/**
 * Probes for filesystem features a test needs, so it can skip where the
 * platform lacks them instead of failing (#163).
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function probe(attempt: (dir: string) => Promise<unknown>): Promise<boolean> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'shardmind-fsprobe-'));
  try {
    await attempt(dir);
    return true;
  } catch {
    return false;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/** Creating a symlink needs a privilege on Windows that CI runners often lack. */
export const symlinksWork = () => probe((dir) => fsp.symlink(path.join(dir, 'target'), path.join(dir, 'link')));

/** Some filesystems (FAT, some network mounts) have no hard links. */
export const hardLinksWork = () =>
  probe(async (dir) => {
    await fsp.writeFile(path.join(dir, 'a'), '');
    await fsp.link(path.join(dir, 'a'), path.join(dir, 'b'));
  });

/** True when the filesystem under tmpdir resolves names case-insensitively. */
export const foldsCase = () =>
  probe(async (dir) => {
    await fsp.writeFile(path.join(dir, 'probe'), '');
    await fsp.lstat(path.join(dir, 'PROBE'));
  });
