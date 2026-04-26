/**
 * Layer 1 TUI flow-test harness.
 *
 * Each test mounts a whole CLI command (`<Install>`, `<Update>`,
 * `<Adopt>`, `<Index>`) via `ink-testing-library` and drives it through
 * stdin. The command's network calls are routed through the existing
 * `tests/e2e/helpers/github-stub.ts` (one stub per test file, started
 * in `beforeAll`); `process.cwd()` is spied per-test so the command's
 * hardcoded `vaultRoot: process.cwd()` resolves to a fresh temp dir.
 *
 * This file owns the wiring; per-command scenario files own the
 * scenarios. Keeping the harness terse means a new command (or a new
 * variant of an existing one) drops in alongside without re-implementing
 * the env / cwd / stub plumbing.
 *
 * Spec citation: [#111](https://github.com/breferrari/shardmind/issues/111) Phase 1
 * (Layer 1, the highest-yield of the three layers — both #103 and #109
 * would have been caught here).
 */

import React from 'react';
import { render, type RenderResult } from 'ink-testing-library';
import { vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';
import * as tar from 'tar';
import { tick, waitFor, ENTER, typeText } from '../helpers.js';

import Install from '../../../source/commands/install.js';
import Update from '../../../source/commands/update.js';
import Adopt from '../../../source/commands/adopt.js';
import Index from '../../../source/commands/index.js';

import {
  createGitHubStub,
  type GitHubStub,
  type ShardSpec,
} from '../../e2e/helpers/github-stub.js';
import {
  buildTarballFixtures,
  type TarballFixtures,
} from '../../e2e/helpers/tarball.js';
import { copyDir } from '../../e2e/helpers/tarball-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const MINIMAL_SHARD = path.join(REPO_ROOT, 'examples', 'minimal-shard');

// ───── Shared test constants ───────────────────────────────────────

/**
 * Slug used by every flow-test file when installing minimal-shard
 * via the github-stub. Picked arbitrarily; the engine doesn't enforce
 * `manifest.namespace/name` equality with the install slug, so the
 * stub maps `acme/demo` → minimal-shard tarballs and the rendered
 * frames show the manifest's `shardmind/minimal` heading.
 */
export const SHARD_SLUG = 'acme/demo';
export const SHARD_REF = `github:${SHARD_SLUG}`;

/**
 * The `--values` shape every scenario uses for non-interactive paths
 * (createInstalledVault subprocess install + scenario 23's adopt
 * `--yes` + values prefill). Mirrors minimal-shard's four schema
 * values; coerced to YAML when written to disk by the helpers.
 */
export const DEFAULT_VALUES: Record<string, unknown> = {
  user_name: 'Alice',
  org_name: 'Acme Labs',
  vault_purpose: 'engineering',
  qmd_enabled: true,
};

/**
 * 40-char hex placeholder for ref-install scenarios. The github-stub
 * stores ref → SHA → tarball mappings byte-opaquely, so any 40-char
 * hex value works as a stand-in. Hoisted so the regex shape doesn't
 * leak into every scenario.
 */
export const STUB_SHA = 'a'.repeat(40);

export interface FlowSuiteContext {
  stub: GitHubStub;
  fixtures: TarballFixtures;
}

const tempVaults = new Set<string>();

export async function makeVaultDir(prefix = 'flow'): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), `shardmind-flow-${prefix}-`),
  );
  tempVaults.add(root);
  return root;
}

export async function cleanupVault(root: string): Promise<void> {
  tempVaults.delete(root);
  await fs.rm(root, { recursive: true, force: true });
}

async function cleanupAllVaults(): Promise<void> {
  for (const v of [...tempVaults]) {
    await fs.rm(v, { recursive: true, force: true }).catch(() => {});
  }
  tempVaults.clear();
}

