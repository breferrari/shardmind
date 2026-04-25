/**
 * Build GitHub-style tarballs from `tests/fixtures/shards/obsidian-mind-like/`
 * for the contract acceptance suite (issue #92).
 *
 * The fixture is the v6 contract's behavioral matrix in concrete form:
 * three vault content modules, three agent modules, post-install +
 * post-update hooks, mixed-default-type schema. This helper produces
 * three versioned tarballs the github-stub serves so the suite can
 * exercise install / update / adopt across realistic shard movement.
 *
 *   - 6.0.0 — byte-clone of the fixture (only `version:` rewritten in
 *             the manifest so the shipped tag agrees with the manifest).
 *   - 6.0.1 — non-conflicting tweak (extra blank line at end of
 *             `Home.md.njk`); no new files; designed to silent-re-render
 *             on update with no diff prompts.
 *   - 6.1.0 — adds a new optional `research/` module (one file
 *             `research/Findings.md`) and modifies the top-of-file region
 *             of `CLAUDE.md`. Top-of-file change shape is deliberate:
 *             a user-edit at the bottom auto-merges; a user-edit at
 *             the top creates a real three-way merge conflict.
 *
 * Sibling of `tests/e2e/helpers/tarball.ts` — same mechanics
 * (idempotent cache, parallel builds, GitHub-shaped prefix). Kept
 * standalone so the existing helper's mutate functions don't drift
 * into a generic shape that has to handle every fixture's quirks.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as tar from 'tar';
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';
import { fileURLToPath } from 'node:url';
import { copyDir, hashSourceTree, cachedFilesExist } from './tarball-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const FIXTURE_DIR = path.join(
  REPO_ROOT,
  'tests',
  'fixtures',
  'shards',
  'obsidian-mind-like',
);

export type ObsMindVersion = '6.0.0' | '6.0.1' | '6.1.0';

export interface ObsidianMindTarballs {
  baseDir: string;
  byVersion: Record<ObsMindVersion, string>;
}

let cached: { key: string; fixtures: ObsidianMindTarballs } | null = null;

/**
 * Build (or reuse) the three obsidian-mind-like tarballs. Idempotent
 * per-process; identical source tree skips the rebuild.
 */
export async function buildObsidianMindTarballs(): Promise<ObsidianMindTarballs> {
  const treeKey = await hashSourceTree(FIXTURE_DIR);
  if (
    cached &&
    cached.key === treeKey &&
    (await cachedFilesExist(cached.fixtures.byVersion))
  ) {
    return cached.fixtures;
  }
  // Source-tree hash matches but disk is missing the tarballs (cache
  // populated but tempdir cleaned externally). Drop and rebuild;
  // serving a 500 from the stub on a missing fixture is hard to
  // diagnose downstream.
  cached = null;

  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shardmind-e2e-obsmind-'));

  const [v600, v601, v610] = await Promise.all([
    buildOne({
      version: '6.0.0',
      mutate: null,
      outDir: baseDir,
    }),
    buildOne({
      version: '6.0.1',
      mutate: async (work) => {
        // Non-conflicting tweak: trailing blank line in Home.md.njk.
        // Re-render still byte-equivalent to v6.0.0 modulo the trailing
        // newlines, so silent-re-render scenarios pass without diff
        // prompts.
        const home = path.join(work, 'Home.md.njk');
        const original = await fs.readFile(home, 'utf-8');
        await fs.writeFile(home, original + '\n', 'utf-8');
      },
      outDir: baseDir,
    }),
    buildOne({
      version: '6.1.0',
      mutate: async (work) => {
        // Top-of-file change to CLAUDE.md so a user edit at the bottom
        // auto-merges and a user edit at the top conflicts. The
        // replacement preserves the existing markers below the
        // top-of-file region so test assertions can still grep for them.
        const claude = path.join(work, 'CLAUDE.md');
        const original = await fs.readFile(claude, 'utf-8');
        const replaced = original.replace(
          '# Claude — vault agent',
          '# Claude — vault agent (v6.1.0 update)',
        );
        await fs.writeFile(claude, replaced, 'utf-8');

        // Add the new optional module: declare it in the schema and
        // ship one file under research/.
        const schemaPath = path.join(work, '.shardmind', 'shard-schema.yaml');
        const schemaSrc = await fs.readFile(schemaPath, 'utf-8');
        const schema = parseYaml(schemaSrc) as {
          modules: Record<string, unknown>;
        };
        schema.modules['research'] = {
          label: 'Research — wiki-style findings',
          paths: ['research/'],
          removable: true,
        };
        await fs.writeFile(schemaPath, stringifyYaml(schema), 'utf-8');

        const researchDir = path.join(work, 'research');
        await fs.mkdir(researchDir, { recursive: true });
        await fs.writeFile(
          path.join(researchDir, 'Findings.md'),
          '# Findings\n\nResearch notes — new in v6.1.0.\n',
          'utf-8',
        );
      },
      outDir: baseDir,
    }),
  ]);

  const fixtures: ObsidianMindTarballs = {
    baseDir,
    byVersion: { '6.0.0': v600, '6.0.1': v601, '6.1.0': v610 },
  };
  cached = { key: treeKey, fixtures };
  return fixtures;
}

/** Tear down the obsidian-mind tarball tempdir. Call from `afterAll`. */
export async function cleanupObsidianMindTarballs(): Promise<void> {
  if (!cached) return;
  await fs.rm(cached.fixtures.baseDir, { recursive: true, force: true });
  cached = null;
}

interface BuildOneOpts {
  version: ObsMindVersion;
  mutate: ((workDir: string) => Promise<void>) | null;
  outDir: string;
}

async function buildOne(opts: BuildOneOpts): Promise<string> {
  const workRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), `shardmind-e2e-obsmind-work-${opts.version}-`),
  );
  try {
    const prefix = `obs-mind-like-${opts.version}`;
    const workDir = path.join(workRoot, prefix);
    await copyDir(FIXTURE_DIR, workDir);

    // Manifest version must match the served tag.
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

