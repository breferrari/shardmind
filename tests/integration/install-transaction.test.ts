/**
 * `runInstallTransaction` (#300): install's moves, writes, rollback and
 * post-commit discard, owned by the executor as update's and adopt's are.
 * One test per branch the machine used to decide itself, with the vault
 * compared byte for byte before and after.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { parseManifest } from '../../source/core/manifest.js';
import { parseSchema, buildValuesValidator } from '../../source/core/schema.js';
import {
  defaultModuleSelections,
  resolveComputedDefaults,
  planOutputs,
  detectCollisions,
} from '../../source/core/install-planner.js';
import {
  runInstall,
  runInstallTransaction,
  installRolledBack,
  type InstallTransactionOptions,
} from '../../source/core/install-executor.js';
import type { ResolvedShard } from '../../source/runtime/types.js';
import type { Collision } from '../../source/core/install-planner.js';
import { injectFaults } from '../helpers/fault-fs.js';
import { trackRun } from '../../source/commands/hooks/shared.js';
import { treeOf } from '../helpers/vault-tree.js';
import { asShown } from '../helpers/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MINIMAL_SHARD = path.join(ROOT, 'examples', 'minimal-shard');
const RESOLVED: ResolvedShard = {
  namespace: 'shardmind',
  name: 'minimal',
  version: '0.1.0',
  source: 'github:shardmind/minimal',
  tarballUrl: 'n/a (local fixture)',
};
const VALUES = { user_name: 'Alice', org_name: 'Acme Labs', vault_purpose: 'engineering', qmd_enabled: true };

let work: string;
let vault: string;

beforeEach(async () => {
  work = path.join(os.tmpdir(), `shardmind-install-tx-${crypto.randomUUID()}`);
  vault = path.join(work, 'vault');
  await fsp.mkdir(vault, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(work, { recursive: true, force: true });
});

async function loadMinimal() {
  const manifest = await parseManifest(path.join(MINIMAL_SHARD, '.shardmind', 'shard.yaml'));
  const schema = await parseSchema(path.join(MINIMAL_SHARD, '.shardmind', 'shard-schema.yaml'));
  const selections = defaultModuleSelections(schema);
  const values = buildValuesValidator(schema).parse(resolveComputedDefaults(schema, VALUES)) as Record<string, unknown>;
  return { manifest, schema, selections, values };
}

/** The transaction's options for the minimal shard into `vault`, moving `moveAside`. */
async function options(
  moveAside: Collision[],
  extra: Partial<InstallTransactionOptions> = {},
): Promise<InstallTransactionOptions> {
  const { manifest, schema, selections, values } = await loadMinimal();
  return {
    vaultRoot: vault,
    manifest,
    schema,
    tempDir: MINIMAL_SHARD,
    resolved: RESOLVED,
    tarballSha256: 'sha-0.1.0',
    values,
    selections,
    moveAside,
    keep: new Set(),
    ...extra,
  };
}

/** Two of the user's files where the shard installs, in the way. */
async function userFilesInTheWay(): Promise<Collision[]> {
  await fsp.writeFile(path.join(vault, 'Home.md'), 'my own home\n');
  await fsp.writeFile(path.join(vault, 'CLAUDE.md'), 'my own claude\n');
  await fsp.writeFile(path.join(vault, 'mine.md'), 'untouched by the shard\n');
  const { schema, selections, values } = await loadMinimal();
  const { outputs } = await planOutputs(schema, MINIMAL_SHARD, selections, values);
  const collisions = await detectCollisions(vault, outputs.map((o) => o.outputPath));
  expect(collisions.map((c) => c.outputPath).sort()).toEqual(['CLAUDE.md', 'Home.md']);
  return collisions;
}

/**
 * An installed vault, about to be reinstalled: what the machine moves aside,
 * the old `.shardmind/` and values file first, then the old install's files
 * at the paths the reinstall writes (#300).
 */
async function installedVault(): Promise<Collision[]> {
  const { manifest, schema, selections, values } = await loadMinimal();
  await runInstall({ vaultRoot: vault, manifest, schema, tempDir: MINIMAL_SHARD, resolved: RESOLVED, tarballSha256: 'sha-0', values, selections });
  // An update's snapshot in the old install: the only copy of a file.
  await fsp.mkdir(path.join(vault, '.shardmind', 'backups', 'update-1'), { recursive: true });
  await fsp.writeFile(path.join(vault, '.shardmind', 'backups', 'update-1', 'Home.md'), 'only copy\n');
  await fsp.rm(path.join(vault, 'shard-values.yaml'));
  await fsp.writeFile(path.join(vault, 'shard-values.yaml'), 'user_name: Old\n');
  const { outputs } = await planOutputs(schema, MINIMAL_SHARD, selections, values);
  return [
    ...(await detectCollisions(vault, ['.shardmind', 'shard-values.yaml'])),
    ...(await detectCollisions(vault, outputs.map((o) => o.outputPath))),
  ];
}

