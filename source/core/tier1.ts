/**
 * Tier 1: engine-enforced exclusions on the source side of a shard.
 *
 * Authors cannot toggle these off. Spec: `docs/SHARD-LAYOUT.md §File disposition`.
 *
 *  - `.shardmind/` — engine metadata (manifest, schema, hooks); the installed
 *    side gets a fresh `.shardmind/` written by `state.ts:cacheManifest`.
 *  - `.git/` — VCS database.
 *  - `.github/` — GitHub-only metadata (CI, FUNDING, issue templates). Defensive
 *    exclusion prevents accidental Actions activation if a user later git-pushes
 *    their personal vault.
 *  - `.obsidian/{workspace,workspace-mobile,graph}.json` — Obsidian's user-specific
 *    ephemeral state files. Other `.obsidian/*` is author-controlled.
 *
 * Symlinks are rejected by the walker, not by Tier 1 path matching — they're
 * a structural reject, not a name match.
 *
 * Path matching is case-insensitive: macOS HFS+/APFS and Windows NTFS default
 * to case-insensitive filesystems, so a shard committing `.GIT/HEAD` from a
 * Windows machine must still be excluded.
 */

export const TIER1 = Object.freeze({
  excludedDirs: ['.shardmind', '.git', '.github'] as const,
  excludedFiles: [
    '.obsidian/workspace.json',
    '.obsidian/workspace-mobile.json',
    '.obsidian/graph.json',
  ] as const,
});

export function isTier1Excluded(relPosixPath: string, _isDir: boolean): boolean {
  const lower = relPosixPath.toLowerCase();
  for (const dir of TIER1.excludedDirs) {
    if (lower === dir || lower.startsWith(`${dir}/`)) {
      return true;
    }
  }
  for (const file of TIER1.excludedFiles) {
    if (lower === file) return true;
  }
  return false;
}
