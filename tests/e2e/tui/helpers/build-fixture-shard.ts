/**
 * Custom-shard tarball builders for Layer 2 scenarios.
 *
 * Two named exports share a private `cloneAndPack` core:
 *
 *   - `buildHookFixtureShard` — clones minimal-shard, writes
 *     `hooks/post-install.ts` with a caller-supplied body, and tars
 *     it. Used by the three hook-lifecycle scenarios (#26-28).
 *   - `buildMutatedShard` — clones minimal-shard and runs a `mutate`
 *     callback on the working tree before tarballing. Used by
 *     scenario 14 (multi-file conflict drift on update).
 *
 * The Layer 1 flow tests' `buildCustomTarball` (in
 * `tests/component/flows/helpers.tsx`) is React-importing (.tsx);
 * a `.ts` consumer can't pull it in without dragging React + Ink
 * into the import graph. This file is the Layer 2 equivalent —
 * mirrors the same shape, but stays free of UI dependencies so
 * `tests/e2e/tui/*.test.ts` files can import it directly.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as tar from 'tar';
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';
import { fileURLToPath } from 'node:url';
import { copyDir } from '../../helpers/tarball-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const MINIMAL_SHARD = path.join(REPO_ROOT, 'examples', 'minimal-shard');

interface BaseShardOpts {
  /** Tarball version stamp (`shard.yaml.version`). */
  version: string;
  /**
   * Override `shard.yaml.name`. Without it, the manifest carries
   * minimal-shard's `shardmind/minimal` identity; the engine
   * renders that in the install/update Summary regardless of the
   * install slug. Each scenario fixture should declare its own
   * identity so a test failure's screen capture points at the
   * right shard.
   */
  name?: string;
  /** Override `shard.yaml.namespace`. See `name`. */
  namespace?: string;
  /**
   * Optional manifest hook timeout override (ms). When present,
   * `shard.yaml.hooks.timeout_ms` is set so a hook that hangs
   * longer than this terminates deterministically — used by
   * scenario 28.
   */
  hookTimeoutMs?: number;
  /**
   * Whether to drop `manifest.hooks` entirely. Set true for
   * scenarios that don't want the post-install phase to fire at
   * all (e.g. multi-conflict update scenarios). Ignored when
   * `hookSource` is used inside `buildHookFixtureShard` — that
   * path always declares a hook.
   */
  dropHooks?: boolean;
  /**
   * Tarball prefix (the single top-level directory the archive must
   * have so `download.ts`'s `tar.x({ strip: 1 })` strips it
   * cleanly).
   */
  prefix: string;
  /** Output dir; tarball lands as `<outDir>/<prefix>.tar.gz`. */
  outDir: string;
}

export interface HookShardOptions extends BaseShardOpts {
  /** Body of `hooks/post-install.ts`. Caller is responsible for valid TS. */
  hookSource: string;
}

export interface MutatedShardOptions extends BaseShardOpts {
  /**
   * Arbitrary mutation on the cloned working tree before tarballing.
   * Use to append to .njk paths, write extra files, etc. Receives
   * the absolute path to the cloned shard root.
   */
  mutate: (workDir: string) => Promise<void>;
}

/**
 * Build a minimal-shard-derived tarball with a custom post-install
 * hook script. Returns the absolute path to the resulting tarball.
 */
export async function buildHookFixtureShard(
  opts: HookShardOptions,
): Promise<string> {
  return cloneAndPack(opts, async (workDir) => {
    // Hook fixtures always declare the post-install slot; the
    // optional `dropHooks` BaseShardOpts flag is ignored here.
    const manifest = await readManifest(workDir);
    manifest.hooks = manifest.hooks ?? {};
    manifest.hooks['post-install'] = 'hooks/post-install.ts';
    if (opts.hookTimeoutMs !== undefined) {
      manifest.hooks['timeout_ms'] = opts.hookTimeoutMs;
    }
    await writeManifest(workDir, manifest);

    const hooksDir = path.join(workDir, 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(
      path.join(hooksDir, 'post-install.ts'),
      opts.hookSource,
      'utf-8',
    );
  });
}

/**
 * Build a minimal-shard-derived tarball with arbitrary file-tree
 * mutations. Used by scenarios that need to manufacture conflicts,
 * add files, or otherwise diverge the shard from the baseline
 * fixture without writing a hook.
 */
export async function buildMutatedShard(
  opts: MutatedShardOptions,
): Promise<string> {
  return cloneAndPack(opts, async (workDir) => {
    if (opts.dropHooks) {
      const manifest = await readManifest(workDir);
      manifest.hooks = {};
      await writeManifest(workDir, manifest);
    }
    await opts.mutate(workDir);
  });
}

// ───── Internal: shared clone + manifest + pack ──────────────────────

async function cloneAndPack(
  opts: BaseShardOpts,
  customize: (workDir: string) => Promise<void>,
): Promise<string> {
  const workRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), `shardmind-fixture-${opts.version}-`),
  );
  try {
    const workDir = path.join(workRoot, opts.prefix);
    await copyDir(MINIMAL_SHARD, workDir);

    const manifest = await readManifest(workDir);
    manifest.version = opts.version;
    if (opts.name !== undefined) {
      (manifest as Record<string, unknown>)['name'] = opts.name;
    }
    if (opts.namespace !== undefined) {
      (manifest as Record<string, unknown>)['namespace'] = opts.namespace;
    }
    await writeManifest(workDir, manifest);

    await customize(workDir);

    const tarPath = path.join(opts.outDir, `${opts.prefix}.tar.gz`);
    await tar.c({ file: tarPath, gzip: true, cwd: workRoot }, [opts.prefix]);
    return tarPath;
  } finally {
    await fs.rm(workRoot, { recursive: true, force: true });
  }
}

interface ManifestShape {
  version?: string;
  hooks?: Record<string, unknown>;
}

async function readManifest(workDir: string): Promise<ManifestShape> {
  const manifestPath = path.join(workDir, '.shardmind', 'shard.yaml');
  const src = await fs.readFile(manifestPath, 'utf-8');
  return parseYaml(src) as ManifestShape;
}

async function writeManifest(
  workDir: string,
  manifest: ManifestShape,
): Promise<void> {
  const manifestPath = path.join(workDir, '.shardmind', 'shard.yaml');
  await fs.writeFile(manifestPath, stringifyYaml(manifest), 'utf-8');
}
