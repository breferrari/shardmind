/**
 * Temp-vault factories shared across E2E scenarios.
 *
 * A vault is a directory that can hold a shard install. Most tests need
 * one of three shapes:
 *
 *   1. Empty — freshly created tmpdir, nothing inside.
 *   2. Pre-seeded with user content at the paths the shard would write
 *      (collision scenarios).
 *   3. Fully installed via a real CLI invocation — used for status +
 *      update scenarios. This is a genuine install driven by the stub,
 *      not a hand-constructed `.shardmind/` tree, so tests exercise the
 *      same code paths the user would hit.
 *
 * `createInstalledVault` gives each test its own installed vault, cleaned up
 * on exit. The install subprocess runs once per distinct fixture per test
 * file, and later calls copy that result (#218; see the function).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { removePath } from '../../../source/core/fs-utils.js';
import { stringify as stringifyYaml } from 'yaml';
import { spawnCli } from './spawn-cli.js';
import type { GitHubStub } from './github-stub.js';
import type { HookContext } from '../../../source/runtime/types.js';

export interface Vault {
  /** Absolute path. */
  root: string;
  /** Write a file under the vault, creating parent dirs as needed. */
  writeFile: (relPath: string, content: string) => Promise<void>;
  /** Read a vault file as UTF-8. Throws ENOENT if missing. */
  readFile: (relPath: string) => Promise<string>;
  /** True if a path exists. */
  exists: (relPath: string) => Promise<boolean>;
  /** Recursive listing of vault contents (relative paths, POSIX-slash). */
  listFiles: () => Promise<string[]>;
  /** Clean up — always call in `afterEach`. */
  cleanup: () => Promise<void>;
}

const activeVaults = new Set<string>();

/**
 * Create an empty temp vault. Registers for auto-cleanup.
 */
export async function createEmptyVault(prefix = 'vault'): Promise<Vault> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `shardmind-e2e-${prefix}-`));
  activeVaults.add(root);
  return {
    root,
    writeFile: async (rel, content) => {
      const abs = path.join(root, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf-8');
    },
    readFile: (rel) => fs.readFile(path.join(root, rel), 'utf-8'),
    exists: async (rel) => {
      try {
        await fs.access(path.join(root, rel));
        return true;
      } catch {
        return false;
      }
    },
    listFiles: () => listRecursive(root),
    cleanup: async () => {
      activeVaults.delete(root);
      // `removePath` retries Windows ENOTEMPTY / EBUSY / EPERM: an install
      // subprocess that's just exited may still hold file handles open for
      // a few hundred ms while the OS reclaims them, and antivirus can hold
      // a file just written, so a recursive rmdir on the vault races them.
      await removePath(root);
    },
  };
}

/** Runs `shardmind <args>`; the real CLI by default, injectable for counting. */
export type InstallRunner = typeof spawnCli;

/**
 * Installed fixtures by key, per test file (vitest isolates modules per
 * file): the template directory a copy is made from, or `null` when the key
 * cannot be cached (see `isPositionIndependent`).
 */
const installedTemplates = new Map<string, string | null>();

/** How many installed-vault templates this file holds. For tests of the cache. */
export function installedTemplateCount(): number {
  return [...installedTemplates.values()].filter((root) => root !== null).length;
}

/**
 * A vault with `shardRef` installed by the real CLI (`install --yes`, values
 * from a temporary YAML file). Throws if the install fails.
 *
 * Each distinct fixture is installed once per test file and copied after that
 * (#218): an install is a full CLI subprocess, and a scenario that installs
 * only to set up an update or adopt ran two of them in one test budget. The
 * key is everything that decides the result: the stub, what it serves for
 * the shard right now, the ref and the values. A copy is the vault the
 * install would produce, because an installed vault records no absolute path
 * (checked on each template; a vault that mentions its own path, as a hook
 * writing `ctx.vaultRoot` would, is never cached). `fresh: true` always runs
 * the install; a test whose subject is the install itself spawns `install`
 * directly instead of using this helper.
 */
