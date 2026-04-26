/**
 * Custom-shard tarball builder for Layer 2 hook scenarios.
 *
 * The Layer 1 flow tests' `buildCustomTarball` (under
 * `tests/component/flows/helpers.tsx`) handles schema/manifest mutations
 * but doesn't write a `hooks/post-install.ts` script — Phase 1 mostly
 * dropped hooks via `manifestOverrides: { hooks: {} }`. Layer 2's hook
 * scenarios (#26, #27, #28) need a hook file written into the tarball;
 * each scenario's hook body is different, so we accept a string the
 * caller hands in.
 *
 * Mirrors the inline pattern in `tests/e2e/cli.test.ts:626` (the
 * existing `acme/hook-demo` setup) — same minimal-shard clone + hook
 * write + tarball pack. Lifted into a helper so three scenarios don't
 * each repeat 40 lines of boilerplate.
 *
 * Spec citation: #111 Phase 2 hook scenarios — issue body Strategy
 * §Hook lifecycle (26-28).
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

export interface HookShardOptions {
  /** Tarball version stamp (`shard.yaml.version`). */
  version: string;
  /** Body of `hooks/post-install.ts`. Caller is responsible for valid TS. */
  hookSource: string;
  /**
   * Optional manifest hook timeout override (ms). When present,
   * `shard.yaml.hooks.timeout_ms` is set so a hook that hangs longer
   * than this terminates deterministically — used by scenario 28.
   */
  hookTimeoutMs?: number;
  /**
   * Tarball prefix (the single top-level directory the archive must
   * have so `download.ts`'s `tar.x({ strip: 1 })` strips it cleanly).
   * Defaults to `<name>-<version>`.
   */
  prefix: string;
  /** Output dir; tarball lands as `<outDir>/<prefix>.tar.gz`. */
  outDir: string;
}

/**
 * Build a minimal-shard-derived tarball with a custom post-install
 * hook script. Returns the absolute path to the resulting tarball.
 */
export async function buildHookFixtureShard(
  opts: HookShardOptions,
): Promise<string> {
  const workRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), `shardmind-hook-fixture-${opts.version}-`),
  );
  try {
    const workDir = path.join(workRoot, opts.prefix);
    await copyDir(MINIMAL_SHARD, workDir);

    const manifestPath = path.join(workDir, '.shardmind', 'shard.yaml');
    const manifestSrc = await fs.readFile(manifestPath, 'utf-8');
    const manifest = parseYaml(manifestSrc) as {
      hooks?: Record<string, unknown>;
      version: string;
    };
    manifest.version = opts.version;
    manifest.hooks = manifest.hooks ?? {};
    manifest.hooks['post-install'] = 'hooks/post-install.ts';
    if (opts.hookTimeoutMs !== undefined) {
      manifest.hooks['timeout_ms'] = opts.hookTimeoutMs;
    }
    await fs.writeFile(manifestPath, stringifyYaml(manifest), 'utf-8');

    const hooksDir = path.join(workDir, 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(
      path.join(hooksDir, 'post-install.ts'),
      opts.hookSource,
      'utf-8',
    );

    const tarPath = path.join(opts.outDir, `${opts.prefix}.tar.gz`);
    await tar.c({ file: tarPath, gzip: true, cwd: workRoot }, [opts.prefix]);
    return tarPath;
  } finally {
    await fs.rm(workRoot, { recursive: true, force: true });
  }
}
