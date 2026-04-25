/**
 * Smoke tests for `tests/e2e/helpers/obsidian-mind-tarball.ts`.
 *
 * The contract acceptance suite (#92) depends on three versioned
 * tarballs. A regression in the builder (wrong version stamped, missing
 * mutate, broken cache) would surface as cryptic E2E failures; pinning
 * the builder here lets that failure be one-line obvious.
 *
 * Lives under integration/ rather than unit/ because building tarballs
 * involves disk + tar — heavier than a pure-function unit test, but
 * cheap relative to the E2E suite that consumes the output.
 */

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as tar from 'tar';
import { parse as parseYaml } from 'yaml';
import {
  buildObsidianMindTarballs,
  cleanupObsidianMindTarballs,
} from '../e2e/helpers/obsidian-mind-tarball.js';

afterAll(async () => {
  await cleanupObsidianMindTarballs();
});

describe('obsidian-mind tarball helper', () => {
  it('builds three tarballs at the expected versions with the expected file deltas', async () => {
    const fixtures = await buildObsidianMindTarballs();
    expect(fixtures.byVersion['6.0.0']).toBeTruthy();
    expect(fixtures.byVersion['6.0.1']).toBeTruthy();
    expect(fixtures.byVersion['6.1.0']).toBeTruthy();
    for (const tarPath of Object.values(fixtures.byVersion)) {
      expect(await fs.stat(tarPath).then((s) => s.size > 0)).toBe(true);
    }

    const v600 = await extractListing(fixtures.byVersion['6.0.0']);
    const v610 = await extractListing(fixtures.byVersion['6.1.0']);

    // 6.0.0 manifest reports its own version (set by the builder so the
    // shipped tag and the cached manifest agree).
    expect(v600.manifestVersion).toBe('6.0.0');
    expect(v610.manifestVersion).toBe('6.1.0');

    // 6.0.0 has no research/ module; 6.1.0 added one.
    expect(v600.files).not.toContain('research/Findings.md');
    expect(v610.files).toContain('research/Findings.md');

    // 6.1.0 modified CLAUDE.md's top-of-file region — pin so a future
    // mutate refactor doesn't quietly stop creating the conflict shape
    // the suite depends on.
    expect(v610.claudeTop).toContain('v6.1.0 update');
    expect(v600.claudeTop).not.toContain('v6.1.0 update');
  }, 30_000);

  it('is idempotent across calls (returns the cached fixtures)', async () => {
    const a = await buildObsidianMindTarballs();
    const b = await buildObsidianMindTarballs();
    expect(b.baseDir).toBe(a.baseDir);
    expect(b.byVersion).toEqual(a.byVersion);
  }, 30_000);
});

async function extractListing(tarPath: string): Promise<{
  files: string[];
  manifestVersion: string;
  claudeTop: string;
}> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'obs-mind-extract-'));
  try {
    await tar.x({ file: tarPath, cwd: tmp, strip: 1 });
    const files: string[] = [];
    await walk(tmp, tmp, files);
    const manifestSrc = await fs.readFile(
      path.join(tmp, '.shardmind', 'shard.yaml'),
      'utf-8',
    );
    const manifest = parseYaml(manifestSrc) as { version: string };
    const claudeSrc = await fs.readFile(path.join(tmp, 'CLAUDE.md'), 'utf-8');
    return {
      files: files.sort(),
      manifestVersion: manifest.version,
      claudeTop: claudeSrc.split('\n').slice(0, 3).join('\n'),
    };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(root, abs, out);
    else if (entry.isFile()) out.push(path.relative(root, abs).replace(/\\/g, '/'));
  }
}
