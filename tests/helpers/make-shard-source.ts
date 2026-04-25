/**
 * Build a v6-shaped temp shard source tree for tests.
 *
 * Creates `<rootDir>/.shardmind/shard.yaml` (empty) so `cacheTemplates`'
 * presence gate is satisfied, then writes the supplied files at
 * shard-root-relative paths. Used by every test that needs a synthetic
 * shard tarball-equivalent on disk: `modules.test.ts`, `state.test.ts`,
 * `update-planner.test.ts`, `update-adversarial.test.ts`,
 * `shardmindignore.test.ts`. Pre-v6 each test file rolled its own
 * 8-line variant; consolidate so the v6 contract has one canonical
 * harness.
 *
 * Returns the rootDir (so callers can chain cleanup).
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

export async function makeShardSource(
  rootDir: string,
  files: Record<string, string> = {},
): Promise<string> {
  await fsp.mkdir(path.join(rootDir, '.shardmind'), { recursive: true });
  await fsp.writeFile(path.join(rootDir, '.shardmind', 'shard.yaml'), '', 'utf-8');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(rootDir, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, 'utf-8');
  }
  return rootDir;
}
