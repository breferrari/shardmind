import path from 'node:path';
import type { ShardManifest } from '../runtime/types.js';
import { pathExists } from './fs-utils.js';

export type HookResult =
  | { kind: 'absent' }
  | { kind: 'deferred'; hookPath: string }
  | { kind: 'ran'; stdout: string; exitCode: number }
  | { kind: 'failed'; message: string };

/**
 * Locate the post-install hook declared by the shard manifest and
 * return a `HookResult` the command layer can surface. Execution is
 * decoupled from lookup — a `deferred` result says "the hook exists
 * and is sandbox-valid; whoever runs hooks should handle this one".
 * Execution mechanism (tsx spawn vs jiti dynamic import) is tracked
 * in #30.
 */
export async function runPostInstallHook(
  tempDir: string,
  manifest: ShardManifest,
): Promise<HookResult> {
  return lookupHook(tempDir, manifest.hooks?.['post-install']);
}

/**
 * Post-update sibling of `runPostInstallHook`. Same contract and
 * sandbox invariants.
 */
export async function runPostUpdateHook(
  tempDir: string,
  manifest: ShardManifest,
): Promise<HookResult> {
  return lookupHook(tempDir, manifest.hooks?.['post-update']);
}

/**
 * Resolve `hookRelPath` inside `tempDir` and verify it stays within.
 * Rejects absolute paths and any path that normalizes to a location
 * outside the shard's extracted directory (e.g. `../../etc/shadow`).
 * A shard that declares a traversing hook path is treated as if the
 * hook is absent — the engine does not probe filesystem paths outside
 * the shard, even for existence detection.
 */
async function lookupHook(tempDir: string, hookRelPath: string | undefined): Promise<HookResult> {
  if (!hookRelPath) return { kind: 'absent' };
  const normalized = path.normalize(hookRelPath);
  if (
    path.isAbsolute(normalized) ||
    normalized.startsWith('..') ||
    normalized.split(/[\\/]/).includes('..')
  ) {
    return { kind: 'absent' };
  }
  const hookPath = path.resolve(tempDir, normalized);
  const resolvedRoot = path.resolve(tempDir);
  if (!hookPath.startsWith(resolvedRoot + path.sep) && hookPath !== resolvedRoot) {
    return { kind: 'absent' };
  }
  if (!(await pathExists(hookPath))) return { kind: 'absent' };
  return { kind: 'deferred', hookPath };
}
