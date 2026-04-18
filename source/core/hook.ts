import path from 'node:path';
import type { ShardManifest } from '../runtime/types.js';
import { pathExists } from './fs-utils.js';

export type HookResult =
  | { kind: 'absent' }
  | { kind: 'deferred'; hookPath: string }
  | { kind: 'ran'; stdout: string; exitCode: number }
  | { kind: 'failed'; message: string };

/**
 * Locate and optionally invoke a post-install hook.
 *
 * v0.1 implementation: detects the hook file from the shard manifest's
 * `hooks.post-install` pointer. Execution is deferred — we do not yet
 * have a TypeScript runtime bundled with shardmind. Returns a
 * `deferred` result so the Summary component can surface the skip
 * to the user.
 *
 * The execution mechanism (tsx spawn vs jiti dynamic import) will be
 * decided in #30, linked from ROADMAP Milestone 5.
 */
export async function runPostInstallHook(
  tempDir: string,
  manifest: ShardManifest,
): Promise<HookResult> {
  const hookRelPath = manifest.hooks?.['post-install'];
  if (!hookRelPath) return { kind: 'absent' };

  const hookPath = path.join(tempDir, hookRelPath);
  if (!(await pathExists(hookPath))) return { kind: 'absent' };
  return { kind: 'deferred', hookPath };
}
