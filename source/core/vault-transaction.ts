/**
 * One vault transaction for the commands that write a vault (#301).
 *
 * A run begins a transaction; update and adopt get a snapshot folder
 * (`.shardmind/backups/<kind>-<stamp>`), install keeps its record in memory.
 * Before each write, removal or move of a vault path the run calls
 * `recordWrite`: an existing file is copied into the snapshot once (install
 * refuses one, as it appeared after planning), a new path is marked as
 * introduced, and the folders the write will create are added to the run's
 * folder record. Install moves its collisions aside with `recordSetAside`.
 * `.shardmind/`'s own files go through `commitEngineMetadata`, which writes
 * `state.json` last: the commit point. On a failure or a Ctrl+C before it,
 * `rollback` undoes the run's in-place case renames, removes what it
 * introduced, copies the snapshot back (with the engine cache, for a run
 * over a prior install), removes the engine entries it wrote and the folders
 * it created, and moves the set-aside paths back. It never throws: what it
 * could not undo is returned (#247). After the commit, `commit` discards
 * what was set aside.
 *
 * Spec: docs/IMPLEMENTATION.md §4.28.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { createBackupDir, removeEngineWrites, ENGINE_INSTALL_WRITES } from './state.js';
import {
  missingFolders,
  recordCreatedFolders,
  removeCreatedFolders,
  rollbackCreatedFolders,
  createdFoldersRecord,
} from './created-folders.js';
import { restoreDirExactly, restoreTree } from './restore-tree.js';
import { caseJournal, sameFile, undoCaseHops, type CaseJournal } from './rename-migrations.js';
import { throwIfCancelled } from './run-cancel.js';
import { pathExists, removePath, settleAll, toPosix } from './fs-utils.js';
import { errnoCode, isEnoent } from '../runtime/errno.js';
import { acquireVaultLock, type VaultLock } from './vault-lock.js';
import { ShardMindError } from '../runtime/types.js';
import { wrapWriteError } from './bug-report.js';
import { ENGINE_SHARDMIND_ENTRIES } from './vault-path-guard.js';
import {
  CACHED_MANIFEST,
  CACHED_SCHEMA,
  CACHED_TEMPLATES,
  SHARDMIND_DIR,
  STATE_FILE,
  VALUES_FILE,
} from '../runtime/vault-paths.js';
import { reasonOf, type RollbackFailure } from './rollback-report.js';

export interface TransactionOptions {
  kind: 'install' | 'update' | 'adopt';
  now?: Date;
  signal?: AbortSignal;
  /**
   * No install before this run (install, adopt): a rollback also removes the
   * engine entries it wrote under `.shardmind/`, and adopt's snapshot unless
   * it holds the only copy of a file (#243, #246). Otherwise (update) the
   * engine cache is snapshotted when the run begins and restored by its
   * rollback, and the snapshot is kept: the update summary points at it.
   */
  noPriorInstall: boolean;
  /**
   * Install into a folder it creates (#333): the missing levels, outermost
   * first (`install-destination.ts`). Begin makes them and takes the vault
   * lock; the rollback releases it and removes them, once empty.
   */
  createRoot?: { folders: readonly string[]; command: 'install' };
}

/** A path moved out of the way under a backup name (absolute paths). */
export interface BackupRecord {
  originalPath: string;
  backupPath: string;
}

export interface VaultTransaction {
  /** The run's snapshot folder; install has none (§4.28 step 1). */
  readonly dir: string | null;
  /**
   * The paths this run introduced, removed by a rollback. The rename helpers
   * add their temporaries here and take back a path they did not get; a
   * file written with an exclusive flag is added only once written, so a
   * rollback never removes one that appeared meanwhile.
   */
  readonly introduced: string[];
  /** Every in-place case hop, journaled before its first rename (#169, #195); install has none. */
  readonly journal: CaseJournal | null;
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
  /**
   * Move `abs` (a file or folder) out of the way under a backup name (#55).
   * `keep`: a backup the user is told about; otherwise it is set aside,
   * restored by a rollback and discarded by `commit`.
   */
  recordSetAside(abs: string, keep: boolean): Promise<BackupRecord>;
  /** The engine's own writes; `state.json` last, after the last cancel check. */
  commitEngineMetadata(steps: { beforeState: () => Promise<void>; state: () => Promise<void> }): Promise<void>;
  /** Undo the run; never throws. */
  rollback(): Promise<RollbackFailure[]>;
  /**
   * After `state.json`: discard what was set aside, a reinstall's old
   * `.shardmind/` (`oldStatePath`) handing its backups and the owner's own
   * entries to the new one first (#55, #237). Never throws.
   */
  commit(opts?: { oldStatePath?: string }): Promise<{ kept: BackupRecord[]; left: BackupRecord[] }>;
}