/**
 * Spy `process.cwd()` to return the given vault root. The four CLI
 * commands hardcode `vaultRoot: process.cwd()` at render time, so this
 * is the single seam Layer 1 tests use to point a command at a temp
 * vault. Restored via `vi.restoreAllMocks()` in the afterEach the
 * suite-setup helper installs.
 */
export function mockCwd(vaultRoot: string): void {
  vi.spyOn(process, 'cwd').mockReturnValue(vaultRoot);
}

export interface SetupSuiteOpts {
  shards: Record<string, ShardSpec>;
}

/**
 * Suite-level setup: builds tarball fixtures, starts a github-stub on
 * a random port, points `SHARDMIND_GITHUB_API_BASE` at it BEFORE any
 * scenario runs, and registers afterAll teardown + per-test cwd
 * restoration. Returns a `getContext()` accessor so individual tests
 * can reach the stub + fixtures.
 *
 * Call once per file from the top-level describe — vitest's
 * `beforeAll`/`afterAll` registrations stack within file scope.
 *
 * Why call-time env-var read matters: `source/core/registry.ts` was
 * refactored to read `SHARDMIND_GITHUB_API_BASE` at call time so
 * `beforeAll` mutations land before the next `resolve()` even though
 * the static-import graph has already imported the module.
 */
