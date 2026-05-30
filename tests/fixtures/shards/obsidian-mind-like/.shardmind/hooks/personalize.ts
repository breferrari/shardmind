/**
 * Personalize hook for the obsidian-mind-like contract fixture (#102).
 *
 * Runs on install/adopt ONLY, and only when the engine decides values are
 * non-default (engine-enforced Invariant 2 — the hook no longer self-gates).
 * Edits the managed `brain/North Star.md`; the post-hook re-hash captures the
 * edit so state.json reflects the post-edit bytes.
 *
 * Test-driven env var:
 *   SHARDMIND_HOOK_EDIT_BEFORE_THROW=1 — edit the managed file, THEN throw
 *     (post-hook re-hash scenario: state must reflect the edit even though the
 *      hook failed). Pair with custom values so personalize actually runs.
 */

import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

interface PersonalizeCtx {
  slot: 'personalize';
  vaultRoot: string;
  values: Record<string, unknown>;
  modules: Record<string, 'included' | 'excluded'>;
  shard: { name: string; version: string };
}

export default async function (ctx: PersonalizeCtx): Promise<void> {
  await writeFile(
    join(ctx.vaultRoot, '.hook-ctx-personalize.json'),
    JSON.stringify(ctx, null, 2),
    'utf-8',
  );

  const ns = join(ctx.vaultRoot, 'brain', 'North Star.md');
  const original = await readFile(ns, 'utf-8');

  if (process.env.SHARDMIND_HOOK_EDIT_BEFORE_THROW === '1') {
    await writeFile(ns, original + '\n<!-- pre-throw edit -->\n', 'utf-8');
    throw new Error('hook deliberately failed after editing a managed file');
  }

  // Personalize the managed file with the user's name. No `valuesAreDefaults`
  // check — if this hook runs at all, the engine already determined values
  // are non-default.
  const personalized = original.replace(
    /^# North Star/m,
    `# North Star — ${String(ctx.values['user_name'] ?? 'unknown')}`,
  );
  await writeFile(ns, personalized, 'utf-8');
}
