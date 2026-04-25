/**
 * Build GitHub-style tarballs from `examples/minimal-shard/` for the E2E
 * stub server to serve.
 *
 * Real GitHub tarballs extract with a top-level directory (`<repo>-<sha>/`).
 * `tar.x({ strip: 1 })` in `download.ts` strips it. We replicate that shape
 * by setting a `prefix: 'minimal-shard-<version>/'` and referencing files
 * relative to the minimal-shard dir. Downstream extraction is unchanged.
 *
 * Three fixtures are produced on-demand in the suite's `beforeAll`:
 *   - v0.1.0: byte-identical mirror of `examples/minimal-shard/`
 *   - v0.2.0: one managed file content bump + one new file in `brain/`
 *   - v0.3.0: v0.2.0 plus a single-line edit in the bumped file (used
 *             to force conflicts against a pre-seeded user edit)
 *
 * Results are cached by SHA-256 of the source tree so repeated runs skip
 * rebuilding unless the source actually changed.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import * as tar from 'tar';
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const MINIMAL_SHARD = path.join(REPO_ROOT, 'examples', 'minimal-shard');

export interface TarballFixtures {
  baseDir: string; // temp dir holding the three tarballs
  byVersion: Record<'0.1.0' | '0.2.0' | '0.3.0', string>;
}

let cached: { key: string; fixtures: TarballFixtures } | null = null;

/**
 * Build (or reuse) the three tarball fixtures. Idempotent per-process.
 */
export async function buildTarballFixtures(): Promise<TarballFixtures> {
  const treeKey = await hashSourceTree(MINIMAL_SHARD);
  if (cached && cached.key === treeKey && (await cachedFilesExist(cached.fixtures))) {
    return cached.fixtures;
  }
  // The source-tree hash matches but disk is missing the tarballs — e.g. a
  // prior test run left `cached` populated but its tempdir was cleaned up
  // externally. Drop the cache and rebuild; surfacing a stale cache as a
  // 500 out of the stub would be a nightmare to diagnose.
  cached = null;

  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shardmind-e2e-tar-'));

  // Three builds run in parallel — no shared state, distinct output paths.
  // Each mutate() reads the source tree from an isolated workDir copy,
  // so cross-version contention is impossible. Saves ~2s on a cold run.
  const [v01, v02, v03] = await Promise.all([
    // v0.1.0 — byte-identical to the source
    buildOne({
      sourceDir: MINIMAL_SHARD,
      version: '0.1.0',
      mutate: null,
      outDir: baseDir,
    }),
    // v0.2.0 — bump Home.md.njk managed content + add a new file under brain/.
    // v6 layout: vault content lives at the shard root (no `templates/` wrapper).
    buildOne({
      sourceDir: MINIMAL_SHARD,
      version: '0.2.0',
      mutate: async (work) => {
        const home = path.join(work, 'Home.md.njk');
        const original = await fs.readFile(home, 'utf-8');
        await fs.writeFile(home, original + '\n\n<!-- v0.2.0 addition -->\n', 'utf-8');
        const newFile = path.join(work, 'brain', 'Changelog.md.njk');
        await fs.writeFile(
          newFile,
          '# Changelog\n\nThis file is new in v0.2.0.\n',
          'utf-8',
        );
      },
      outDir: baseDir,
    }),
    // v0.3.0 — v0.2.0 + a single-line edit inside the already-bumped file.
    // Conflict scenarios use this when the pre-seeded vault has edits on
    // the same line range.
    buildOne({
      sourceDir: MINIMAL_SHARD,
      version: '0.3.0',
      mutate: async (work) => {
        const home = path.join(work, 'Home.md.njk');
        const original = await fs.readFile(home, 'utf-8');
        const bumped = original + '\n\n<!-- v0.2.0 addition -->\nUpdated again in v0.3.0.\n';
        await fs.writeFile(home, bumped, 'utf-8');
        await fs.writeFile(
          path.join(work, 'brain', 'Changelog.md.njk'),
          '# Changelog\n\nThis file is new in v0.2.0.\nAnother line in v0.3.0.\n',
          'utf-8',
        );
      },
      outDir: baseDir,
    }),
  ]);

  const fixtures: TarballFixtures = {
    baseDir,
    byVersion: { '0.1.0': v01, '0.2.0': v02, '0.3.0': v03 },
  };
  cached = { key: treeKey, fixtures };
  return fixtures;
}

