/**
 * Invariant 1 byte-equivalence helper.
 *
 * Operationalizes [`docs/SHARD-LAYOUT.md §Installation invariants`](../../../docs/SHARD-LAYOUT.md):
 * the relationship between a `git clone <shard>` (clone) and the vault
 * produced by `shardmind install --defaults <shard>` (install) is precise:
 *
 *  - Static files (no `.njk` suffix) are byte-identical at the same path.
 *  - Renderable templates (`.njk` suffix) live at the stripped path on the
 *    install side; their bytes legitimately differ via render substitutions.
 *  - The install additionally contains engine metadata under `.shardmind/`
 *    plus a vault-root `shard-values.yaml`.
 *
 * The helper enumerates both sides under exactly the engine's filters
 * (Tier 1 from `core/tier1.ts` + `.shardmindignore` via `core/shardmindignore.ts`
 * for clone; engine-metadata exclusions for install), pairs every clone
 * path to its expected install path, and returns a structured report.
 *
 * Used by `tests/e2e/cli.test.ts` for the CI E2E gate. Pure (read-only,
 * no spawning); reusable for future shard-author CI.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  loadShardmindignore,
  type IgnoreFilter,
} from '../../../source/core/shardmindignore.js';
import { isTier1Excluded } from '../../../source/core/tier1.js';
import { sha256 } from '../../../source/core/fs-utils.js';
import {
  SHARDMIND_DIR,
  VALUES_FILE,
} from '../../../source/runtime/vault-paths.js';

export interface InvariantOneInput {
  /** Absolute path to the clone-equivalent source tree. */
  cloneDir: string;
  /** Absolute path to the install destination (post-`install --defaults`). */
  installDir: string;
}

export interface InvariantOneReport {
  /**
   * Count of clone-side paths whose pairing succeeded — static files with
   * matching bytes plus `.njk` templates whose stripped install path
   * exists. The headline count under "everything green".
   */
  matched: number;
  /**
   * Static files (no `.njk` suffix on the clone side) where install bytes
   * disagree with clone bytes. Each entry is the relative path; the
   * mismatch detail is omitted to keep the report cheap. Inspect on disk
   * if a real failure surfaces.
   */
  staticByteMismatches: string[];
  /**
   * Clone-side paths whose expected install path is absent. `.njk`
   * sources have their stripped path checked; static paths their identical
   * path. Empty under "everything green".
   */
  missingFromInstall: string[];
  /**
   * Install-side paths that no clone-side source produced (after engine-
   * metadata exclusion). A populated list usually means a Tier 1 leak
   * (`.git/HEAD` reached the install) or the engine wrote a file the
   * spec doesn't account for.
   */
  extrasInInstall: string[];
}

export async function verifyInvariant1(
  input: InvariantOneInput,
): Promise<InvariantOneReport> {
  const cloneFilter = await loadShardmindignore(input.cloneDir);
  const cloneFiles = await listFiltered(input.cloneDir, '', cloneFilter);

  const installFiles = await listInstall(input.installDir);

  const expectedInstall = new Map<string, ExpectedEntry>();
  for (const cloneRel of cloneFiles) {
    if (cloneRel.endsWith('.njk')) {
      expectedInstall.set(stripNjk(cloneRel), { kind: 'rendered', cloneRel });
    } else {
      expectedInstall.set(cloneRel, { kind: 'static', cloneRel });
    }
  }

  const installSet = new Set(installFiles);
  const missingFromInstall: string[] = [];
  const staticByteMismatches: string[] = [];
  let matched = 0;

  for (const [installRel, entry] of expectedInstall) {
    if (!installSet.has(installRel)) {
      missingFromInstall.push(installRel);
      continue;
    }
    if (entry.kind === 'static') {
      const [cloneBytes, installBytes] = await Promise.all([
        fsp.readFile(path.join(input.cloneDir, entry.cloneRel)),
        fsp.readFile(path.join(input.installDir, installRel)),
      ]);
      if (sha256(cloneBytes) !== sha256(installBytes)) {
        staticByteMismatches.push(installRel);
        continue;
      }
    }
    matched++;
  }

  const extrasInInstall: string[] = [];
  for (const installRel of installFiles) {
    if (!expectedInstall.has(installRel)) {
      extrasInInstall.push(installRel);
    }
  }

  return {
    matched,
    staticByteMismatches: staticByteMismatches.sort(),
    missingFromInstall: missingFromInstall.sort(),
    extrasInInstall: extrasInInstall.sort(),
  };
}

interface ExpectedStatic {
  kind: 'static';
  cloneRel: string;
}
interface ExpectedRendered {
  kind: 'rendered';
  cloneRel: string;
}
type ExpectedEntry = ExpectedStatic | ExpectedRendered;

/**
 * Recursive walk of the clone side, mirroring the engine's install walk:
 * Tier 1 + `.shardmindignore` + symlink rejection. Reuses the engine
 * filter modules directly so the helper can never drift from the
 * walker's interpretation of "what should be installed".
 *
 * Symlinks are skipped silently here (not rejected with an error) — the
 * helper's job is to compare; symlink rejection is the engine's
 * responsibility, exercised separately by the install path.
 */
async function listFiltered(
  rootDir: string,
  relDir: string,
  ignoreFilter: IgnoreFilter,
): Promise<string[]> {
  const out: string[] = [];
  const dirAbs = relDir === '' ? rootDir : path.join(rootDir, relDir);
  const entries = await fsp.readdir(dirAbs, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
    const isDir = entry.isDirectory();
    const isFile = entry.isFile();
    if (!isDir && !isFile) continue;
    if (isTier1Excluded(relPath)) continue;
    if (ignoreFilter.ignores(relPath, isDir)) continue;
    if (isDir) {
      out.push(...(await listFiltered(rootDir, relPath, ignoreFilter)));
    } else {
      out.push(relPath);
    }
  }
  return out;
}

/**
 * Enumerate every regular file under `installDir`, then drop engine
 * metadata: anything beneath `.shardmind/` and the vault-root
 * `shard-values.yaml`. The remainder is the install set Invariant 1
 * compares against the clone.
 */
async function listInstall(installDir: string): Promise<string[]> {
  const all = await listAll(installDir, '');
  return all.filter((rel) => !isEngineMetadata(rel));
}

async function listAll(rootDir: string, relDir: string): Promise<string[]> {
  const out: string[] = [];
  const dirAbs = relDir === '' ? rootDir : path.join(rootDir, relDir);
  let entries;
  try {
    entries = await fsp.readdir(dirAbs, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...(await listAll(rootDir, relPath)));
    } else if (entry.isFile()) {
      out.push(relPath);
    }
  }
  return out;
}

function isEngineMetadata(relPath: string): boolean {
  if (relPath === VALUES_FILE) return true;
  return relPath === SHARDMIND_DIR || relPath.startsWith(`${SHARDMIND_DIR}/`);
}

function stripNjk(relPath: string): string {
  return relPath.endsWith('.njk') ? relPath.slice(0, -4) : relPath;
}
