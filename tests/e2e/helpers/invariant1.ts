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
 * (Tier 1 + `.shardmindignore` for clone via `walkShardSource`; engine-
 * metadata exclusions for install) and pairs every clone path to its
 * expected install path. Returns a structured report whose four fields
 * are empty under "everything green".
 *
 * Used by `tests/e2e/cli.test.ts` for the CI E2E gate. Pure (read-only,
 * no spawning); reusable for future shard-author CI.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { walkShardSource } from '../../../source/core/modules.js';
import { loadShardmindignore } from '../../../source/core/shardmindignore.js';
import { mapConcurrent } from '../../../source/core/fs-utils.js';
import { errnoCode, isEnoent } from '../../../source/runtime/errno.js';
import {
  SHARDMIND_DIR,
  VALUES_FILE,
} from '../../../source/runtime/vault-paths.js';
import { listRecursive } from './vault.js';

const COMPARE_CONCURRENCY = 16;

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
  // Clone-side walk delegates to the engine's own walker (Tier 1 +
  // `.shardmindignore` + symlink rejection) so the helper can never drift
  // from what the install pipeline considers installable. A `.shardmindignore`
  // with a `!pattern` entry rejects here exactly as it would inside the
  // engine.
  const cloneFilter = await loadShardmindignore(input.cloneDir);
  const cloneWalk = await walkShardSource(input.cloneDir, cloneFilter);
  const cloneFiles = cloneWalk.map((f) => f.relPath);

  // listRecursive enumerates regular files only — symlinks are silently
  // skipped, matching the install pipeline's contract: the engine never
  // writes symlinks during install (`runInstall` uses `writeFile` /
  // `copyFile` exclusively). A symlink in `installDir` therefore implies
  // pre-existing user state outside the install pipeline's surface, which
  // Invariant 1 doesn't speak to. The clone-side walk is asymmetric on
  // purpose: `walkShardSource` rejects symlinks because the install
  // *would* refuse them upstream, so the helper tracks the engine's
  // contract on each side.
  const installFiles = (await listRecursive(input.installDir)).filter(
    (rel) => !isEngineMetadata(rel),
  );

  const expectedInstall = new Map<string, ExpectedEntry>();
  for (const cloneRel of cloneFiles) {
    const isRendered = cloneRel.endsWith('.njk');
    const installRel = isRendered ? cloneRel.slice(0, -4) : cloneRel;
    expectedInstall.set(installRel, {
      kind: isRendered ? 'rendered' : 'static',
      cloneRel,
    });
  }

  const installSet = new Set(installFiles);
  const missingFromInstall: string[] = [];
  const staticByteMismatches: string[] = [];
  let matched = 0;

  // Per-file byte comparison fans out under a fixed concurrency budget so
  // larger shards don't open file handles linearly with tree size. Counts
  // and mismatch lists are accumulated under a serial reduction at the end
  // to keep the report deterministic.
  type Outcome =
    | { kind: 'matched' }
    | { kind: 'missing'; installRel: string }
    | { kind: 'mismatch'; installRel: string };

  const outcomes = await mapConcurrent(
    Array.from(expectedInstall.entries()),
    COMPARE_CONCURRENCY,
    async ([installRel, entry]): Promise<Outcome> => {
      if (!installSet.has(installRel)) {
        return { kind: 'missing', installRel };
      }
      if (entry.kind === 'static') {
        let cloneBytes: Buffer;
        let installBytes: Buffer;
        try {
          [cloneBytes, installBytes] = await Promise.all([
            fsp.readFile(path.join(input.cloneDir, entry.cloneRel)),
            fsp.readFile(path.join(input.installDir, installRel)),
          ]);
        } catch (err) {
          // A file that survived enumeration vanished or became
          // unreadable before the byte-read. Treat ENOENT as
          // `missing` (post-walk deletion is observationally
          // identical to "install never produced it"); other I/O
          // failures rethrow with the path in scope so the failing
          // test can pinpoint the file.
          if (isEnoent(err)) {
            return { kind: 'missing', installRel };
          }
          // Surface the errno code AND the file path so a CI failure
          // log distinguishes EACCES (permission) from EBUSY (lock) from
          // ENAMETOOLONG (path) on the actual offending file. Without
          // both pieces, debugging an Invariant 1 break in CI degrades
          // to bisecting the diff.
          const code = errnoCode(err) ?? 'UNKNOWN';
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(
            `verifyInvariant1: failed to read ${installRel} [${code}]: ${message}`,
          );
        }
        if (!cloneBytes.equals(installBytes)) {
          return { kind: 'mismatch', installRel };
        }
      }
      return { kind: 'matched' };
    },
  );

  for (const outcome of outcomes) {
    if (outcome.kind === 'matched') matched++;
    else if (outcome.kind === 'missing') missingFromInstall.push(outcome.installRel);
    else staticByteMismatches.push(outcome.installRel);
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

function isEngineMetadata(relPath: string): boolean {
  if (relPath === VALUES_FILE) return true;
  return relPath === SHARDMIND_DIR || relPath.startsWith(`${SHARDMIND_DIR}/`);
}
