import { describe, it, expect } from 'vitest';
import { isTier1Excluded, TIER1 } from '../../source/core/tier1.js';

describe('Tier 1 exclusion set', () => {
  describe('excluded directories', () => {
    it.each(TIER1.excludedDirs)('excludes %s as a directory', (dir) => {
      expect(isTier1Excluded(dir, true)).toBe(true);
    });

    it.each(TIER1.excludedDirs)('excludes any descendant of %s', (dir) => {
      expect(isTier1Excluded(`${dir}/anything`, false)).toBe(true);
      expect(isTier1Excluded(`${dir}/nested/deep/file.md`, false)).toBe(true);
      expect(isTier1Excluded(`${dir}/sub`, true)).toBe(true);
    });

    it('does not over-match by prefix (".gitkeep" is NOT in .git/)', () => {
      expect(isTier1Excluded('.gitkeep', false)).toBe(false);
      expect(isTier1Excluded('.gitignore', false)).toBe(false);
      expect(isTier1Excluded('.githubonly.md', false)).toBe(false);
      expect(isTier1Excluded('.shardmindignore', false)).toBe(false);
    });
  });

  describe('excluded files', () => {
    it.each(TIER1.excludedFiles)('excludes the exact file %s', (file) => {
      expect(isTier1Excluded(file, false)).toBe(true);
    });

    it('does not exclude other .obsidian/ files', () => {
      expect(isTier1Excluded('.obsidian/app.json', false)).toBe(false);
      expect(isTier1Excluded('.obsidian/core-plugins.json', false)).toBe(false);
      expect(isTier1Excluded('.obsidian/themes/Minimal.css', false)).toBe(false);
      expect(isTier1Excluded('.obsidian/plugins/dataview/main.js', false)).toBe(false);
    });

    it('does not exclude when matching name appears elsewhere', () => {
      expect(isTier1Excluded('brain/workspace.json', false)).toBe(false);
      expect(isTier1Excluded('graph.json', false)).toBe(false);
    });
  });

  describe('case sensitivity (macOS / Windows)', () => {
    it('matches case-insensitively for excluded dirs (macOS HFS+ / APFS default)', () => {
      expect(isTier1Excluded('.GIT/HEAD', false)).toBe(true);
      expect(isTier1Excluded('.GitHub/workflows/ci.yml', false)).toBe(true);
      expect(isTier1Excluded('.SHARDMIND/shard.yaml', false)).toBe(true);
    });

    it('matches case-insensitively for excluded files', () => {
      expect(isTier1Excluded('.obsidian/Workspace.json', false)).toBe(true);
      expect(isTier1Excluded('.OBSIDIAN/graph.json', false)).toBe(true);
    });
  });

  describe('regular vault content', () => {
    it('does not exclude top-level dotfiles outside Tier 1', () => {
      expect(isTier1Excluded('.foo', false)).toBe(false);
      expect(isTier1Excluded('.shardmindignore', false)).toBe(false);
      expect(isTier1Excluded('.gitignore', false)).toBe(false);
      expect(isTier1Excluded('.mcp.json', false)).toBe(false);
    });

    it('does not exclude vault content folders', () => {
      expect(isTier1Excluded('brain/Idées.md', false)).toBe(false);
      expect(isTier1Excluded('Home.md', false)).toBe(false);
      expect(isTier1Excluded('.claude/commands/foo.md', false)).toBe(false);
      expect(isTier1Excluded('.codex/prompts/bar.md', false)).toBe(false);
    });

    it('handles trailing-slash variants', () => {
      // Walker passes posix paths without trailing slash, but be defensive.
      expect(isTier1Excluded('.git', true)).toBe(true);
      expect(isTier1Excluded('.shardmind', true)).toBe(true);
    });
  });
});