export async function createInstalledVault(input: {
  stub: GitHubStub;
  shardRef: string;
  values: Record<string, unknown>;
  prefix?: string;
  fresh?: boolean;
  install?: InstallRunner;
}): Promise<Vault> {
  const vault = await createEmptyVault(input.prefix ?? 'installed');
  const key = JSON.stringify([
    input.stub.url,
    input.stub.servingState(slugOf(input.shardRef)),
    input.shardRef,
    input.values,
  ]);

  const template = input.fresh ? undefined : installedTemplates.get(key);
  if (template) {
    await fs.cp(template, vault.root, { recursive: true });
    return vault;
  }

  const valuesPath = path.join(vault.root, `.values-${crypto.randomUUID()}.yaml`);
  await fs.writeFile(valuesPath, stringifyYaml(input.values), 'utf-8');

  const install = input.install ?? spawnCli;
  const result = await install(['install', input.shardRef, '--yes', '--values', valuesPath], {
    cwd: vault.root,
    env: { SHARDMIND_GITHUB_API_BASE: input.stub.url },
  });

  if (result.exitCode !== 0) {
    await vault.cleanup();
    throw new Error(
      `createInstalledVault: install failed (exit ${result.exitCode}).\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }

  // The values prefill file was inside the vault for convenience; delete
  // it so it doesn't leak into listFiles() / drift detection.
  await fs.rm(valuesPath, { force: true });

  if (!input.fresh && template === undefined) {
    if (await isPositionIndependent(vault.root)) {
      const copy = await fs.mkdtemp(path.join(os.tmpdir(), 'shardmind-e2e-template-'));
      await fs.cp(vault.root, copy, { recursive: true });
      installedTemplates.set(key, copy);
    } else {
      installedTemplates.set(key, null);
    }
  }
  return vault;
}

/** `acme/demo` from `github:acme/demo`, `github:acme/demo@1.0.0` or `github:acme/demo#main`. */
function slugOf(shardRef: string): string {
  return shardRef.replace(/^github:/, '').split(/[@#]/)[0]!;
}

/**
 * True when no file under `root` mentions `root` itself, in any of the forms
 * a path is written (native, forward-slash, JSON-escaped). Such a vault can be
 * copied elsewhere and stay the same vault.
 */
async function isPositionIndependent(root: string): Promise<boolean> {
  const forms = new Set([root, toPosix(root), JSON.stringify(root).slice(1, -1)]);
  for (const rel of await listRecursive(root)) {
    const content = await fs.readFile(path.join(root, rel), 'utf-8');
    for (const form of forms) if (content.includes(form)) return false;
  }
  return true;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Best-effort cleanup of all live vaults and installed-vault templates.
 * Called from the global `afterAll` in case a test threw before its local
 * afterEach ran.
 */
export async function cleanupAllVaults(): Promise<void> {
  const roots = [...activeVaults, ...[...installedTemplates.values()].filter((root): root is string => root !== null)];
  activeVaults.clear();
  installedTemplates.clear();
  for (const root of roots) {
    await removePath(root).catch(() => {});
  }
}

/**
 * Strip the engine's installed-side metadata (`.shardmind/` dir +
 * `shard-values.yaml`) from a vault. Used by adopt scenarios to
 * simulate a v5.1-style clone — the user has the vault content but
 * never went through `shardmind install`.
 */
export async function stripShardmindMetadata(vault: Vault): Promise<void> {
  await removePath(path.join(vault.root, '.shardmind'));
  await fs.rm(path.join(vault.root, 'shard-values.yaml'), { force: true });
}

/**
 * Read and parse a hook ctx dump emitted by a fixture's hook (#102: the
 * obsidian-mind-like fixture writes
 * `.hook-ctx-{bootstrap,personalize,update}.json`). Scenarios assert what the
 * engine handed each slot (values, newFiles, removedFiles, previousVersion, …).
 *
 * `T` defaults to the engine's `HookContext` (the legacy combined shape).
 * Slotted scenarios pass a tighter T (BootstrapContext / PersonalizeContext /
 * PostUpdateContext) so a typo'd field name trips the type checker.
 */
export async function readHookContext<T = HookContext>(
  vault: Vault,
  phase: 'bootstrap' | 'personalize' | 'update',
): Promise<T> {
  return JSON.parse(await vault.readFile(`.hook-ctx-${phase}.json`)) as T;
}

/**
 * Recursive file listing. Returns relative paths in POSIX form, sorted.
 * Skips symlinks and non-regular entries silently. Tolerates a directory
 * vanishing mid-walk. Shared by the Vault factory and the Invariant 1
 * helper so test code has one walker.
 */
export async function listRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // directory vanished mid-walk
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile()) {
        out.push(path.relative(root, abs).replace(/\\/g, '/'));
      }
    }
  }
  return out.sort();
}

