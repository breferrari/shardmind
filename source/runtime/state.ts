import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ShardState } from './types.js';
import { ShardMindError } from './types.js';

const MAX_DEPTH = 20;

export function resolveVaultRoot(): string {
  let dir = process.cwd();

  for (let i = 0; i < MAX_DEPTH; i++) {
    const shardmindDir = path.join(dir, '.shardmind');
    if (fs.existsSync(shardmindDir) && fs.statSync(shardmindDir).isDirectory()) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
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
  const filePath = path.join(vaultRoot, '.shardmind', 'state.json');

  try {
    const raw = await fsp.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as ShardState;
  } catch {
    return null;
  }
}

export async function getIncludedModules(): Promise<string[]> {
  const state = await loadState();
  if (!state) return [];

  return Object.entries(state.modules)
    .filter(([, status]) => status === 'included')
    .map(([id]) => id);
}
