/**
 * One vault transaction for the commands that write a vault (#301).
 *
 * A run begins a transaction, which makes its snapshot folder
 * (`.shardmind/backups/<kind>-<stamp>`). Before each write, removal or move
 * of a vault path it calls `recordWrite`: an existing file is copied into
 * the snapshot once, a new path is marked as introduced, and the folders the
 * write will create are added to the run's folder record. `.shardmind/`'s
 * own files go through `commitEngineMetadata`, which writes `state.json`
 * last: the commit point. On a failure or a Ctrl+C before it, `rollback`
 * undoes the run's in-place case renames, removes what it introduced,
 * copies the snapshot back (with the engine cache, for a run over a prior
 * install), removes the folders it created and, for a run with no install
 * before it, what it wrote under `.shardmind/`. It never throws: what it
 * could not undo is returned (#247).
 *
 * Adopt and update run on it; install follows (#301).
 * Spec: docs/IMPLEMENTATION.md §4.28.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { createBackupDir, removeEngineWrites } from './state.js';
import { missingFolders, recordCreatedFolders, rollbackCreatedFolders, createdFoldersRecord } from './created-folders.js';
import { restoreDirExactly, restoreTree } from './restore-tree.js';
import { caseJournal, sameFile, undoCaseHops, type CaseJournal } from './rename-migrations.js';
import { throwIfCancelled } from './run-cancel.js';
import { settleAll, toPosix } from './fs-utils.js';
import { isEnoent } from '../runtime/errno.js';
import { CACHED_MANIFEST, CACHED_SCHEMA, CACHED_TEMPLATES, STATE_FILE, VALUES_FILE } from '../runtime/vault-paths.js';
import { reasonOf, type RollbackFailure } from './rollback-report.js';

export interface TransactionOptions {
  kind: Parameters<typeof createBackupDir>[2];
  now?: Date;
  signal?: AbortSignal;
  /**
   * What the snapshot folder becomes after a rollback: `always` kept (update:
   * its summary points at it), or kept only when a restore failed, when it
   * holds the only copy of a file (adopt, #246).
   */
  keepAfterRollback: 'always' | 'on-restore-failure';
  /**
   * No install before this run: a rollback also removes what it wrote under
   * `.shardmind/` (adopt, #243). Otherwise the engine cache is snapshotted
   * when the run begins and restored by its rollback (update).
   */
  noPriorInstall: boolean;
}

export interface VaultTransaction {
  /** The run's snapshot folder. */
  readonly dir: string;
  /**
   * The paths this run introduced, removed by a rollback. The rename helpers
   * add their temporaries here and take back a path they did not get; a
   * file written with an exclusive flag is added only once written, so a
   * rollback never removes one that appeared meanwhile.
   */
  readonly introduced: string[];
  /** Every in-place case hop, journaled before its first rename (#169, #195). */
  readonly journal: CaseJournal;
  /** Before writing, removing or moving onto `rel` (vault-relative, POSIX). */
  recordWrite(rel: string): Promise<void>;
  /**
   * Before a rename migration moves `from` to `to`, or writes `to` (#178):
   * `from` is snapshotted, `to` is introduced. A case-only pair that is one
   * file is snapshotted once, under its old name (#169).
   */
  recordMove(from: string, to: string): Promise<void>;
  /** Before a folder is renamed in place by case: the folders it creates (#195). */
  recordFolder(rel: string): Promise<void>;
  /** The engine's own writes; `state.json` last, after the last cancel check. */
  commitEngineMetadata(steps: { beforeState: () => Promise<void>; state: () => Promise<void> }): Promise<void>;
  /** Undo the run; never throws. */
  rollback(): Promise<RollbackFailure[]>;
}

/** Records whether `.shardmind/templates/` existed when the snapshot was taken (#264). */
const TEMPLATES_SNAPSHOT_MARKER = 'templates-snapshot.json';