/**
 * Tear down the tarball tempdir. Call from the suite's `afterAll`.
 */
export async function cleanupTarballFixtures(): Promise<void> {
  if (!cached) return;
  await fs.rm(cached.fixtures.baseDir, { recursive: true, force: true });
  cached = null;
}

interface BuildOneOpts {
  sourceDir: string;
  version: string;
  mutate: ((workDir: string) => Promise<void>) | null;
  outDir: string;
}

async function buildOne(opts: BuildOneOpts): Promise<string> {
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), `shardmind-e2e-work-${opts.version}-`));
  try {
    // Copy the source tree into workRoot/<prefix>/
    const prefix = `minimal-shard-${opts.version}`;
    const workDir = path.join(workRoot, prefix);
    await copyDir(opts.sourceDir, workDir);

    // Bump shard.yaml version so the manifest inside the tarball agrees
    // with the tag the stub reports. v6 layout: manifest under .shardmind/.
    const manifestPath = path.join(workDir, '.shardmind', 'shard.yaml');
    const manifestSrc = await fs.readFile(manifestPath, 'utf-8');
    const manifest = parseYaml(manifestSrc) as Record<string, unknown>;
    manifest['version'] = opts.version;
    await fs.writeFile(manifestPath, stringifyYaml(manifest), 'utf-8');

    if (opts.mutate) await opts.mutate(workDir);

    const tarPath = path.join(opts.outDir, `${prefix}.tar.gz`);
    await tar.c(
      {
        file: tarPath,
        gzip: true,
        cwd: workRoot,
      },
      [prefix],
    );
    return tarPath;
  } finally {
    await fs.rm(workRoot, { recursive: true, force: true });
  }
}

async function copyDir(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const sFrom = path.join(src, entry.name);
    const sTo = path.join(dst, entry.name);
    if (entry.isDirectory()) await copyDir(sFrom, sTo);
    else if (entry.isFile()) await fs.copyFile(sFrom, sTo);
    else {
      // Symlinks, sockets, FIFOs — the minimal shard has none today, but a
      // future fixture source might. Fail loudly rather than silently drop
      // the entry (which would produce a subtly-broken tarball the CLI
      // would install without complaint).
      throw new Error(
        `copyDir: unsupported entry type at ${sFrom} (isSymbolicLink=${entry.isSymbolicLink()}). Extend the copier if you need this.`,
      );
    }
  }
}

async function cachedFilesExist(fixtures: TarballFixtures): Promise<boolean> {
  for (const tarPath of Object.values(fixtures.byVersion)) {
    try {
      await fs.access(tarPath);
    } catch {
      return false;
    }
  }
  return true;
}

async function hashSourceTree(dir: string): Promise<string> {
  const hasher = crypto.createHash('sha256');
  const stack: string[] = [dir];
  const entries: string[] = [];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const kids = await fs.readdir(current, { withFileTypes: true });
    for (const k of kids) {
      const full = path.join(current, k.name);
      if (k.isDirectory()) stack.push(full);
      else if (k.isFile()) entries.push(full);
    }
  }
  entries.sort();
  for (const entry of entries) {
    const rel = path.relative(dir, entry).replace(/\\/g, '/');
    hasher.update(rel);
    hasher.update('\0');
    hasher.update(await fs.readFile(entry));
    hasher.update('\0');
  }
  return hasher.digest('hex');
}