const rejection = async (p: Promise<unknown>) => p.then(() => { throw new Error('expected a rejection'); }, (err: unknown) => err);
const code = (err: unknown) => (err as { code?: string }).code;

describe('runInstallTransaction (#300)', () => {
  it('installs, keeping a backed-up file under its backup name', async () => {
    const collisions = await userFilesInTheWay();
    const home = collisions.find((c) => c.outputPath === 'Home.md')!;
    const result = await runInstallTransaction(await options(collisions, { keep: new Set([home.absolutePath]) }));
    expect(result.backups.map((b) => b.originalPath)).toEqual([home.absolutePath]);
    expect(await fsp.readFile(result.backups[0]!.backupPath, 'utf-8')).toBe('my own home\n');
    // CLAUDE.md was set aside, not kept: discarded once the install stood.
    const names = await fsp.readdir(vault);
    expect(names.filter((n) => n.startsWith('CLAUDE.md.shardmind-backup-'))).toEqual([]);
    expect(result.left).toEqual([]);
    expect(await fsp.readFile(path.join(vault, 'mine.md'), 'utf-8')).toBe('untouched by the shard\n');
  });

  it('(a) a move that fails is rolled back: the earlier moves go back (#301)', async () => {
    const collisions = await userFilesInTheWay();
    const before = await treeOf(vault);
    const faults = injectFaults({ fail: { kind: 'rename', nth: 2 } });
    try {
      const err = await rejection(runInstallTransaction(await options(collisions)));
      expect(code(err)).toBe('BACKUP_FAILED');
      expect(installRolledBack(err)).toBe(true);
    } finally {
      faults.uninstall();
    }
    expect(await treeOf(vault)).toEqual(before);
  });

  it('(b) a cancel before the first move touches nothing, and keeps the old install', async () => {
    const oldInstall = await installedVault();
    const before = await treeOf(vault);
    const abort = new AbortController();
    abort.abort();
    const err = await rejection(runInstallTransaction(await options(oldInstall, { signal: abort.signal })));
    expect(code(err)).toBe('CANCELLED');
    expect(await treeOf(vault)).toEqual(before);
  });

  it('(b) a run aborted before it starts (an earlier Ctrl+C) writes nothing', async () => {
    const before = await treeOf(vault);
    const abort = new AbortController();
    abort.abort();
    const err = await rejection(runInstallTransaction(await options([], { signal: abort.signal })));
    expect(code(err)).toBe('CANCELLED');
    expect(await treeOf(vault)).toEqual(before);
  });

  it('(b) a cancel between moves puts back what was moved', async () => {
    const collisions = await userFilesInTheWay();
    const before = await treeOf(vault);
    const abort = new AbortController();
    const rename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      await rename(from, to);
      abort.abort();
    });
    const err = await rejection(runInstallTransaction(await options(collisions, { signal: abort.signal })));
    vi.restoreAllMocks();
    expect(code(err)).toBe('CANCELLED');
    expect(await treeOf(vault)).toEqual(before);
  });

  it('(c) a write that fails rolls back every write and every move', async () => {
    const collisions = await userFilesInTheWay();
    const before = await treeOf(vault);
    const faults = injectFaults({ fail: { kind: 'write', nth: 3 } });
    try {
      const err = await rejection(runInstallTransaction(await options(collisions)));
      // A write failure, its errno kept as the cause (#301).
      expect(code(err)).toBe('INSTALL_WRITE_FAILED');
      expect(code((err as { cause?: unknown }).cause)).toBe('EIO');
      expect(installRolledBack(err)).toBe(true);
    } finally {
      faults.uninstall();
    }
    expect(await treeOf(vault)).toEqual(before);
  });

  it('(c) a Ctrl+C mid-write stops the writes and rolls back once', async () => {
    const collisions = await userFilesInTheWay();
    const before = await treeOf(vault);
    const abort = new AbortController();
    const faults = injectFaults({ beforeWrite: { nth: 2, hook: () => abort.abort() } });
    try {
      const err = await rejection(runInstallTransaction(await options(collisions, { signal: abort.signal })));
      expect(code(err)).toBe('CANCELLED');
      expect(installRolledBack(err)).toBe(true);
      expect(faults.writtenAfterHook).toEqual([]);
    } finally {
      faults.uninstall();
    }
    expect(await treeOf(vault)).toEqual(before);
  });

  it('(c) a rollback that cannot restore a backup says so (#247)', async () => {
    const collisions = await userFilesInTheWay();
    const faults = injectFaults({ fail: { kind: 'write', nth: 3 }, failRestore: { nth: 1 } });
    try {
      const err = await rejection(runInstallTransaction(await options(collisions)));
      expect(code(err)).toBe('ROLLBACK_INCOMPLETE');
      expect(installRolledBack(err)).toBe(true);
    } finally {
      faults.uninstall();
    }
  });

  it('(d) a reinstall that commits discards the old install, carrying its backups over', async () => {
    const oldInstall = await installedVault();
    const oldState = oldInstall.find((c) => c.outputPath === '.shardmind')!;
    const result = await runInstallTransaction(await options(oldInstall, { oldStatePath: oldState.absolutePath }));
    expect(result.left).toEqual([]);
    expect(await fsp.readFile(path.join(vault, '.shardmind', 'backups', 'update-1', 'Home.md'), 'utf-8')).toBe('only copy\n');
    const names = await fsp.readdir(vault);
    expect(names.filter((n) => n.includes('.shardmind-backup-'))).toEqual([]);
    expect(await fsp.readFile(path.join(vault, 'shard-values.yaml'), 'utf-8')).toMatch(/user_name: Alice/);
  });

  it('(d) a Ctrl+C once state.json is written rolls nothing back, and the discard finishes', async () => {
    const oldInstall = await installedVault();
    const oldState = oldInstall.find((c) => c.outputPath === '.shardmind')!;
    // The last write is state.json, after the last cancel check (#301).
    const clean = injectFaults();
    const probe = path.join(work, 'probe');
    await fsp.mkdir(probe);
    const vaultBefore = vault;
    vault = probe;
    await runInstallTransaction(await options([]));
    vault = vaultBefore;
    const lastWrite = clean.counts.write;
    clean.uninstall();

    const abort = new AbortController();
    const faults = injectFaults({ beforeWrite: { nth: lastWrite, hook: () => abort.abort() } });
    try {
      const run = runInstallTransaction(await options(oldInstall, { oldStatePath: oldState.absolutePath, signal: abort.signal }));
      // What the Ctrl+C handler awaits (stopRun): it settles only once the
      // discard is over, so the process never exits halfway through it.
      const end = await trackRun(abort, run).done;
      expect(end).toEqual({ finished: true, failures: [] });
      const names = await fsp.readdir(vault);
      expect(names.filter((n) => n.includes('.shardmind-backup-'))).toEqual([]);
      expect(faults.fired.hook).toBe(true);
      expect((await run).left).toEqual([]);
    } finally {
      faults.uninstall();
    }
    expect(await fsp.readFile(path.join(vault, 'shard-values.yaml'), 'utf-8')).toMatch(/user_name: Alice/);
  });

  it('(e) a dry run moves and writes nothing', async () => {
    const collisions = await userFilesInTheWay();
    const before = await treeOf(vault);
    const result = await runInstallTransaction(await options(collisions, { dryRun: true }));
    expect(result.backups).toEqual([]);
    expect(result.fileCount).toBeGreaterThan(0);
    expect(await treeOf(vault)).toEqual(before);
  });

  it('a file created at a planned output between plan and execute is refused, not overwritten, and the install rolls back (#301)', async () => {
    const collisions = await userFilesInTheWay();
    // Planned with Home.md and CLAUDE.md in the way; .claude/settings.json
    // arrives after planning, where the shard writes too.
    await fsp.mkdir(path.join(vault, '.claude'), { recursive: true });
    await fsp.writeFile(path.join(vault, '.claude', 'settings.json'), '{"mine": true}\n');
    const before = await treeOf(vault);
    const err = await rejection(runInstallTransaction(await options(collisions)));
    expect(code(err)).toBe('INSTALL_WRITE_FAILED');
    expect((err as Error).message).toBe('.claude/settings.json appeared after the install was planned');
    expect((err as { hint?: string }).hint).toMatch(/Run shardmind install again/);
    expect(installRolledBack(err)).toBe(true);
    expect(await treeOf(vault)).toEqual(before);
  });

  it('a full disk while writing shows INSTALL_WRITE_FAILED with the disk-full hint, and rolls back (#301)', async () => {
    const collisions = await userFilesInTheWay();
    const before = await treeOf(vault);
    const home = path.join(vault, 'Home.md');
    const realWrite = fsp.writeFile;
    vi.spyOn(fsp, 'writeFile').mockImplementation(async (file, data, opts) => {
      if (file === home) throw Object.assign(new Error(`ENOSPC: no space left on device, open '${home}'`), { code: 'ENOSPC', path: home });
      return realWrite(file, data, opts);
    });
    const err = await rejection(runInstallTransaction(await options(collisions)));
    vi.restoreAllMocks();
    const { shown, errnos } = asShown(err);
    expect(shown).toMatchObject({ kind: 'known', code: 'INSTALL_WRITE_FAILED' });
    expect(shown.message).toMatch(/Home\.md/);
    expect(shown.kind === 'known' ? shown.hint : '').toMatch(/The disk is full/);
    expect(errnos).toContain('ENOSPC');
    expect(await treeOf(vault)).toEqual(before);
  });
});
