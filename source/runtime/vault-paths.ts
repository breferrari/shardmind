/**
 * Vault-relative paths owned by ShardMind.
 *
 * Every other module reads these constants instead of hardcoding strings.
 * Renaming `.shardmind/` or moving the values file becomes a one-file
 * change here rather than a grep across the codebase.
 */

import path from 'node:path';

export const SHARDMIND_DIR = '.shardmind';
export const STATE_FILE = path.join(SHARDMIND_DIR, 'state.json');
export const CACHED_MANIFEST = path.join(SHARDMIND_DIR, 'shard.yaml');
export const CACHED_SCHEMA = path.join(SHARDMIND_DIR, 'shard-schema.yaml');
export const CACHED_TEMPLATES = path.join(SHARDMIND_DIR, 'templates');

/** User-authored values file. Engine creates it on install, never overwrites. */
export const VALUES_FILE = 'shard-values.yaml';

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

/** Source-side filenames inside a downloaded shard's temp directory. */
export const SHARD_MANIFEST_FILE = 'shard.yaml';
export const SHARD_SCHEMA_FILE = 'shard-schema.yaml';
export const SHARD_TEMPLATES_DIR = 'templates';
