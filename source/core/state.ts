import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ShardState, ShardManifest, ShardSchema } from '../runtime/types.js';
import { ShardMindError } from '../runtime/types.js';
import { stringify as stringifyYaml } from 'yaml';

const STATE_SCHEMA_VERSION = 1;

export async function readState(vaultRoot: string): Promise<ShardState | null> {
  const filePath = path.join(vaultRoot, '.shardmind', 'state.json');

  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf-8');
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT') return null;
    throw new ShardMindError(
      `Cannot read state.json: ${filePath}`,
      'STATE_READ_FAILED',
      err instanceof Error ? err.message : String(err),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ShardMindError(
      `Corrupt state.json: ${filePath}`,
      'STATE_CORRUPT',
      'Delete .shardmind/ and reinstall, or fix the JSON manually.',
    );
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as { schema_version?: unknown }).schema_version !== 'number'
  ) {
    throw new ShardMindError(
      `Corrupt state.json: ${filePath}`,
      'STATE_CORRUPT',
      'Missing or invalid schema_version field.',
    );
  }

  const version = (parsed as { schema_version: number }).schema_version;
  if (version !== STATE_SCHEMA_VERSION) {
    throw new ShardMindError(
      `Unsupported state schema_version: ${version}`,
      'STATE_UNSUPPORTED_VERSION',
      `This version of shardmind supports schema_version ${STATE_SCHEMA_VERSION}.`,
    );
  }

  return parsed as ShardState;
}

export async function writeState(vaultRoot: string, state: ShardState): Promise<void> {
  const shardDir = path.join(vaultRoot, '.shardmind');
  const filePath = path.join(shardDir, 'state.json');

  await fsp.mkdir(shardDir, { recursive: true });

  if (state.schema_version !== STATE_SCHEMA_VERSION) {
    throw new ShardMindError(
      `Unsupported state schema_version: ${state.schema_version}`,
      'STATE_UNSUPPORTED_VERSION',
      `This version of shardmind writes schema_version ${STATE_SCHEMA_VERSION}.`,
    );
  }

  const serialized = JSON.stringify(state, null, 2) + '\n';
  await fsp.writeFile(filePath, serialized, 'utf-8');
}

export async function initShardDir(vaultRoot: string): Promise<void> {
  const shardDir = path.join(vaultRoot, '.shardmind');
  await fsp.mkdir(path.join(shardDir, 'templates'), { recursive: true });
}

export async function cacheTemplates(vaultRoot: string, tempDir: string): Promise<void> {
  const src = path.join(tempDir, 'templates');
  const dest = path.join(vaultRoot, '.shardmind', 'templates');

  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.mkdir(dest, { recursive: true });
  try {
    await fsp.cp(src, dest, { recursive: true });
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOENT') {
      throw new ShardMindError(
        `Missing templates/ directory in shard source: ${src}`,
        'STATE_CACHE_MISSING_TEMPLATES',
        'The downloaded shard does not contain a templates/ directory.',
      );
    }
    throw err;
  }
}

export async function cacheManifest(
  vaultRoot: string,
  manifest: ShardManifest,
  schema: ShardSchema,
): Promise<void> {
  const shardDir = path.join(vaultRoot, '.shardmind');
  await fsp.mkdir(shardDir, { recursive: true });

  const serializedManifest = stringifyYaml(manifest, { lineWidth: 0 }).trimEnd() + '\n';
  const serializedSchema = stringifyYaml(schema, { lineWidth: 0 }).trimEnd() + '\n';

  await fsp.writeFile(
    path.join(shardDir, 'shard.yaml'),
    serializedManifest,
    'utf-8',
  );
  await fsp.writeFile(
    path.join(shardDir, 'shard-schema.yaml'),
    serializedSchema,
    'utf-8',
  );
}

function errnoCode(err: unknown): string | undefined {
  if (err instanceof Error && 'code' in err) {
    return (err as NodeJS.ErrnoException).code;
  }
  return undefined;
}
