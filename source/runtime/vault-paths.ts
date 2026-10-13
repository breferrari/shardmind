/**
 * Vault-relative paths owned by ShardMind.
 *
 * Every other module reads these constants instead of hardcoding strings.
 * Renaming `.shardmind/` or moving the values file becomes a one-file
 * change here rather than a grep across the codebase.
 */

import path from 'node:path';
import { ShardMindError } from './types.js';

export const SHARDMIND_DIR = '.shardmind';
export const STATE_FILE = path.join(SHARDMIND_DIR, 'state.json');
export const CACHED_MANIFEST = path.join(SHARDMIND_DIR, 'shard.yaml');
export const CACHED_SCHEMA = path.join(SHARDMIND_DIR, 'shard-schema.yaml');
/** The template cache's folder name inside an engine folder (`.shardmind/`, or an overlay's, #396). */
export const TEMPLATES_DIR = 'templates';
export const CACHED_TEMPLATES = path.join(SHARDMIND_DIR, TEMPLATES_DIR);

/**
 * Where a crashed (or verbose) hook's full captured output is persisted so
 * the Summary can truncate the on-screen block and point the user at the
 * complete log. Under `.shardmind/`, so it is excluded from Invariant 1
 * byte-equivalence ("modulo `.shardmind/` metadata"). See `hook-orchestrator.ts`.
 */
export const HOOK_LOGS_DIR = path.join(SHARDMIND_DIR, 'logs');
/** The vault owner's list of folders the personalize boundary walk skips (#190). Never shipped, never written by the engine. */
export const BOUNDARY_IGNORE_FILE = path.join(SHARDMIND_DIR, 'boundary-ignore');

/** Every hook slot a shard can declare in `shard.yaml`; `HookSlot` is derived from it. */
export const HOOK_STAGES = ['bootstrap', 'personalize', 'post-update'] as const;

/**
 * Vault-relative path of one slot's full hook log, e.g.
 * `.shardmind/logs/bootstrap.log`. Returned with forward slashes — it doubles
 * as a user-facing pointer in the Summary, and `path.join(vaultRoot, …)`
 * resolves a posix-style relative path correctly on every platform.
 */
export function hookLogRelPath(slot: string, shard?: string): string {
  if (shard === undefined) return `${SHARDMIND_DIR}/logs/${slot}.log`;
  const [namespace, name] = shardNameParts(shard);
  return `${SHARDMIND_DIR}/logs/${namespace}/${name}/${slot}.log`;
}

/**
 * An overlay shard's own engine folder (#396): its cached `shard.yaml`,
 * `shard-schema.yaml` and templates, `.shardmind/shards/<namespace>/<name>`.
 * The base shard's stay at `.shardmind/`.
 */
export function overlayDir(shard: string): string {
  const [namespace, name] = shardNameParts(shard);
  return path.join(SHARDMIND_DIR, 'shards', namespace, name);
}

/** An overlay shard's values file at the vault root (#396): `shard-values.<namespace>.<name>.yaml`. */
export function overlayValuesFile(shard: string): string {
  const [namespace, name] = shardNameParts(shard);
  return `shard-values.${namespace}.${name}.yaml`;
}

/**
 * `<namespace>/<name>` split, or a throw: a shard name builds paths, so one
 * with another shape (an empty part, a `..`, a further slash) never does.
 */
function shardNameParts(shard: string): [string, string] {
  const parts = shard.split('/');
  if (parts.length !== 2 || parts.some((part) => part === '' || part === '.' || part === '..' || part.includes('\\'))) {
    throw new ShardMindError(
      `Not a <namespace>/<name> shard name: ${JSON.stringify(shard)}`,
      'ARGS_INVALID',
      'Name a shard as <namespace>/<name>, as state.json lists it (e.g. acme/research).',
    );
  }
  return [parts[0]!, parts[1]!];
}

/** User-authored values file. Engine creates it on install, never overwrites. */
export const VALUES_FILE = 'shard-values.yaml';
/** One run per vault (#253): held by install, update and adopt for the whole run. At the root: a run moves or deletes `.shardmind/`. */
export const LOCK_FILE = '.shardmind.lock';
/** Held only while a run removes a stale lock, so two runs never both take it over (#253). */
export const LOCK_TAKEOVER_FILE = '.shardmind.lock.takeover';

/** Claude Code namespace inside the vault (commands, agents, settings). */
export const CLAUDE_DIR = '.claude';

/** Codex prompts namespace. */
export const CODEX_DIR = '.codex/prompts';

/**
 * Third-party vault metadata directories that ShardMind never claims to
 * manage. Named here so drift detection and any future scan paths share
 * one blacklist instead of sprinkling literal strings across modules.
 */
export const GIT_DIR = '.git';
export const OBSIDIAN_DIR = '.obsidian';

/**
 * Source-side engine metadata directory inside an extracted shard tarball.
 * Contains `shard.yaml`, `shard-schema.yaml`, and `hooks/`. Walker excludes
 * this dir from the install set (Tier 1); the engine reads it directly.
 */
export const SHARD_SOURCE_DIR = '.shardmind';

/** Source-side filenames inside a downloaded shard's `.shardmind/` dir. */
export const SHARD_MANIFEST_FILE = 'shard.yaml';
export const SHARD_SCHEMA_FILE = 'shard-schema.yaml';