/** Update's and adopt's transaction: a snapshot folder and a case-hop journal. */
export interface SnapshotTransaction extends VaultTransaction {
  readonly dir: string;
  readonly journal: CaseJournal;
}

/** Records whether `.shardmind/templates/` existed when the snapshot was taken (#264). */
const TEMPLATES_SNAPSHOT_MARKER = 'templates-snapshot.json';

export function beginTransaction(
  vaultRoot: string,
  opts: TransactionOptions & { kind: 'update' | 'adopt' },
): Promise<SnapshotTransaction>;
export function beginTransaction(vaultRoot: string, opts: TransactionOptions): Promise<VaultTransaction>;
export async function beginTransaction(vaultRoot: string, opts: TransactionOptions): Promise<VaultTransaction> {
  // Before anything reads the vault: it does not exist yet (§4.28 step 0).
  const createdRoot = opts.createRoot ? await createVaultRoot(vaultRoot, opts.createRoot) : null;
  const now = opts.now ?? new Date();
  // A `.shardmind/` that was here is the user's (or the old install's): the
  // rollback removes only one this run made, once empty.
  const hadStateDir = await pathExists(path.join(vaultRoot, SHARDMIND_DIR));
  // Install keeps its record in memory: nothing reads one after a crash, and
  // on a reinstall the folder would sit in the `.shardmind/` that restoring
  // the old one replaces whole (§4.28 step 1).
  const dir = opts.kind === 'install' ? null : await createBackupDir(vaultRoot, now, opts.kind);
  if (dir !== null && !opts.noPriorInstall) await snapshotEngineCache(vaultRoot, dir);
  const filesDir = dir === null ? null : path.join(dir, 'files');
  const stamp = now.toISOString().replace(/:/g, '-').replace(/\..+$/, '');
  const snapshotted = new Set<string>();
  const introduced: string[] = [];
  // Also kept here, so an unusable record on disk still undoes them (#295).
  const createdFolders: string[] = [];
  // One answer per folder for the whole run (#258).
  const seen = new Map<string, boolean>();
  const setAside: Array<BackupRecord & { keep: boolean }> = [];
  // Engine entries are the rollback's to remove only once their commit began.
  let engineStarted = false;

  async function recordFolders(paths: readonly string[], folders: readonly string[] = []): Promise<void> {
    const missing = await missingFolders(vaultRoot, paths, { folders, seen });
    if (missing.length === 0) return;
    createdFolders.push(...missing);
    if (dir !== null) await recordCreatedFolders(dir, createdFolders);
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
    // No snapshot to keep it in: the caller refuses an existing file before
    // it records (install, §4.11b), so one here is a file that arrived since.
    if (filesDir === null) throw new Error(`${rel} exists, and this transaction has no snapshot to keep it in`);
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

  async function moveAside(abs: string, keep: boolean): Promise<BackupRecord> {
    let backupPath: string;
    try {
      backupPath = await uniqueBackupPath(abs, stamp);
      await fsp.rename(abs, backupPath);
    } catch (err) {
      // The earlier moves are the rollback's to put back; an errno keeps its
      // hint (#225), and a ShardMindError (no free name) passes through.
      throw wrapWriteError('BACKUP_FAILED', `Could not move ${abs} aside`, err, `${reasonOf(err)}. Check permissions on the path and retry.`);
    }
    const moved = { originalPath: abs, backupPath, keep };
    setAside.push(moved);
    return { originalPath: abs, backupPath };
  }

  // Checked on both sides of each record: the record's own writes (the
  // folder record, the snapshot copy, a move aside) are writes too, so a
  // Ctrl+C during them stops the run before the caller's write starts (#249).
  async function guarded<T>(step: () => Promise<T>): Promise<T> {
    throwIfCancelled(opts.signal);
    const result = await step();
    throwIfCancelled(opts.signal);
    return result;
  }

  return {
    dir,
    introduced,
    journal: dir === null ? null : caseJournal(dir),

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
    recordSetAside: (abs, keep) => guarded(() => moveAside(abs, keep)),

    async commitEngineMetadata(steps) {
      throwIfCancelled(opts.signal);
      if (opts.noPriorInstall) {
        // The engine entries already here are not the run's: a clone of the
        // shard repo carries the shard's own `shard.yaml` and schema. Set
        // aside, they come back on a rollback and go on commit (#301).
        for (const rel of ENGINE_INSTALL_WRITES) {
          const abs = path.join(vaultRoot, rel);
          if (await pathExists(abs)) await moveAside(abs, false);
        }
      }
      engineStarted = true;
      await steps.beforeState();
      // state.json commits the run: the last point a Ctrl+C can stop it.
      throwIfCancelled(opts.signal);
      await steps.state();
    },

    async rollback() {
      // Old spellings first (#169, #195). Either order with the restore gives
      // the same tree on a case-folding filesystem; undo-first reads plainer.
      const failures: RollbackFailure[] = dir === null ? [] : [...(await undoCaseHops(vaultRoot, dir))];
      // Introduced paths next, so a restore never lands on a file this run made.
      for (const rel of introduced) {
        const abs = path.join(vaultRoot, rel);
        try {
          await fsp.rm(abs, { force: true });
        } catch (err) {
          // A folder there is the user's, made during the run: left.
          const isFolder = await fsp.lstat(abs).then((st) => st.isDirectory(), () => false);
          if (!isFolder) failures.push({ path: rel, reason: `unlink failed: ${reasonOf(err)}` });
        }
      }
      if (dir !== null && filesDir !== null) {
        await restoreTree(filesDir, vaultRoot, failures);
        if (!opts.noPriorInstall) await restoreEngineCache(vaultRoot, dir, path.join(dir, 'cache'), failures);
      }
      // The engine entries at their paths are the run's once their commit
      // began: the others were set aside, and come back below.
      if (opts.noPriorInstall && engineStarted) {
        for (const failure of await removeEngineWrites(vaultRoot, { removeEmptyDir: false })) {
          failures.push({ path: failure.path, reason: `cleanup failed: ${failure.reason}` });
        }
      }
      failures.push(
        ...(dir === null
          ? await removeCreatedFolders(vaultRoot, createdFolders)
          : await rollbackCreatedFolders(vaultRoot, dir, toPosix(vaultRoot, createdFoldersRecord(dir)), createdFolders)),
      );
      // Last, newest first, so each lands on a path the steps above freed.
      for (const moved of [...setAside].reverse()) {
        try {
          await removePath(moved.originalPath);
          await fsp.rename(moved.backupPath, moved.originalPath);
        } catch (err) {
          failures.push({
            path: toPosix(vaultRoot, moved.originalPath),
            reason: `restore failed: ${reasonOf(err)}`,
            backup: moved.backupPath,
          });
        }
      }
      if (opts.noPriorInstall) {
        // The snapshot goes with the rest, unless it holds the only copy of
        // a file: a failure that names a backup inside it (restore-tree.ts).
        const inSnapshot = (backup: string | undefined) =>
          dir !== null && backup !== undefined && !path.relative(dir, backup).startsWith('..');
        const keep = failures.some((f) => inSnapshot(f.backup));
        for (const failure of await removeEngineWrites(vaultRoot, {
          entries: false,
          snapshotDir: dir === null || keep ? null : dir,
          removeEmptyDir: !hadStateDir,
        })) {
          failures.push({ path: failure.path, reason: `cleanup failed: ${failure.reason}` });
        }
      }
      // The vault this run made goes last, lock first: it lives inside it.
      if (createdRoot) failures.push(...(await removeVaultRoot(createdRoot)));
      return failures;
    },

    async commit({ oldStatePath } = {}) {
      createdRoot?.lock.release();
      const kept = setAside.filter((m) => m.keep).map(({ originalPath, backupPath }) => ({ originalPath, backupPath }));
      const left = await discardSetAside(
        setAside.filter((m) => !m.keep),
        oldStatePath,
        vaultRoot,
      );
      return { kept, left };
    },
  };
}

interface CreatedRoot {
  /** The levels this begin made, outermost first. */
  made: string[];
  lock: VaultLock;
}

/**
 * Make the vault folder and its missing parents, then lock it (#333). The
 * vault folder is made with a plain `mkdir`, so of two runs racing for one
 * name one wins; the other is refused, as is a file at any level. A parent
 * another run made meanwhile is a folder all the same, and not ours.
 */
async function createVaultRoot(vaultRoot: string, root: { folders: readonly string[]; command: 'install' }): Promise<CreatedRoot> {
  const made: string[] = [];
  try {
    for (const folder of root.folders) {
      try {
        await fsp.mkdir(folder);
        made.push(folder);
      } catch (err) {
        const isFolder = await fsp.lstat(folder).then((st) => st.isDirectory(), () => false);
        if (folder === vaultRoot || !isFolder) {
          if (errnoCode(err) !== 'EEXIST') throw wrapWriteError('INSTALL_WRITE_FAILED', `Could not create ${folder}`, err);
          throw new ShardMindError(
            `Cannot install into ${vaultRoot}: ${folder} appeared after this install planned`,
            'INSTALL_DESTINATION_NOT_EMPTY',
            'Another run, or another program, took that folder. Give another folder name, or install into the current folder with `.`.',
          );
        }
      }
    }
    return { made, lock: acquireVaultLock(vaultRoot, root.command) };
  } catch (err) {
    for (const folder of [...made].reverse()) await fsp.rmdir(folder).catch(() => {});
    throw err;
  }
}

/** The rollback's last step for a vault it made: release the lock, then remove the folders, once empty. */
async function removeVaultRoot(root: CreatedRoot): Promise<RollbackFailure[]> {
  root.lock.release();
  const failures: RollbackFailure[] = [];
  for (const folder of [...root.made].reverse()) {
    try {
      await fsp.rmdir(folder);
    } catch (err) {
      // Something else put a file there during the run: left, and named.
      if (!isEnoent(err)) failures.push({ path: folder, reason: `remove failed: ${reasonOf(err)}` });
      break;
    }
  }
  return failures;
}

async function uniqueBackupPath(absolutePath: string, stamp: string): Promise<string> {
  const base = `${absolutePath}.shardmind-backup-${stamp}`;
  if (!(await pathExists(base))) return base;
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base}.${i}`;
    if (!(await pathExists(candidate))) return candidate;
  }
  throw new ShardMindError(
    `Could not find a unique backup name for ${absolutePath}`,
    'BACKUP_FAILED',
    'Too many existing backups with the same timestamp — clean up old .shardmind-backup-* files and retry.',
  );
}

/**
 * Delete what a run set aside only to restore on failure, once it has
 * committed (#55). A reinstall's old `.shardmind/` (`oldStatePath`) first
 * hands its `backups/` and the vault owner's own entries (#237) to the new
 * one; if that fails it stays set aside, so nothing is lost. Best effort:
 * it never throws, because the run it follows is already committed. What it
 * could not remove is still there under its backup name, and is returned so
 * the summary lists it rather than calling it removed (#228).
 */
export async function discardSetAside(
  setAside: readonly BackupRecord[],
  oldStatePath: string | undefined,
  vaultRoot: string,
): Promise<BackupRecord[]> {
  const left: BackupRecord[] = [];
  for (const { originalPath, backupPath } of setAside) {
    const record = { originalPath, backupPath };
    if (originalPath === oldStatePath) {
      try {
        await carryOverBackups(backupPath, vaultRoot);
        await carryOverUserEntries(backupPath, vaultRoot);
      } catch {
        left.push(record);
        continue;
      }
    }
    try {
      await removePath(backupPath);
    } catch {
      left.push(record);
    }
  }
  return left;
}

/**
 * Move the vault owner's own entries (everything not in
 * `ENGINE_SHARDMIND_ENTRIES`) from a reinstall's old `.shardmind/` into the
 * new one, so a reinstall keeps them (#237). An entry whose name the new
 * folder already has moves under `<name>-<n>`, as `carryOverBackups` does,
 * so nothing is dropped when the old folder is deleted.
 */
export async function carryOverUserEntries(oldStateDir: string, vaultRoot: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fsp.readdir(oldStateDir);
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }
  const own = entries.filter((entry) => !ENGINE_SHARDMIND_ENTRIES.has(entry.toLowerCase()));
  if (own.length === 0) return;
  const to = path.join(vaultRoot, SHARDMIND_DIR);
  await fsp.mkdir(to, { recursive: true });
  for (const entry of own) {
    let target = path.join(to, entry);
    for (let n = 1; await pathExists(target); n++) target = path.join(to, `${entry}-${n}`);
    await fsp.rename(path.join(oldStateDir, entry), target);
  }
}

/**
 * Move the `backups/` of an old `.shardmind/` that a reinstall set aside
 * into the new one, before the old one is deleted (#55). An update's or
 * an adopt's snapshot can be the only copy of the user's earlier files.
 * Entries already in the new `backups/` are kept; an old entry whose
 * name is taken moves under `<name>-<n>`, so nothing is dropped.
 */
export async function carryOverBackups(oldStateDir: string, vaultRoot: string): Promise<void> {
  const from = path.join(oldStateDir, 'backups');
  let entries: string[];
  try {
    entries = await fsp.readdir(from);
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }
  const to = path.join(vaultRoot, SHARDMIND_DIR, 'backups');
  await fsp.mkdir(to, { recursive: true });
  for (const entry of entries) {
    let target = path.join(to, entry);
    for (let n = 1; await pathExists(target); n++) target = path.join(to, `${entry}-${n}`);
    await fsp.rename(path.join(from, entry), target);
  }
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
