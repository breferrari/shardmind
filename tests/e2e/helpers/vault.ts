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
 * `createInstalledVault` is deliberately slow (one subprocess per call) —
 * don't re-use it across independent tests. Each test that needs a
 * pre-installed vault gets its own, cleaned up on exit.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
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
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * Create a temp vault and install `shardRef` into it using the real CLI.
 * The install runs non-interactively via `--yes` and reads values from a
 * temporary YAML file prefilled from `values`. Returns after a successful
 * exit (throws otherwise).
 */
export async function createInstalledVault(input: {
  stub: GitHubStub;
  shardRef: string;
  values: Record<string, unknown>;
  prefix?: string;
}): Promise<Vault> {
  const vault = await createEmptyVault(input.prefix ?? 'installed');

  const valuesPath = path.join(vault.root, `.values-${crypto.randomUUID()}.yaml`);
  await fs.writeFile(valuesPath, stringifyYaml(input.values), 'utf-8');

  const result = await spawnCli(['install', input.shardRef, '--yes', '--values', valuesPath], {
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

  return vault;
}

/**
 * Best-effort cleanup of all live vaults. Called from the global
 * `afterAll` in case a test threw before its local afterEach ran.
 */
export async function cleanupAllVaults(): Promise<void> {
  const roots = [...activeVaults];
  activeVaults.clear();
  for (const root of roots) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Strip the engine's installed-side metadata (`.shardmind/` dir +
 * `shard-values.yaml`) from a vault. Used by adopt scenarios to
 * simulate a v5.1-style clone — the user has the vault content but
 * never went through `shardmind install`.
 */
export async function stripShardmindMetadata(vault: Vault): Promise<void> {
  await fs.rm(path.join(vault.root, '.shardmind'), { recursive: true, force: true });
  await fs.rm(path.join(vault.root, 'shard-values.yaml'), { force: true });
}

/**
 * Read and parse a hook ctx dump emitted by a fixture's
 * `post-install.ts` / `post-update.ts`. The fixture writes the full
 * `HookContext` JSON to `.hook-ctx-{install,update}.json` so scenarios
 * can assert what the engine handed the hook (valuesAreDefaults,
 * newFiles, removedFiles, previousVersion, …).
 *
 * `T` defaults to the engine's `HookContext` so a typo'd field name
 * trips the type checker. Tests that assert subset-shape (e.g. just
 * `valuesAreDefaults`) can pass a tighter T or use the canonical type
 * directly.
 */
export async function readHookContext<T = HookContext>(
  vault: Vault,
  phase: 'install' | 'update',
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

