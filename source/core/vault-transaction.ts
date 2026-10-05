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
 * removes what the run introduced, copies the snapshot back, removes the
 * folders it created and, for a run with no install before it, what it
 * wrote under `.shardmind/`. It never throws: what it could not undo is
 * returned (#247).
 *
 * Adopt is the first command on it; update and install follow (#301).
 * Spec: docs/IMPLEMENTATION.md §4.28.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { createBackupDir, removeEngineWrites } from './state.js';
import { missingFolders, recordCreatedFolders, rollbackCreatedFolders, createdFoldersRecord } from './created-folders.js';
import { restoreTree } from './restore-tree.js';
import { throwIfCancelled } from './run-cancel.js';
import { toPosix } from './fs-utils.js';
import { isEnoent } from '../runtime/errno.js';
import { reasonOf, type RollbackFailure } from './rollback-report.js';

export interface TransactionOptions {
  kind: Parameters<typeof createBackupDir>[2];
  now?: Date;
  signal?: AbortSignal;
  /**
   * What the snapshot folder becomes after a rollback: `always` kept, or
   * kept only when a restore failed, when it holds the only copy of a file
   * (adopt, #246).
   */
  keepAfterRollback: 'always' | 'on-restore-failure';
  /** No install before this run: a rollback also removes what it wrote under `.shardmind/` (adopt, #243). */
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
  /** Before writing, removing or moving onto `rel` (vault-relative, POSIX). */
  recordWrite(rel: string): Promise<void>;
  /** The engine's own writes; `state.json` last, after the last cancel check. */
  commitEngineMetadata(steps: { beforeState: () => Promise<void>; state: () => Promise<void> }): Promise<void>;
  /** Undo the run; never throws. */
  rollback(): Promise<RollbackFailure[]>;
}

export async function beginTransaction(vaultRoot: string, opts: TransactionOptions): Promise<VaultTransaction> {
  const dir = await createBackupDir(vaultRoot, opts.now ?? new Date(), opts.kind);
  const filesDir = path.join(dir, 'files');
  const snapshotted = new Set<string>();
  const introduced: string[] = [];
  // Also kept here, so an unusable record on disk still undoes them (#295).
  const createdFolders: string[] = [];

  async function record(rel: string): Promise<void> {
    if (snapshotted.has(rel) || introduced.includes(rel)) return;
    const abs = path.join(vaultRoot, rel);
    const folders = await missingFolders(vaultRoot, [rel]);
    if (folders.length > 0) {
      createdFolders.push(...folders.filter((f) => !createdFolders.includes(f)));
      await recordCreatedFolders(dir, createdFolders);
    }
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

  return {
    dir,
    introduced,

    async recordWrite(rel) {
      // Checked on both sides: the record's own writes (the folder record,
      // the snapshot copy) are writes too, so a Ctrl+C during them stops the
      // run before the caller's write starts (#249).
      throwIfCancelled(opts.signal);
      await record(rel);
      throwIfCancelled(opts.signal);
    },
    async commitEngineMetadata(steps) {
      throwIfCancelled(opts.signal);
      await steps.beforeState();
      // state.json commits the run: the last point a Ctrl+C can stop it.
      throwIfCancelled(opts.signal);
      await steps.state();
    },

    async rollback() {
      const failures: RollbackFailure[] = [];
      // Introduced paths first, so a restore never lands on a file this run made.
      for (const rel of introduced) {
        try {
          await fsp.rm(path.join(vaultRoot, rel), { force: true });
        } catch (err) {
          failures.push({ path: rel, reason: `unlink failed: ${reasonOf(err)}` });
        }
      }
      await restoreTree(filesDir, vaultRoot, failures);
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