export function setupFlowSuite(opts: SetupSuiteOpts): () => FlowSuiteContext {
  let ctx: FlowSuiteContext | null = null;
  const originalApiBase = process.env['SHARDMIND_GITHUB_API_BASE'];
  // The self-update notifier (#113) fires `checkSelfUpdate` from each
  // command's mount under `process.stdout.isTTY` ⇒ true (the dev runs
  // `npm test` in a real terminal). Without this opt-out, every flow
  // mount would race a live `registry.npmjs.org` GET — flaky, slow, and
  // a network hit from tests is just wrong. Set the suppression env var
  // for the suite's lifetime; the dedicated self-update flow file
  // deletes it per-test to exercise the rendering path against a local
  // stub.
  const originalNoSelfUpdate = process.env['SHARDMIND_NO_UPDATE_CHECK'];

  beforeAll(async () => {
    const fixtures = await buildTarballFixtures();
    const stub = await createGitHubStub({ shards: opts.shards });
    process.env['SHARDMIND_GITHUB_API_BASE'] = stub.url;
    process.env['SHARDMIND_NO_UPDATE_CHECK'] = '1';
    ctx = { stub, fixtures };
  }, 90_000);

  afterAll(async () => {
    if (ctx) await ctx.stub.close();
    if (originalApiBase !== undefined) {
      process.env['SHARDMIND_GITHUB_API_BASE'] = originalApiBase;
    } else {
      delete process.env['SHARDMIND_GITHUB_API_BASE'];
    }
    if (originalNoSelfUpdate !== undefined) {
      process.env['SHARDMIND_NO_UPDATE_CHECK'] = originalNoSelfUpdate;
    } else {
      delete process.env['SHARDMIND_NO_UPDATE_CHECK'];
    }
    await cleanupAllVaults();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  return () => {
    if (!ctx) {
      throw new Error(
        'setupFlowSuite: context not yet ready (called before beforeAll resolved?).',
      );
    }
    return ctx;
  };
}

// Per-command mounting wrappers. Each spies `process.cwd` first, then
// renders the default-exported command React component with the same
// shape Pastel hands at runtime. Tests interact via the returned
// `RenderResult` (`stdin.write`, `lastFrame`, `unmount`).

export interface InstallOptions {
  values?: string;
  yes?: boolean;
  defaults?: boolean;
  verbose?: boolean;
  dryRun?: boolean;
}

export function mountInstall(opts: {
  shardRef: string;
  vaultRoot: string;
  options?: InstallOptions;
}): RenderResult {
  mockCwd(opts.vaultRoot);
  return render(
    <Install
      args={[opts.shardRef]}
      options={{
        yes: false,
        defaults: false,
        verbose: false,
        dryRun: false,
        ...opts.options,
      }}
    />,
  );
}

export interface UpdateOptions {
  yes?: boolean;
  verbose?: boolean;
  dryRun?: boolean;
  release?: string;
  includePrerelease?: boolean;
}

export function mountUpdate(opts: {
  vaultRoot: string;
  options?: UpdateOptions;
}): RenderResult {
  mockCwd(opts.vaultRoot);
  return render(
    <Update
      options={{
        yes: false,
        verbose: false,
        dryRun: false,
        includePrerelease: false,
        ...opts.options,
      }}
    />,
  );
}

export interface AdoptOptions {
  values?: string;
  yes?: boolean;
  verbose?: boolean;
  dryRun?: boolean;
}

export function mountAdopt(opts: {
  shardRef: string;
  vaultRoot: string;
  options?: AdoptOptions;
}): RenderResult {
  mockCwd(opts.vaultRoot);
  return render(
    <Adopt
      args={[opts.shardRef]}
      options={{
        yes: false,
        verbose: false,
        dryRun: false,
        ...opts.options,
      }}
    />,
  );
}

export interface StatusOptions {
  verbose?: boolean;
}

export function mountStatus(opts: {
  vaultRoot: string;
  options?: StatusOptions;
}): RenderResult {
  mockCwd(opts.vaultRoot);
  return render(
    <Index
      options={{
        verbose: false,
        ...opts.options,
      }}
    />,
  );
}

/**
 * Build a custom shard tarball with hand-rolled schema / manifest /
 * content mutations. Used by scenarios where the minimal-shard fixture
 * shape doesn't fit (number type, computed default, multi-conflict
 * content drift, schemas with new required values).
 *
 * Mirrors the inline tarball scaffolding pattern in
 * `tests/e2e/obsidian-mind-contract.test.ts` describe-blocks 22/25/27/28/29
 * but parameterized so flow tests don't reinvent the wheel per scenario.
 */
export interface BuildCustomTarballOpts {
  /** Stamped into shard.yaml `version` and the tarball prefix. */
  version: string;
  /**
   * If set, writes this YAML-stringified object to
   * `.shardmind/shard-schema.yaml`, overwriting the source schema.
   */
  schema?: object;
  /**
   * Merged on top of the parsed `.shardmind/shard.yaml`. Use to drop
   * `hooks` (avoid the running-hook phase entirely), bump `apiVersion`,
   * etc.
   */
  manifestOverrides?: Record<string, unknown>;
  /** Arbitrary mutation on the working tree before tarballing. */
  mutate?: (workDir: string) => Promise<void>;
  /** Output dir; tarball lands as `<outDir>/<prefix>.tar.gz`. */
  outDir: string;
  /**
   * Tarball prefix. The archive must contain a single top-level directory
   * (one shared leading path segment across every entry) so
   * `download.ts`'s `tar.x({ strip: 1 })` can strip it. The directory's
   * name doesn't matter; the production tarballs we mirror happen to use
   * GitHub's `<repo>-<sha>/` shape. Defaults to `minimal-shard-<version>`.
   */
  prefix?: string;
}

/**
 * Tmp dir prefix `buildCustomTarball` uses under `os.tmpdir()`.
 * Exported so the harness's mutate-throw cleanup test can scan for
 * orphans against the same prefix the helper writes — without the
 * shared constant, a future rename here would silently let the
 * test pass even on a regression that leaks tmp dirs.
 */
export const CUSTOM_TAR_TMP_PREFIX = 'shardmind-custom-tar-';

export async function buildCustomTarball(
  opts: BuildCustomTarballOpts,
): Promise<string> {
  const prefix = opts.prefix ?? `minimal-shard-${opts.version}`;
  const workRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), `${CUSTOM_TAR_TMP_PREFIX}${opts.version}-`),
  );
  try {
    const workDir = path.join(workRoot, prefix);
    await copyDir(MINIMAL_SHARD, workDir);

    if (opts.schema) {
      const schemaPath = path.join(workDir, '.shardmind', 'shard-schema.yaml');
      await fs.writeFile(schemaPath, stringifyYaml(opts.schema), 'utf-8');
    }

    const manifestPath = path.join(workDir, '.shardmind', 'shard.yaml');
    const manifestSrc = await fs.readFile(manifestPath, 'utf-8');
    const manifest = parseYaml(manifestSrc) as Record<string, unknown>;
    manifest['version'] = opts.version;
    Object.assign(manifest, opts.manifestOverrides ?? {});
    await fs.writeFile(manifestPath, stringifyYaml(manifest), 'utf-8');

    if (opts.mutate) await opts.mutate(workDir);

    const tarPath = path.join(opts.outDir, `${prefix}.tar.gz`);
    await tar.c({ file: tarPath, gzip: true, cwd: workRoot }, [prefix]);
    return tarPath;
  } finally {
    await fs.rm(workRoot, { recursive: true, force: true });
  }
}

