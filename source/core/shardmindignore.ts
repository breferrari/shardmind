/**
 * `.shardmindignore` — gitignore-spec glob matcher for shard sources.
 *
 * Wraps the `ignore` package (battle-tested gitignore implementation used by
 * ESLint, Prettier, etc.) with a pre-pass that rejects negation patterns
 * (`!pattern`). Negation is deferred to v0.2 per #87 and the spec
 * (`docs/SHARD-LAYOUT.md §Naming decisions`); rejecting it here keeps the
 * v0.1 contract honest with a clear error instead of silent acceptance.
 *
 * Missing file → empty filter (matches nothing). Comments and blank lines
 * are honored.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import ignore from 'ignore';
import { ShardMindError } from '../runtime/types.js';
import { errnoCode } from '../runtime/errno.js';

export interface IgnoreFilter {
  ignores(relPosixPath: string, isDir: boolean): boolean;
}

const SHARDMINDIGNORE_FILE = '.shardmindignore';

export async function loadShardmindignore(rootDir: string): Promise<IgnoreFilter> {
  let source: string;
  try {
    source = await fsp.readFile(path.join(rootDir, SHARDMINDIGNORE_FILE), 'utf-8');
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') {
      return EMPTY_FILTER;
    }
    throw new ShardMindError(
      `Failed to read .shardmindignore: ${(err as Error).message ?? String(err)}`,
      'SHARDMINDIGNORE_READ_FAILED',
      `Check that ${SHARDMINDIGNORE_FILE} at the shard root is readable.`,
    );
  }
  return parseShardmindignore(source);
}

export function parseShardmindignore(source: string): IgnoreFilter {
  const lines = source.split(/\r?\n/);
  const negations: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('!')) negations.push(i + 1);
  }
  if (negations.length > 0) {
    const lineList = negations.map((n) => `line ${n}`).join(', ');
    throw new ShardMindError(
      `.shardmindignore: negation patterns (\`!pattern\`) are not supported in v0.1 (${lineList}).`,
      'SHARDMINDIGNORE_NEGATION_UNSUPPORTED',
      'Remove the leading `!` or wait for negation support in v0.2 (#87).',
    );
  }

  const ig = ignore().add(source);
  return {
    ignores(relPosixPath, isDir) {
      const candidate = isDir && !relPosixPath.endsWith('/')
        ? `${relPosixPath}/`
        : relPosixPath;
      return ig.ignores(candidate);
    },
  };
}

const EMPTY_FILTER: IgnoreFilter = {
  ignores: () => false,
};
