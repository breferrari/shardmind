/**
 * Post-update hook for the obsidian-mind-like contract fixture.
 *
 * Invariant 3: post-update hooks are additive-only by default — writes
 * are restricted to ctx.newFiles. This implementation enforces that
 * literally: it loops ctx.newFiles and only touches those paths.
 *
 * The hook also dumps ctx so scenarios can assert that the engine
 * populated newFiles / removedFiles correctly across the update plan.
 */

import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface HookCtx {
  vaultRoot: string;
  values: Record<string, unknown>;
  modules: Record<string, 'included' | 'excluded'>;
  shard: { name: string; version: string };
  previousVersion?: string;
  valuesAreDefaults: boolean;
  newFiles: string[];
  removedFiles: string[];
}

export default async function (ctx: HookCtx): Promise<void> {
  await writeFile(
    join(ctx.vaultRoot, '.hook-ctx-update.json'),
    JSON.stringify(ctx, null, 2),
    'utf-8',
  );

  // Append a marker line ONLY to paths the engine reported as newly
  // added (Invariant 3). A test that asserts no edits to unrelated
  // managed files pins this contract.
  for (const rel of ctx.newFiles) {
    try {
      await appendFile(
        join(ctx.vaultRoot, rel),
        '\n<!-- touched by post-update -->\n',
        'utf-8',
      );
    } catch {
      // newFiles is the engine's view; if the path doesn't exist on
      // disk (it should, for `add` actions) we skip silently rather
      // than break the hook contract on a planner bug.
    }
  }
}
