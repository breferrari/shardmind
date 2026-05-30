/**
 * Bootstrap hook for the obsidian-mind-like contract fixture (#102).
 *
 * Runs on every install/adopt (and on update when the fingerprint changes).
 * Writes only UNMANAGED paths — markers + a ctx dump for test inspection —
 * so it never crosses the bootstrap write boundary.
 *
 * Test-driven by env vars so the failure/timeout scenarios reuse one hook:
 *   SHARDMIND_HOOK_THROW=1      — throw immediately (hook-failure scenario).
 *   SHARDMIND_HOOK_SLEEP_MS=<n> — sleep <n> ms (timeout scenario; pair with a
 *                                 small `timeout_ms` in shard.yaml).
 *
 * Local interface (not an import of `shardmind/runtime`) so the hook needs
 * no resolvable dependency inside the installed vault subprocess.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface BootstrapCtx {
  slot: 'bootstrap';
  vaultRoot: string;
  values: Record<string, unknown>;
  modules: Record<string, 'included' | 'excluded'>;
  shard: { name: string; version: string };
  previousVersion?: string;
}

export default async function (ctx: BootstrapCtx): Promise<void> {
  await writeFile(
    join(ctx.vaultRoot, '.hook-ctx-bootstrap.json'),
    JSON.stringify(ctx, null, 2),
    'utf-8',
  );

  // Unmanaged marker so a scenario can prove bootstrap ran even when
  // personalize is engine-skipped (Invariant 2, defaults install).
  await writeFile(
    join(ctx.vaultRoot, '.bootstrap-marker.txt'),
    `ran for ${ctx.shard.name}@${ctx.shard.version}\n`,
    'utf-8',
  );

  const rawSleep = process.env.SHARDMIND_HOOK_SLEEP_MS;
  if (rawSleep) {
    const ms = Number(rawSleep);
    if (!Number.isFinite(ms) || ms < 0) {
      // Fail loudly so the timeout scenario can't pass for the wrong reason
      // (setTimeout(NaN) silently coerces to 0).
      throw new Error(
        `Invalid SHARDMIND_HOOK_SLEEP_MS: expected a finite ms >= 0, got ${JSON.stringify(rawSleep)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  if (process.env.SHARDMIND_HOOK_THROW === '1') {
    throw new Error('hook deliberately failed');
  }
}
