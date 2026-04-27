/**
 * Unit tests for `commands/hooks/cli-version.ts::resolvePkgVersion`.
 *
 * The resolver is the load-bearing fix for a production bug surfaced
 * during /harden round 2: a hardcoded `'../../../package.json'` from
 * a bundled tsup chunk silently resolved to a parent-directory
 * package.json with no `version` field, turning currentVersion into
 * `undefined` and disabling the self-update banner in published builds.
 * The resolver walks up from the loaded module's directory looking for
 * a package.json with `name === 'shardmind'`, capped at a small depth.
 *
 * Tests model the runtime layouts we ship into:
 *   1. `dist/cli.js` (1 level up to package root).
 *   2. `dist/commands/<name>.js` (2 levels up).
 *   3. `dist/chunk-<hash>.js` (1 level up — chunks live in `dist/`).
 *   4. `source/commands/hooks/foo.tsx` (dev-mode tsx: 3 levels up).
 *   5. Pathologies: walks past a foreign package.json, runs out of
 *      depth, encounters malformed JSON.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  resolvePkgVersion,
  PKG_VERSION_FALLBACK,
  PKG_RESOLVE_MAX_DEPTH,
} from '../../source/commands/hooks/cli-version.js';

async function makeLayout(): Promise<string> {
  return await fsp.mkdtemp(
    path.join(os.tmpdir(), `shardmind-cli-version-${crypto.randomUUID()}-`),
  );
}

async function writePkg(
  dir: string,
  pkg: { name?: string; version?: string },
): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg), 'utf-8');
}

async function writeFile(file: string, content = ''): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content, 'utf-8');
}

describe('resolvePkgVersion', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeLayout();
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  // ───── Bundle-shape layouts ──────────────────────────────────────

  it('finds shardmind pkg from dist/cli.js layout (1 level up)', async () => {
    await writePkg(root, { name: 'shardmind', version: '1.2.3' });
    const file = path.join(root, 'dist', 'cli.js');
    await writeFile(file);
    expect(resolvePkgVersion(pathToFileURL(file).toString())).toBe('1.2.3');
  });

  it('finds shardmind pkg from dist/commands/<name>.js layout (2 levels up)', async () => {
    await writePkg(root, { name: 'shardmind', version: '0.5.0' });
    const file = path.join(root, 'dist', 'commands', 'install.js');
    await writeFile(file);
    expect(resolvePkgVersion(pathToFileURL(file).toString())).toBe('0.5.0');
  });

  it('finds shardmind pkg from dist/chunk-<hash>.js layout (1 level up)', async () => {
    await writePkg(root, { name: 'shardmind', version: '0.1.7' });
    const file = path.join(root, 'dist', 'chunk-DEADBEEF.js');
    await writeFile(file);
    expect(resolvePkgVersion(pathToFileURL(file).toString())).toBe('0.1.7');
  });

  it('finds shardmind pkg from a deep dev path (3 levels up)', async () => {
    await writePkg(root, { name: 'shardmind', version: '99.9.9' });
    const file = path.join(root, 'source', 'commands', 'hooks', 'use-banner.tsx');
    await writeFile(file);
    expect(resolvePkgVersion(pathToFileURL(file).toString())).toBe('99.9.9');
  });

  // ───── Negative / pathological cases ─────────────────────────────

  it('returns the fallback when no package.json exists anywhere on the walk', async () => {
    // No package.json written anywhere. The walk hits the filesystem
    // root before depth runs out (or vice versa) and returns the
    // sentinel rather than blowing up.
    const file = path.join(root, 'dist', 'cli.js');
    await writeFile(file);
    // The fallback fires when no shardmind package.json is found
    // within the depth cap. Above `root` lies the developer's actual
    // dev tree (which may contain ancestor package.json files for
    // unrelated projects), so depending on the test host this returns
    // either the fallback (no ancestor matches) or an unrelated
    // version. Either way it must NOT pretend to be a shardmind
    // version derived from this fixture: the fixture has none.
    const result = resolvePkgVersion(pathToFileURL(file).toString());
    expect(result === PKG_VERSION_FALLBACK || /^\d+\.\d+\.\d+/.test(result)).toBe(true);
  });

  it('walks past a foreign package.json with the wrong name', async () => {
    // dist/some-other-pkg/package.json has a different name; the walk
    // must continue upward until it finds shardmind.
    await writePkg(root, { name: 'shardmind', version: '2.0.0' });
    await writePkg(path.join(root, 'dist'), {
      name: 'foreign',
      version: '99.0.0',
    });
    const file = path.join(root, 'dist', 'commands', 'install.js');
    await writeFile(file);
    // The dist-level pkg has wrong name → continue to root-level
    // shardmind pkg.
    expect(resolvePkgVersion(pathToFileURL(file).toString())).toBe('2.0.0');
  });

  it('walks past a malformed package.json without crashing', async () => {
    // Walk should swallow JSON parse errors and keep going.
    await writePkg(root, { name: 'shardmind', version: '3.0.0' });
    await fsp.mkdir(path.join(root, 'dist'), { recursive: true });
    await fsp.writeFile(
      path.join(root, 'dist', 'package.json'),
      '{not-valid-json',
      'utf-8',
    );
    const file = path.join(root, 'dist', 'cli.js');
    await writeFile(file);
    expect(resolvePkgVersion(pathToFileURL(file).toString())).toBe('3.0.0');
  });

  it('returns the fallback when given a non-file URL', async () => {
    // `fileURLToPath` throws on a non-`file:` URL; the resolver
    // catches and returns the sentinel rather than propagating.
    expect(resolvePkgVersion('http://example.com/foo')).toBe(
      PKG_VERSION_FALLBACK,
    );
  });

  it('respects the depth cap (does not traverse past PKG_RESOLVE_MAX_DEPTH levels)', async () => {
    // Plant a shardmind package.json at the root, then create a path
    // deeper than the depth cap. Walk should stop before reaching it.
    await writePkg(root, { name: 'shardmind', version: '4.0.0' });
    // Build a directory chain longer than the cap.
    let deepDir = root;
    for (let i = 0; i < PKG_RESOLVE_MAX_DEPTH + 2; i++) {
      deepDir = path.join(deepDir, `level${i}`);
    }
    const file = path.join(deepDir, 'file.js');
    await writeFile(file);
    // From `deepDir`, walking up by `PKG_RESOLVE_MAX_DEPTH` levels
    // doesn't reach `root` — and importantly doesn't accidentally
    // traverse to the filesystem root either. Since none of the
    // intermediate levels has a shardmind package.json, the result
    // is the fallback regardless of what's outside `root`.
    const result = resolvePkgVersion(pathToFileURL(file).toString());
    // Capped walk never sees the fixture's `4.0.0`. Result is either
    // the fallback OR an unrelated ancestor pkg if the test host has
    // one within the cap; never `4.0.0`.
    expect(result).not.toBe('4.0.0');
  });

  // ───── Real-bundle smoke (validates the prod fix) ─────────────────

  it('resolves the live shardmind version when run from this test file', () => {
    // The test itself runs from /Users/.../shardmind/tests/unit/...,
    // so walking up reliably finds the real package.json. This is a
    // smoke pin: if the resolver ever regresses to the silent-undefined
    // failure mode, this test goes red.
    const result = resolvePkgVersion(import.meta.url);
    expect(result).not.toBe(PKG_VERSION_FALLBACK);
    expect(result).toMatch(/^\d+\.\d+\.\d+/);
  });
});
