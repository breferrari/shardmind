import { describe, it, expect } from 'vitest';
import { isTier1Excluded, TIER1 } from '../../source/core/tier1.js';

describe('Tier 1 exclusion set', () => {
  describe('excluded directories', () => {
    it.each(TIER1.excludedDirs)('excludes %s as a directory', (dir) => {
      expect(isTier1Excluded(dir)).toBe(true);
    });

    it.each(TIER1.excludedDirs)('excludes any descendant of %s', (dir) => {
      expect(isTier1Excluded(`${dir}/anything`)).toBe(true);
      expect(isTier1Excluded(`${dir}/nested/deep/file.md`)).toBe(true);
      expect(isTier1Excluded(`${dir}/sub`)).toBe(true);
    });

    it('does not over-match by prefix (".gitkeep" is NOT in .git/)', () => {
      expect(isTier1Excluded('.gitkeep')).toBe(false);
      expect(isTier1Excluded('.gitignore')).toBe(false);
      expect(isTier1Excluded('.githubonly.md')).toBe(false);
      expect(isTier1Excluded('.shardmindignore')).toBe(false);
    });
  });

  describe('excluded files', () => {
    it.each(TIER1.excludedFiles)('excludes the exact file %s', (file) => {
      expect(isTier1Excluded(file)).toBe(true);
    });

    it('does not exclude other .obsidian/ files', () => {
      expect(isTier1Excluded('.obsidian/app.json')).toBe(false);
      expect(isTier1Excluded('.obsidian/core-plugins.json')).toBe(false);
      expect(isTier1Excluded('.obsidian/themes/Minimal.css')).toBe(false);
      expect(isTier1Excluded('.obsidian/plugins/dataview/main.js')).toBe(false);
    });

    it('does not exclude when matching name appears elsewhere', () => {
      expect(isTier1Excluded('brain/workspace.json')).toBe(false);
      expect(isTier1Excluded('graph.json')).toBe(false);
    });
  });

  describe('case sensitivity (macOS / Windows)', () => {
    it('matches case-insensitively for excluded dirs (macOS HFS+ / APFS default)', () => {
      expect(isTier1Excluded('.GIT/HEAD')).toBe(true);
      expect(isTier1Excluded('.GitHub/workflows/ci.yml')).toBe(true);
      expect(isTier1Excluded('.SHARDMIND/shard.yaml')).toBe(true);
    });

    it('matches case-insensitively for excluded files', () => {
      expect(isTier1Excluded('.obsidian/Workspace.json')).toBe(true);
      expect(isTier1Excluded('.OBSIDIAN/graph.json')).toBe(true);
    });
  });

  describe('regular vault content', () => {
    it('does not exclude top-level dotfiles outside Tier 1', () => {
      expect(isTier1Excluded('.foo')).toBe(false);
      expect(isTier1Excluded('.shardmindignore')).toBe(false);
      expect(isTier1Excluded('.gitignore')).toBe(false);
      expect(isTier1Excluded('.mcp.json')).toBe(false);
    });

    it('does not exclude vault content folders', () => {
      expect(isTier1Excluded('brain/Idées.md')).toBe(false);
      expect(isTier1Excluded('Home.md')).toBe(false);
      expect(isTier1Excluded('.claude/commands/foo.md')).toBe(false);
      expect(isTier1Excluded('.codex/prompts/bar.md')).toBe(false);
    });

    it('handles trailing-slash variants', () => {
      // Walker passes posix paths without trailing slash, but be defensive.
      expect(isTier1Excluded('.git')).toBe(true);
      expect(isTier1Excluded('.shardmind')).toBe(true);
    });
  });
});
