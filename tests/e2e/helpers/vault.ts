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

import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
 * Installed fixtures, per test file (vitest isolates modules per file) and per
 * install runner (a custom runner's side effects stay in its own cache): key
 * → the template directory a copy is made from, or `null` when the key cannot
 * be cached. Each entry is a promise, so concurrent calls with one key share
 * one install.
 */
const installedTemplates = new Map<InstallRunner, Map<string, Promise<string | null>>>();
/** Every template directory made, for cleanup. */
const templateRoots = new Set<string>();
/** Bumped by `cleanupAllVaults`, so a template still being built when it runs is discarded. */
let cacheGeneration = 0;

let exitCleanupRegistered = false;
/**
 * Removes leftover templates when the worker exits normally, for files that
 * never call `cleanupAllVaults`. A worker killed by a signal runs no
 * handlers; `cleanupAllVaults` stays the primary path.
 */
function registerExitCleanup(): void {
  if (exitCleanupRegistered) return;
  exitCleanupRegistered = true;
  process.once('exit', () => {
    for (const root of templateRoots) {
      try {
        fsSync.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // A Windows file hold: leave this one, keep removing the rest.
      }
    }
  });
}

/** How many installed-vault templates this file holds. For tests of the cache. */
export function installedTemplateCount(): number {
  return templateRoots.size;
}

/**
 * A vault with `shardRef` installed by the real CLI (`install --yes`, values
 * from a temporary YAML file). Throws if the install fails.
 *
 * Each distinct fixture is installed once per test file and copied after that
 * (#218): an install is a full CLI subprocess, and a scenario that installs
 * only to set up an update or adopt ran two of them in one test budget. The
 * key is everything that decides the result: the stub, what it serves for
 * the shard right now (tarball contents included), the ref and the values as
 * written to YAML. A copy is the vault the install would produce, because an
 * installed vault records no absolute path. That is checked on each template:
 * a vault that mentions its own path in any spelling, as a hook writing
 * `ctx.vaultRoot` does (the obsidian-mind fixture's bootstrap hook), is never
 * cached, so that shard installs every time. A copy keeps the clock of the
 * install it came from (state.json times, rendered dates).
 *
 * `fresh: true` always runs the install; a test whose subject is the install
 * itself spawns `install` directly instead of using this helper. Building a
 * template is best-effort: if it fails, the vault is still returned.
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
  const install = input.install ?? spawnCli;
  const valuesYaml = stringifyYaml(input.values);
  const key = JSON.stringify([input.stub.url, input.stub.servingState(slugOf(input.shardRef)), input.shardRef, valuesYaml]);

  let cache = installedTemplates.get(install);
  if (!cache) installedTemplates.set(install, (cache = new Map()));

  const cached = input.fresh ? undefined : cache.get(key);
  if (cached) {
    const template = await cached;
    if (template !== null) {
      await fs.cp(template, vault.root, COPY_OPTIONS);
      return vault;
    }
  }

  // Only the first caller of a key builds its template; the rest wait on it.
  let settle: ((template: string | null) => void) | undefined;
  if (!input.fresh && !cached) cache.set(key, new Promise((resolve) => (settle = resolve)));

  try {
    const valuesPath = path.join(vault.root, `.values-${crypto.randomUUID()}.yaml`);
    await fs.writeFile(valuesPath, valuesYaml, 'utf-8');

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

    if (settle) {
      const built = await buildTemplate(vault.root);
      // A failed copy is worth retrying on the next call; a vault that is
      // tied to its own path never is.
      if (built.kind === 'failed') cache.delete(key);
      settle(built.kind === 'template' ? built.root : null);
    }
    return vault;
  } catch (err) {
    if (settle) {
      cache.delete(key);
      settle(null);
    }
    throw err;
  }
}

const COPY_OPTIONS = { recursive: true, verbatimSymlinks: true } as const;

type Built = { kind: 'template'; root: string } | { kind: 'position-dependent' } | { kind: 'failed' };

/**
 * Copies an installed vault into a template. It cannot be reused when it is
 * tied to its own path; the copy can also fail (a Windows file hold just after
 * the install exits), or be overtaken by `cleanupAllVaults`. Never throws.
 */
async function buildTemplate(root: string): Promise<Built> {
  const generation = cacheGeneration;
  let copy: string | undefined;
  try {
    if (!(await isPositionIndependent(root))) return { kind: 'position-dependent' };
    copy = await fs.mkdtemp(path.join(os.tmpdir(), 'shardmind-e2e-template-'));
    await fs.cp(root, copy, COPY_OPTIONS);
    if (generation !== cacheGeneration) throw new Error('cache was cleared while the template was built');
    templateRoots.add(copy);
    registerExitCleanup();
    return { kind: 'template', root: copy };
  } catch {
    if (copy) await removePath(copy).catch(() => {});
    return { kind: 'failed' };
  }
}

/** `acme/demo` from `github:acme/demo`, `github:acme/demo@1.0.0` or `github:acme/demo#main`. */
function slugOf(shardRef: string): string {
  return shardRef.replace(/^github:/, '').split(/[@#]/)[0]!;
}

/**
 * True when no file under `root` mentions `root` itself in any of the forms a
 * path is written: as given and as its real path (which resolves Windows 8.3
 * names), each native, forward-slash, JSON-escaped and as a `file:` URL, and
 * compared case-insensitively on Windows and macOS. A vault holding any
 * symlink is treated as tied to its path too, since a link's target is not
 * checked. Such a vault can be copied elsewhere and stay the same vault.
 */
async function isPositionIndependent(root: string): Promise<boolean> {
  if (await containsSymlink(root)) return false;
  const spellings = new Set<string>();
  for (const p of new Set([root, await fs.realpath(root)])) {
    spellings.add(p);
    spellings.add(toPosix(p));
    spellings.add(JSON.stringify(p).slice(1, -1));
    spellings.add(pathToFileURL(p).href);
    spellings.add(decodeURI(pathToFileURL(p).href));
  }
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
  const fold = caseInsensitive ? (s: string) => s.toLowerCase() : (s: string) => s;
  const forms = [...spellings].map(fold);
  for (const rel of await listRecursive(root)) {
    const content = fold(await fs.readFile(path.join(root, rel), 'utf-8'));
    for (const form of forms) if (content.includes(form)) return false;
  }
  return true;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

async function containsSymlink(root: string): Promise<boolean> {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  return entries.some((entry) => entry.isSymbolicLink());
}

/**
 * Best-effort cleanup of all live vaults and installed-vault templates.
 * Called from the global `afterAll` in case a test threw before its local
 * afterEach ran.
 */
export async function cleanupAllVaults(): Promise<void> {
  const roots = [...activeVaults, ...templateRoots];
  cacheGeneration += 1;
  activeVaults.clear();
  installedTemplates.clear();
  templateRoots.clear();
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