export async function beginTransaction(vaultRoot: string, opts: TransactionOptions): Promise<VaultTransaction> {
  const dir = await createBackupDir(vaultRoot, opts.now ?? new Date(), opts.kind);
  const filesDir = path.join(dir, 'files');
  const cacheDir = path.join(dir, 'cache');
  if (!opts.noPriorInstall) await snapshotEngineCache(vaultRoot, dir);
  const snapshotted = new Set<string>();
  const introduced: string[] = [];
  // Also kept here, so an unusable record on disk still undoes them (#295).
  const createdFolders: string[] = [];
  // One answer per folder for the whole run, as install's (#258).
  const seen = new Map<string, boolean>();

  async function recordFolders(paths: readonly string[], folders: readonly string[] = []): Promise<void> {
    const missing = await missingFolders(vaultRoot, paths, { folders, seen });
    if (missing.length === 0) return;
    createdFolders.push(...missing);
    await recordCreatedFolders(dir, createdFolders);
  }

  async function record(rel: string): Promise<void> {
    if (snapshotted.has(rel) || introduced.includes(rel)) return;
    const abs = path.join(vaultRoot, rel);
    await recordFolders([rel]);
    const stat = await fsp.lstat(abs).catch((err: unknown) => {
      if (isEnoent(err)) return null;
      throw err;
    });
    if (!stat) {
      introduced.push(rel);
      return;
    }
    // A folder at the path is the user's: the write fails on it, and the
    // rollback leaves it alone. Only a file is copied.
    if (!stat.isFile()) return;
    const copy = path.join(filesDir, rel);
    await fsp.mkdir(path.dirname(copy), { recursive: true });
    try {
      await fsp.copyFile(abs, copy);
      snapshotted.add(rel);
    } catch (err) {
      // Gone since it was checked: nothing to keep, so it is new.
      if (!isEnoent(err)) throw err;
      introduced.push(rel);
    }
  }

  // Checked on both sides of each record: the record's own writes (the
  // folder record, the snapshot copy) are writes too, so a Ctrl+C during
  // them stops the run before the caller's write starts (#249).
  async function guarded(step: () => Promise<void>): Promise<void> {
    throwIfCancelled(opts.signal);
    await step();
    throwIfCancelled(opts.signal);
  }

  return {
    dir,
    introduced,
    journal: caseJournal(dir),

    recordWrite: (rel) => guarded(() => record(rel)),
    recordMove: (from, to) =>
      guarded(async () => {
        await record(from);
        if (introduced.includes(to)) return;
        // One file under two spellings: it is in the snapshot under the old
        // one, and the new spelling goes on rollback.
        if (await sameFile(vaultRoot, from, to)) {
          introduced.push(to);
          return;
        }
        // Free when the run began, so introduced; a file that arrived since
        // is snapshotted, and the move refuses to land on it.
        await record(to);
      }),
    recordFolder: (rel) => guarded(() => recordFolders([], [rel])),
    async commitEngineMetadata(steps) {
      throwIfCancelled(opts.signal);
      await steps.beforeState();
      // state.json commits the run: the last point a Ctrl+C can stop it.
      throwIfCancelled(opts.signal);
      await steps.state();
    },

    async rollback() {
      // Old spellings first (#169, #195). Either order with the restore gives
      // the same tree on a case-folding filesystem; undo-first reads plainer.
      const failures: RollbackFailure[] = [...(await undoCaseHops(vaultRoot, dir))];
      // Introduced paths next, so a restore never lands on a file this run made.
      for (const rel of introduced) {
        try {
          await fsp.rm(path.join(vaultRoot, rel), { force: true });
        } catch (err) {
          failures.push({ path: rel, reason: `unlink failed: ${reasonOf(err)}` });
        }
      }
      await restoreTree(filesDir, vaultRoot, failures);
      if (!opts.noPriorInstall) await restoreEngineCache(vaultRoot, dir, cacheDir, failures);
      failures.push(
        ...(await rollbackCreatedFolders(vaultRoot, dir, toPosix(vaultRoot, createdFoldersRecord(dir)), createdFolders)),
      );
      if (opts.noPriorInstall) {
        // The snapshot goes with the rest, unless it holds the only copy of
        // a file: a failure that names its backup there (restore-tree.ts).
        const keep = opts.keepAfterRollback === 'always' || failures.some((f) => f.backup !== undefined);
        for (const failure of await removeEngineWrites(vaultRoot, { snapshotDir: keep ? null : dir, removeEmptyDir: true })) {
          failures.push({ path: failure.path, reason: `cleanup failed: ${failure.reason}` });
        }
      }
      return failures;
    },
  };
}

