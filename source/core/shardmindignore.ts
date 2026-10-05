/**
 * `.shardmindignore` — gitignore-spec glob matcher for shard sources.
 *
 * Wraps the `ignore` package (battle-tested gitignore implementation used by
 * ESLint, Prettier, etc.), negation included (#87): a later `!pattern`
 * re-includes what an earlier pattern excluded, and, as in git, a path under
 * an excluded folder stays excluded. The walker never enters an ignored
 * folder, which agrees with that rule.
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
  ignores: (_relPosixPath: string, _isDir: boolean) => false,
};
