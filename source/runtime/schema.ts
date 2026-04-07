import fsp from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ShardSchema } from './types.js';
import { ShardMindError } from './types.js';
import { resolveVaultRoot } from './state.js';

export async function loadSchema(): Promise<ShardSchema> {
  const vaultRoot = resolveVaultRoot();
  const filePath = path.join(vaultRoot, '.shardmind', 'shard-schema.yaml');

  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf-8');
  } catch {
    throw new ShardMindError(
      `Cannot read shard-schema.yaml: ${filePath}`,
      'SCHEMA_NOT_FOUND',
      'Ensure this vault has been initialized with shardmind install.',
    );
  }

  return parseYaml(raw) as ShardSchema;
}