/**
 * The engine cache of a prior install, into `<dir>/cache/`: `state.json`,
 * the cached manifest and schema, the values file, and the template cache
 * whole, then its marker. Every copy settles before a failure is thrown, so
 * none writes into the snapshot while a rollback reads it (#274).
 */
async function snapshotEngineCache(vaultRoot: string, dir: string): Promise<void> {
  const cacheDir = path.join(dir, 'cache');
  await fsp.mkdir(cacheDir, { recursive: true });
  await settleAll([
    ...[STATE_FILE, CACHED_MANIFEST, CACHED_SCHEMA, VALUES_FILE].map((rel) =>
      copyOptional(path.join(vaultRoot, rel), path.join(cacheDir, rel)),
    ),
    (async () => {
      let existed = true;
      try {
        await fsp.cp(path.join(vaultRoot, CACHED_TEMPLATES), path.join(cacheDir, CACHED_TEMPLATES), { recursive: true });
      } catch (err) {
        if (!isEnoent(err)) throw err;
        existed = false;
      }
      // Written last, once the copy is whole: the rollback restores the
      // template cache exactly only when it knows the snapshot is (#264).
      await fsp.writeFile(path.join(dir, TEMPLATES_SNAPSHOT_MARKER), JSON.stringify({ existed }));
    })(),
  ]);
}

async function copyOptional(src: string, dst: string): Promise<void> {
  try {
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.copyFile(src, dst);
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
}

/**
 * The engine cache back from `<dir>/cache/`. `cacheTemplates` rewrote the
 * template cache whole, so it is restored exactly (the new version's added
 * templates go, and so does a cache there was none of before, #264), but only
 * when the marker says the snapshot is complete: one cut short restores by
 * copying over, which never touches templates it did not hold. A marker that
 * is there but unusable is a failure naming the cache (#294).
 */
async function restoreEngineCache(vaultRoot: string, dir: string, cacheDir: string, failures: RollbackFailure[]): Promise<void> {
  const read = await readTemplatesMarker(dir);
  const marker = read === 'absent' || 'unreadable' in read ? undefined : read;
  await restoreTree(cacheDir, vaultRoot, failures, marker === undefined ? {} : { skip: [CACHED_TEMPLATES] });
  if (read !== 'absent' && 'unreadable' in read) {
    failures.push({
      path: toPosix(vaultRoot, path.join(vaultRoot, CACHED_TEMPLATES)),
      reason: `templates marker unreadable: ${read.unreadable}`,
      backup: path.join(cacheDir, CACHED_TEMPLATES),
    });
  }
  if (marker !== undefined) {
    await restoreDirExactly(
      marker.existed ? path.join(cacheDir, CACHED_TEMPLATES) : path.join(dir, 'no-templates-cache'),
      path.join(vaultRoot, CACHED_TEMPLATES),
      failures,
      { label: CACHED_TEMPLATES },
    );
  }
}

/**
 * The marker; `'absent'` when the snapshot never finished (no marker); or
 * why it cannot be used, when it is there but unreadable or malformed
 * (#294). Only a missing marker means a snapshot cut short.
 */
async function readTemplatesMarker(dir: string): Promise<{ existed: boolean } | 'absent' | { unreadable: string }> {
  let raw: string;
  try {
    raw = await fsp.readFile(path.join(dir, TEMPLATES_SNAPSHOT_MARKER), 'utf-8');
  } catch (err) {
    return isEnoent(err) ? 'absent' : { unreadable: reasonOf(err) };
  }
  try {
    const parsed = JSON.parse(raw) as { existed?: unknown };
    if (typeof parsed?.existed === 'boolean') return { existed: parsed.existed };
  } catch {
    // Not JSON: reported below like any other malformed marker.
  }
  return { unreadable: `${TEMPLATES_SNAPSHOT_MARKER} is not { existed: boolean }` };
}
