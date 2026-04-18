/**
 * Read-only vault-state access for hook scripts and other downstream
 * tooling that imports from `shardmind/runtime`. Zero dependencies on
 * Ink, React, or Pastel so the bundled runtime stays tiny.
 *
 * The write path (readState/writeState/initShardDir/cacheTemplates/
 * cacheManifest) lives in `source/core/state.ts`. Keep the split
 * intentional: hooks must never mutate engine state.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ShardState } from './types.js';
import { ShardMindError } from './types.js';
import { SHARDMIND_DIR, STATE_FILE } from './vault-paths.js';

const MAX_DEPTH = 20;

export function resolveVaultRoot(): string {
  let dir = process.cwd();

  for (let i = 0; i < MAX_DEPTH; i++) {
    const shardmindDir = path.join(dir, SHARDMIND_DIR);
    if (fs.existsSync(shardmindDir) && fs.statSync(shardmindDir).isDirectory()) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new ShardMindError(
    'Not inside a ShardMind vault',
    'VAULT_NOT_FOUND',
    'Run this command from inside a vault initialized with shardmind install.',
  );
}

export async function loadState(): Promise<ShardState | null> {
  const vaultRoot = resolveVaultRoot();
  const filePath = path.join(vaultRoot, STATE_FILE);

  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf-8');
  } catch (err) {
    const fsCode = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (fsCode === 'ENOENT') return null;
    throw new ShardMindError(
      `Cannot read state.json: ${filePath}`,
      'STATE_READ_FAILED',
      err instanceof Error ? err.message : String(err),
    );
  }

  try {
    return JSON.parse(raw) as ShardState;
  } catch (err) {
    throw new ShardMindError(
      `Corrupt state.json: ${filePath}`,
      'STATE_CORRUPT',
      'Delete .shardmind/ and reinstall, or fix the JSON manually.',
    );
  }
}

export async function getIncludedModules(): Promise<string[]> {
  const state = await loadState();
  if (!state) return [];

  return Object.entries(state.modules)
    .filter(([, status]) => status === 'included')
    .map(([id]) => id);
}