// ───── Shared wizard / diff drivers ─────────────────────────────────

/**
 * Drive the standard 4-question minimal-shard wizard (the same shape
 * `<Install>` and `<Adopt>` both render via `<InstallWizard>`):
 *
 *   header → user_name (typed) → org_name (default) →
 *   vault_purpose (default) → qmd_enabled ('n') → modules
 *
 * Returns once the modules step is rendered. The caller continues
 * with whatever post-modules step its scenario needs (Confirm for
 * install, plan + diff for adopt).
 *
 * `headerTimeoutMs` defaults to 30 s because the wizard-header frame
 * is gated on the full resolve → download → parseManifest →
 * parseSchema → planOutputs pipeline. Under parallel test load
 * (multiple `npm test` workers + multiple github-stub HTTP servers
 * + concurrent tarball reads), CPU contention can stretch that
 * pipeline well past 10 s on a worker. The 30 s ceiling is the
 * same shape `tests/e2e/cli.test.ts` uses for its slower CI cells.
 */
export async function driveMinimalWizard(
  r: RenderResult,
  userName = 'Alice',
  headerTimeoutMs = 30_000,
): Promise<void> {
  await waitFor(r.lastFrame, (f) => /4 questions to answer/.test(f), headerTimeoutMs);
  r.stdin.write(ENTER);
  await waitFor(r.lastFrame, (f) => f.includes('Your name'));
  await typeText(r.stdin, userName);
  r.stdin.write(ENTER);
  await waitFor(r.lastFrame, (f) => f.includes('Organization'));
  r.stdin.write(ENTER);
  await waitFor(r.lastFrame, (f) => f.includes('How will you use this vault'));
  r.stdin.write(ENTER);
  await waitFor(r.lastFrame, (f) => f.includes('QMD'));
  r.stdin.write('n');
  await waitFor(r.lastFrame, (f) => f.includes('Choose modules to install'));
}

/**
 * Walk N sequential DiffView / AdoptDiffView prompts, asserting that
 * the i-of-N counter advances. Direct regression of [#109](https://github.com/breferrari/shardmind/issues/109): if the per-iteration dedup
 * guard ever leaks across files again, the counter doesn't advance
 * and the helper's waitFor times out on iteration 2.
 *
 * The `keystrokes` callback fires once per iteration and is responsible
 * for picking an action — DiffView and AdoptDiffView differ on which
 * option index maps to keep_mine vs use_shard, so the helper stays
 * agnostic.
 */
export async function driveDiffIteration(
  r: RenderResult,
  total: number,
  keystrokes: (r: RenderResult, index: number) => Promise<void> | void,
): Promise<void> {
  for (let i = 1; i <= total; i++) {
    await waitFor(
      r.lastFrame,
      (f) => new RegExp(`\\(${i} of ${total}\\)`).test(f),
      20_000,
    );
    await keystrokes(r, i);
    // tick lets the iteration's setState commit before the next
    // waitFor checks. Without it, the next iteration's frame may be
    // observed mid-transition.
    await tick(40);
  }
}
