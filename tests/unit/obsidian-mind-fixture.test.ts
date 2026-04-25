/**
 * Smoke tests for `tests/fixtures/shards/obsidian-mind-like/`.
 *
 * The contract acceptance suite (#92) is grounded in this fixture; a
 * regression in the fixture itself (mistyped manifest, schema drift,
 * missing hook file) would surface as ~30 cryptic E2E failures instead
 * of one obvious "fixture is broken" failure here.
 *
 * These tests parse the fixture through the engine's own loaders so
 * the smokes track the real validation surface, not a hand-rolled
 * mirror that could drift.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { parseManifest } from '../../source/core/manifest.js';
import { parseSchema } from '../../source/core/schema.js';

const FIXTURE_DIR = fileURLToPath(
  new URL('../fixtures/shards/obsidian-mind-like', import.meta.url),
);

describe('obsidian-mind-like fixture', () => {
  it('shard.yaml parses through the engine and declares both hooks', async () => {
    const manifest = await parseManifest(
      path.join(FIXTURE_DIR, '.shardmind', 'shard.yaml'),
    );
    expect(manifest.name).toBe('obs-mind-like');
    expect(manifest.namespace).toBe('acme');
    expect(manifest.version).toBe('6.0.0');
    expect(manifest.hooks['post-install']).toBe(
      '.shardmind/hooks/post-install.ts',
    );
    expect(manifest.hooks['post-update']).toBe(
      '.shardmind/hooks/post-update.ts',
    );
    // timeout_ms must round-trip — the hook-failure scenarios bump it
    // down to a tiny value to force a timeout, and a misparse would
    // silently fall back to the 30s default.
    expect(manifest.hooks.timeout_ms).toBe(30_000);
  });

  it('shard-schema.yaml parses and includes mixed-default-type values', async () => {
    const schema = await parseSchema(
      path.join(FIXTURE_DIR, '.shardmind', 'shard-schema.yaml'),
    );
    // Each value's literal default — the mixed-type set powers the
    // valuesAreDefaults adversarial scenario (default: "" / 0 / false).
    expect(schema.values['user_name']?.default).toBe('');
    expect(schema.values['org_name']?.default).toBe('Independent');
    expect(schema.values['vault_purpose']?.default).toBe('engineering');
    expect(schema.values['qmd_enabled']?.default).toBe(false);
    expect(schema.values['brain_capacity']?.default).toBe(0);

    // Module gating shape — `brain` non-removable, `perf` + agent
    // modules removable. The Claude-only scenario depends on these
    // semantics holding.
    expect(schema.modules['brain']?.removable).toBe(false);
    expect(schema.modules['perf']?.removable).toBe(true);
    expect(schema.modules['claude']?.removable).toBe(true);
    expect(schema.modules['claude']?.paths).toEqual(['CLAUDE.md', '.claude/']);
  });

  it('hook scripts exist on disk at the manifest-declared paths', () => {
    expect(
      existsSync(
        path.join(FIXTURE_DIR, '.shardmind', 'hooks', 'post-install.ts'),
      ),
    ).toBe(true);
    expect(
      existsSync(
        path.join(FIXTURE_DIR, '.shardmind', 'hooks', 'post-update.ts'),
      ),
    ).toBe(true);
  });

  it('vault content lives at native paths (flat v6 layout, no `templates/` wrapper)', () => {
    // Flat-layout sanity: a file at the shard root means a file at the
    // vault root after install. A regression that re-introduces
    // `templates/` would silently break Invariant 1 here.
    for (const rel of [
      'Home.md.njk',
      'CLAUDE.md',
      'AGENTS.md',
      'GEMINI.md',
      '.mcp.json.njk',
      '.claude/settings.json.njk',
      'brain/North Star.md',
      'brain/Patterns.md',
      'work/README.md',
      'perf/Notes.md',
    ]) {
      expect(existsSync(path.join(FIXTURE_DIR, rel))).toBe(true);
    }
  });

  it('.shardmindignore is present at shard root', () => {
    expect(existsSync(path.join(FIXTURE_DIR, '.shardmindignore'))).toBe(true);
  });
});
