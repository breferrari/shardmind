/**
 * Post-install hook for the obsidian-mind-like contract fixture.
 *
 * Test-driven by env vars so a single hook handles every scenario:
 *
 *   SHARDMIND_HOOK_THROW=1            — throw immediately (hook-failure scenario).
 *   SHARDMIND_HOOK_EDIT_BEFORE_THROW=1 — edit a managed file, THEN throw
 *                                        (post-hook re-hash scenario).
 *   SHARDMIND_HOOK_SLEEP_MS=<n>       — sleep <n> ms before returning
 *                                        (timeout scenario; pair with a
 *                                        small `timeout_ms` in shard.yaml).
 *
 * Default behavior:
 *   1. Always dump ctx to `.hook-ctx-install.json` (test inspection).
 *   2. Invariant 2: when ctx.valuesAreDefaults is true, do NOT modify
 *      managed files. The hook may write *unmanaged* files (markers)
 *      unconditionally.
 *   3. When ctx.valuesAreDefaults is false, personalize the managed
 *      `brain/North Star.md` by injecting the user's name.
 */

import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

interface HookCtx {
  vaultRoot: string;
  values: Record<string, unknown>;
  modules: Record<string, 'included' | 'excluded'>;
  shard: { name: string; version: string };
  valuesAreDefaults: boolean;
  newFiles: string[];
  removedFiles: string[];
}

export default async function (ctx: HookCtx): Promise<void> {
  // Test inspection: write the entire ctx so scenarios can assert
  // exactly what the engine handed the hook.
  await writeFile(
    join(ctx.vaultRoot, '.hook-ctx-install.json'),
    JSON.stringify(ctx, null, 2),
    'utf-8',
  );

  // Marker file (unmanaged) so a scenario can prove the hook ran at all
  // even when valuesAreDefaults gates the managed-file branch off.
  await writeFile(
    join(ctx.vaultRoot, '.post-install-marker.txt'),
    `ran for ${ctx.shard.name}@${ctx.shard.version}\n`,
    'utf-8',
  );

  if (process.env.SHARDMIND_HOOK_SLEEP_MS) {
    const ms = Number(process.env.SHARDMIND_HOOK_SLEEP_MS);
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  if (process.env.SHARDMIND_HOOK_EDIT_BEFORE_THROW === '1') {
    const ns = join(ctx.vaultRoot, 'brain', 'North Star.md');
    const original = await readFile(ns, 'utf-8');
    await writeFile(ns, original + '\n<!-- pre-throw edit -->\n', 'utf-8');
    throw new Error('hook deliberately failed after editing a managed file');
  }

  if (process.env.SHARDMIND_HOOK_THROW === '1') {
    throw new Error('hook deliberately failed');
  }

  // Invariant 2: no managed-file mutation when values are at defaults.
  if (ctx.valuesAreDefaults) return;

  // Personalize the managed file. The post-hook re-hash will pick this
  // up so state.json reflects the post-edit content.
  const ns = join(ctx.vaultRoot, 'brain', 'North Star.md');
  const original = await readFile(ns, 'utf-8');
  const personalized = original.replace(
    /^# North Star/m,
    `# North Star — ${String(ctx.values['user_name'] ?? 'unknown')}`,
  );
  await writeFile(ns, personalized, 'utf-8');
}
