/**
 * The rollback contract, one table for every write pipeline (#267).
 *
 * Each row runs install, update or adopt with one fault injected through the
 * shared `fsp` (`tests/helpers/fault-fs.ts`): the Nth write, rename or mkdir
 * fails, a restore fails after a write did, or Ctrl+C lands at write N. The
 * pipeline runs as its command runs it, rollback included. One assertion
 * covers every row: after the rollback the vault tree (names with case,
 * folders, file bytes, `.shardmind/` included) is the tree from before,
 * except the paths `ROLLBACK_INCOMPLETE` names and each pipeline's
 * documented exceptions below. When the fault was tolerated and the run
 * finished, the vault must be whole instead: every tracked file present
 * with its recorded bytes.
 *
 * A row that fails is a defect: it is filed in Phase 5 and listed in
 * `KNOWN_DEFECTS` as the exact paths it leaves, with its issue. Those
 * differences are allowed, and every use is counted; the last test fails
 * when a known defect no longer shows up, so a fix turns the suite red
 * until its entry goes. Keyed by what the defect leaves, not by row number:
 * which write is "#14" depends on the platform's directory order.
 */

import { describe, it, expect } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { parseManifest } from '../../source/core/manifest.js';
import { parseSchema, buildValuesValidator } from '../../source/core/schema.js';
import { readState } from '../../source/core/state.js';
import { detectDrift } from '../../source/core/drift.js';
import { applyMigrations } from '../../source/core/migrator.js';
import {
  defaultModuleSelections,
  resolveComputedDefaults,
  planOutputs,
  detectCollisions,
} from '../../source/core/install-planner.js';
import {
  runInstall,
  rollbackInstall,
  backupCollisions,
  type BackupRecord,
} from '../../source/core/install-executor.js';
import { planUpdate, mergeModuleSelections } from '../../source/core/update-planner.js';
import { runUpdate } from '../../source/core/update-executor.js';
import { classifyAdoption } from '../../source/core/adopt-planner.js';
import { runAdopt } from '../../source/core/adopt-executor.js';
import { buildRenderContext } from '../../source/core/renderer.js';
import { attemptRollback, rollbackFailuresOf, withRollbackFailures } from '../../source/core/rollback-report.js';
import type { ResolvedShard, ShardState } from '../../source/runtime/types.js';
import { injectFaults, type FaultKind, type FaultPlan } from '../helpers/fault-fs.js';

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

// ---------------------------------------------------------------------------
// The vault tree, as the contract compares it
// ---------------------------------------------------------------------------

/** Every entry under `root` (POSIX, with case): `dir`, `link:<target>` or the file's sha256. */
async function treeOf(root: string): Promise<Map<string, string>> {
  const tree = new Map<string, string>();
  const walk = async (dir: string) => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (entry.isSymbolicLink()) tree.set(rel, `link:${await fsp.readlink(abs)}`);
      else if (entry.isDirectory()) {
        tree.set(rel, 'dir');
        await walk(abs);
      } else tree.set(rel, crypto.createHash('sha256').update(await fsp.readFile(abs)).digest('hex'));
    }
  };
  await walk(root);
  return tree;
}

/** The paths whose entry differs between two trees, sorted. */
function differences(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((p) => before.get(p) !== after.get(p)).sort();
}

// ---------------------------------------------------------------------------
// The pipelines, each run as its command runs it
// ---------------------------------------------------------------------------

interface Exception {
  /** A path prefix (POSIX, vault-relative) the rollback may leave changed. */
  prefix: RegExp;
  /** Why, by design: the spec section or issue that says so. */
  why: string;
}

interface Pipeline {
  name: 'install' | 'update' | 'adopt';
  /** Builds the vault (and anything else the run needs) in `work`; returns the run. */
  setUp: (work: string) => Promise<{ vault: string; run: (signal: AbortSignal) => Promise<void> }>;
  exceptions: Exception[];
}

async function loadMinimal(shardDir = MINIMAL_SHARD) {
  const manifest = await parseManifest(path.join(shardDir, '.shardmind', 'shard.yaml'));
  const schema = await parseSchema(path.join(shardDir, '.shardmind', 'shard-schema.yaml'));
  const selections = defaultModuleSelections(schema);
  const values = buildValuesValidator(schema).parse(resolveComputedDefaults(schema, VALUES)) as Record<string, unknown>;
  return { manifest, schema, selections, values };
}

/** A fresh install into a vault with the user's own files, one in the way (backed up, #55). */
const install: Pipeline = {
  name: 'install',
  async setUp(work) {
    const vault = path.join(work, 'vault');
    await fsp.mkdir(path.join(vault, 'notes'), { recursive: true });
    await fsp.writeFile(path.join(vault, 'Home.md'), 'my own home\n');
    await fsp.writeFile(path.join(vault, 'notes', 'mine.md'), 'my note\n');
    const { manifest, schema, selections, values } = await loadMinimal();
    const { outputs } = await planOutputs(schema, MINIMAL_SHARD, selections, values);
    const collisions = await detectCollisions(vault, outputs.map((o) => o.outputPath));
    const run = async (signal: AbortSignal) => {
      // As use-install-machine runs it: move collisions aside, install, and on
      // a throw roll back every path reported so far (#207, #215).
      const backups: BackupRecord[] = [];
      const written: string[] = [];
      const dirs: string[] = [];
      try {
        await backupCollisions(collisions, undefined, (record) => backups.push(record));
        await runInstall({
          vaultRoot: vault,
          manifest,
          schema,
          tempDir: MINIMAL_SHARD,
          resolved: RESOLVED,
          tarballSha256: 'sha-0.1.0',
          values,
          selections,
          signal,
          onFileWritten: (rel) => written.push(rel),
          onDirCreated: (dir) => dirs.push(dir),
        });
      } catch (err) {
        throw withRollbackFailures(err, await attemptRollback(() => rollbackInstall(vault, written, backups, dirs)));
      }
    };
    return { vault, run };
  },
  exceptions: [],
};

/** An installed vault and a release that changes Home.md, adds a file in new folders and drops CLAUDE.md. */
const update: Pipeline = {
  name: 'update',
  async setUp(work) {
    const vault = path.join(work, 'vault');
    const newShard = path.join(work, 'shard-0.2.0');
    await fsp.mkdir(vault, { recursive: true });
    const base = await loadMinimal();
    await runInstall({
      vaultRoot: vault,
      manifest: base.manifest,
      schema: base.schema,
      tempDir: MINIMAL_SHARD,
      resolved: RESOLVED,
      tarballSha256: 'sha-0.1.0',
      values: base.values,
      selections: base.selections,
    });
    await fsp.cp(MINIMAL_SHARD, newShard, { recursive: true });
    const manifestPath = path.join(newShard, '.shardmind', 'shard.yaml');
    await fsp.writeFile(manifestPath, (await fsp.readFile(manifestPath, 'utf-8')).replace(/^version: .+$/m, 'version: 0.2.0'));
    await fsp.writeFile(path.join(newShard, 'Home.md.njk'), '# Home v2 for {{ user_name }}\n');
    await fsp.mkdir(path.join(newShard, 'Fresh', 'Deep'), { recursive: true });
    await fsp.writeFile(path.join(newShard, 'Fresh', 'Deep', 'note.md'), 'new in 0.2.0\n');
    await fsp.rm(path.join(newShard, 'CLAUDE.md'));
    const state = (await readState(vault)) as ShardState;
    const oldValues = parseYaml(await fsp.readFile(path.join(vault, 'shard-values.yaml'), 'utf-8')) as Record<string, unknown>;
    const newManifest = await parseManifest(manifestPath);
    const newSchema = await parseSchema(path.join(newShard, '.shardmind', 'shard-schema.yaml'));
    const migration = applyMigrations(oldValues, state.version, newManifest.version, newSchema.migrations);
    const selections = mergeModuleSelections(state.modules, newSchema, {});
    const plan = await planUpdate({
      vault: { root: vault, state, drift: await detectDrift(vault, state) },
      values: { old: oldValues, new: migration.values },
      newShard: {
        schema: newSchema,
        selections,
        tempDir: newShard,
        renderContext: buildRenderContext(newManifest, migration.values, selections),
      },
      removedFileDecisions: {},
    });
    const run = async (signal: AbortSignal) => {
      await runUpdate({
        vaultRoot: vault,
        plan,
        conflictResolutions: {},
        currentState: state,
        newManifest,
        newSchema,
        newValues: migration.values,
        newSelections: selections,
        resolved: { ...RESOLVED, version: '0.2.0' },
        tarballSha256: 'sha-0.2.0',
        newTempDir: newShard,
        signal,
      });
    };
    return { vault, run };
  },
  exceptions: [
    {
      prefix: /^\.shardmind\/backups(\/update-[^/]+(\/.*)?)?$/,
      why: 'update keeps its snapshot after a rollback, the user\'s copy of what it replaced (IMPLEMENTATION §4.12)',
    },
  ],
};

/** A vault with the user's Home.md, taken from the shard, and the shard's other files new. */
const adopt: Pipeline = {
  name: 'adopt',
  async setUp(work) {
    const vault = path.join(work, 'vault');
    await fsp.mkdir(vault, { recursive: true });
    await fsp.writeFile(path.join(vault, 'Home.md'), 'my pre-existing Home\n');
    const { manifest, schema, selections, values } = await loadMinimal();
    const plan = await classifyAdoption({ vaultRoot: vault, schema, manifest, tempDir: MINIMAL_SHARD, values, selections });
    const resolutions = Object.fromEntries(plan.differs.map((c) => [c.path, 'use_shard' as const]));
    const run = async (signal: AbortSignal) => {
      await runAdopt({
        vaultRoot: vault,
        manifest,
        schema,
        tempDir: MINIMAL_SHARD,
        resolved: RESOLVED,
        tarballSha256: 'sha-0.1.0',
        values,
        selections,
        plan,
        resolutions,
        signal,
      });
    };
    return { vault, run };
  },
  exceptions: [
    {
      prefix: /^\.shardmind(\/backups(\/adopt-[^/]+(\/.*)?)?)?$/,
      why: 'adopt keeps its snapshot, the only copy, when a restore from it failed (#246); only allowed with ROLLBACK_INCOMPLETE',
    },
  ],
};

const PIPELINES = [install, update, adopt];

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

type Fault = 'write' | 'rename' | 'mkdir' | 'restore' | 'ctrl-c';

interface Row {
  id: string;
  pipeline: Pipeline;
  fault: Fault;
  plan: (abort: AbortController) => FaultPlan;
}

/**
 * A filed defect: exactly the paths it leaves changed after a rollback, for
 * one pipeline and one kind of fault. An entry is a hole in the net, so it is
 * as narrow as the defect: a row passes on it only when its unexplained
 * differences are exactly `leaves`, and the last tests fail when the defect no
 * longer shows up or a listed path is never one it leaves.
 */
interface KnownDefect {
  issue: string;
  pipeline: Pipeline['name'];
  fault: Fault;
  /** Every path it leaves changed, vault-relative POSIX. */
  leaves: string[];
}

const KNOWN_DEFECTS: KnownDefect[] = [
  {
    // A failed snapshot folder leaves the folders made on the way to it.
    issue: '#269',
    pipeline: 'adopt',
    fault: 'mkdir',
    leaves: ['.shardmind', '.shardmind/backups'],
  },
];
/** Per issue, the paths a row passed on it with. */
const knownDefectsSeen = new Map<string, Set<string>>();
/** Pipelines with a row whose restore fault actually fired. */
const restoreFaultsFired = new Set<Pipeline['name']>();

async function freshWork(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'rollback-contract-'));
}

/** Each pipeline's calls of each kind in a run with no fault: the Ns the rows cover. */
async function countCalls(pipeline: Pipeline): Promise<Record<FaultKind, number>> {
  const work = await freshWork();
  try {
    const { run } = await pipeline.setUp(work);
    const injector = injectFaults();
    try {
      await run(new AbortController().signal);
    } finally {
      injector.uninstall();
    }
    return { ...injector.counts };
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

const rows: Row[] = [];
for (const pipeline of PIPELINES) {
  const counts = await countCalls(pipeline);
  for (const kind of ['write', 'rename', 'mkdir'] as const) {
    for (let nth = 1; nth <= counts[kind]; nth++) {
      rows.push({ id: `${pipeline.name}: fail ${kind} #${nth}`, pipeline, fault: kind, plan: () => ({ fail: { kind, nth } }) });
    }
  }
  for (let nth = 1; nth <= counts.write; nth++) {
    rows.push({
      id: `${pipeline.name}: fail write #${nth}, then the first restore`,
      pipeline,
      fault: 'restore',
      plan: () => ({ fail: { kind: 'write', nth }, failRestore: { nth: 1 } }),
    });
    rows.push({
      id: `${pipeline.name}: Ctrl+C at write #${nth}`,
      pipeline,
      fault: 'ctrl-c',
      plan: (abort) => ({ beforeWrite: { nth, hook: () => abort.abort() } }),
    });
  }
}

/** The error and every cause under it. */
function causes(err: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let e: unknown = err; e !== undefined && e !== null && chain.length < 10; e = (e as { cause?: unknown }).cause) {
    chain.push(e);
  }
  return chain;
}

/** Bookkeeping a Ctrl+C lets its step finish (#249); state.json, the commit, is never one. */
function isStepBookkeeping(rel: string): boolean {
  return (
    rel.startsWith('.shardmind/backups/') ||
    rel.startsWith('.shardmind/templates/') ||
    rel === '.shardmind/templates' ||
    rel === '.shardmind/shard.yaml' ||
    rel === '.shardmind/shard-schema.yaml' ||
    rel === 'shard-values.yaml'
  );
}

describe('rollback contract (#267)', () => {
  it('covers every pipeline with rows of every fault kind', () => {
    for (const pipeline of PIPELINES) {
      const faults = new Set(rows.filter((r) => r.pipeline === pipeline).map((r) => r.fault));
      expect([...faults].sort()).toEqual(['ctrl-c', 'mkdir', 'restore', 'write', ...(faults.has('rename') ? ['rename'] : [])].sort());
    }
  });

  for (const row of rows) {
    it(row.id, async () => {
      const work = await freshWork();
      try {
        const { vault, run } = await row.pipeline.setUp(work);
        const before = await treeOf(vault);
        const abort = new AbortController();
        const injector = injectFaults(row.plan(abort));
        let error: unknown = null;
        try {
          await run(abort.signal);
        } catch (err) {
          error = err;
        }
        // Once the run has returned or thrown, nothing of it is still going:
        // no write lands after its rollback, or after it reported (#274).
        injector.settle();
        await new Promise((r) => setTimeout(r, 50));
        injector.uninstall();
        expect(injector.touchedAfterSettle, 'fs calls after the run settled').toEqual([]);

        // The row's fault really happened: a row whose fault never fired
        // would pass for the wrong reason.
        if (row.fault === 'ctrl-c') expect(injector.fired.hook, 'Ctrl+C fired').toBe(true);
        else if (row.fault !== 'restore') expect(injector.fired.fail, `${row.fault} fault fired`).toBe(true);
        if (injector.fired.restore) restoreFaultsFired.add(row.pipeline.name);

        if (row.fault === 'ctrl-c') {
          // A Ctrl+C stops the vault writes before the rollback (#249): none
          // starts after it besides the one under way and the bookkeeping its
          // step finishes, and state.json, which commits the run, never.
          const late = injector.writtenAfterHook
            .map((p) => path.relative(vault, p).split(path.sep).join('/'))
            .filter((rel) => !isStepBookkeeping(rel));
          expect(late, 'written after Ctrl+C').toEqual([]);
        }

        if (error === null) {
          // The fault was tolerated: the run finished, and the vault is whole.
          // Only a fault in a best-effort step (or a Ctrl+C after the last
          // check, #249) may end here.
          const state = (await readState(vault)) as ShardState;
          const drift = await detectDrift(vault, state);
          expect(drift.missing.map((e) => e.path)).toEqual([]);
          expect(drift.modified.map((e) => e.path)).toEqual([]);
          return;
        }

        // The run failed because of this row's fault, not anything else.
        const chain = causes(error);
        const ours =
          row.fault === 'ctrl-c'
            ? chain.some((e) => (e as { code?: unknown }).code === 'CANCELLED')
            : chain.some((e) =>
                // The executors wrap an fs error and keep its message in the hint.
                /injected EIO/.test(`${String((e as Error).message ?? e)} ${String((e as { hint?: unknown }).hint ?? '')}`),
              );
        expect(ours, `failed with the injected fault, not: ${String(error)}`).toBe(true);

        const failures = rollbackFailuresOf(error);
        // A named path may differ, and so may the folders on its way (as
        // folders, never their other contents).
        const named = new Set<string>();
        const namedFolders = new Set<string>();
        for (const f of failures) {
          for (const p of [f.path, f.backup ? path.relative(vault, f.backup) : null]) {
            if (!p) continue;
            const segments = p.split(path.sep).join('/').split('/');
            named.add(segments.join('/'));
            for (let i = 1; i < segments.length; i++) namedFolders.add(segments.slice(0, i).join('/'));
          }
        }
        const after = await treeOf(vault);
        const isFolder = (p: string) => before.get(p) === 'dir' || after.get(p) === 'dir';
        // Adopt keeps its snapshot only when a restore from it, or its folder
        // record, failed (#246, #258).
        const keptSnapshot = failures.some((f) => /^(restore|readdir) failed|^folder record unreadable/.test(f.reason));
        const allowed = (p: string) =>
          named.has(p) ||
          (namedFolders.has(p) && isFolder(p)) ||
          row.pipeline.exceptions.some((e) => e.prefix.test(p) && (row.pipeline.name !== 'adopt' || keptSnapshot));
        const unexplained = differences(before, after).filter((p) => !allowed(p));

        if (unexplained.length > 0) {
          const defect = KNOWN_DEFECTS.find(
            (d) =>
              d.pipeline === row.pipeline.name &&
              d.fault === row.fault &&
              d.leaves.length === unexplained.length &&
              d.leaves.every((p) => unexplained.includes(p)),
          );
          if (defect) {
            const seen = knownDefectsSeen.get(defect.issue) ?? new Set<string>();
            for (const p of unexplained) seen.add(p);
            knownDefectsSeen.set(defect.issue, seen);
            return;
          }
        }
        expect(unexplained, `rolled back with ${String(error)}`).toEqual([]);
      } finally {
        await fsp.rm(work, { recursive: true, force: true });
      }
    });
  }

  // Last: the restore rows reached a restore in every pipeline, each known
  // defect still shows up (or its fix has landed and its entry must go), and
  // no entry lists a path its defect does not leave.
  it('failed a restore in every pipeline', () => {
    expect([...restoreFaultsFired].sort()).toEqual(PIPELINES.map((p) => p.name).sort());
  });

  it('still meets every known defect it allows', () => {
    expect([...knownDefectsSeen.keys()].sort()).toEqual(KNOWN_DEFECTS.map((d) => d.issue).sort());
  });

  it('allows no path a known defect does not leave', () => {
    for (const defect of KNOWN_DEFECTS) {
      expect([...(knownDefectsSeen.get(defect.issue) ?? [])].sort(), defect.issue).toEqual([...defect.leaves].sort());
    }
  });
});

// ---------------------------------------------------------------------------
// The seam's reach: nothing in the write paths touches the vault around `fsp`
// ---------------------------------------------------------------------------

/** The `fsp` methods the injector wraps (`tests/helpers/fault-fs.ts`). */
const WRAPPED = ['writeFile', 'copyFile', 'cp', 'rename', 'mkdir', 'rm', 'unlink', 'rmdir'];
/** The `fsp` methods that only read, and so need no fault. */
const READ_ONLY = ['readFile', 'readdir', 'lstat', 'stat', 'access', 'readlink', 'realpath'];

/**
 * Files in the write paths' import closure allowed to use the filesystem in a
 * way the injector does not see, each with why it cannot change the vault.
 * The closure is install's, update's and adopt's executors and planners; the
 * vault lock (`vault-lock.ts`) and the hook runner (`hook.ts`) are the
 * command layer's, outside it, and outside the rollback.
 */
const OUTSIDE_FSP_ALLOWED: Record<string, { finding: string; why: string }> = {
  'source/core/modules.ts': {
    finding: 'fsp.open(',
    why: "opens a shard source file read-only ('r') to sniff whether it is binary; it never writes",
  },
};

const FS_SPEC = String.raw`(?:node:)?fs(?:\/promises)?|fs-extra|graceful-fs|(?:node:)?child_process|tar`;

describe('fault injection reaches every vault write (#267)', () => {
  it('the write paths reach the filesystem only through the default fsp', async () => {
    const entries = ['install', 'update', 'adopt'].flatMap((p) => [
      `source/core/${p}-executor.ts`,
      `source/core/${p}-planner.ts`,
    ]);
    const seen = new Set<string>();
    const queue = [...entries];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const text = await fsp.readFile(path.join(ROOT, file), 'utf-8');
      for (const m of text.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+'(\.[^']+)'/gm)) {
        const next = path.posix.join(path.posix.dirname(file), m[1]!).replace(/\.js$/, '.ts');
        if (await fsp.access(path.join(ROOT, next)).then(() => true, () => false)) queue.push(next);
      }
    }
    expect(seen.size).toBeGreaterThan(entries.length);

    const escapes: string[] = [];
    const allowedHits = new Set<string>();
    for (const file of [...seen].sort()) {
      const text = await fsp.readFile(path.join(ROOT, file), 'utf-8');
      const found: string[] = [];
      // Static imports and re-exports, over several lines too.
      for (const m of text.matchAll(new RegExp(String.raw`^(import|export)\s+(?!type\b)([^;]*?)\s+from\s+'(${FS_SPEC})'`, 'gm'))) {
        const [, keyword, clause, spec] = m;
        // Only a default import of fs/promises is the shared object the
        // injector wraps; a named or namespace one would escape it.
        if (keyword === 'import' && /fs\/promises$/.test(spec!) && /^\w+$/.test(clause!.trim())) continue;
        found.push(`${keyword} ${clause!.replace(/\s+/g, ' ')} from '${spec}'`);
      }
      for (const m of text.matchAll(new RegExp(String.raw`^import\s+'(${FS_SPEC})'`, 'gm'))) found.push(`import '${m[1]}'`);
      for (const m of text.matchAll(new RegExp(String.raw`\b(require|import)\(\s*'(${FS_SPEC})'\s*\)`, 'g'))) found.push(`${m[1]}('${m[2]}')`);
      for (const m of text.matchAll(/\b(\w+Sync|createWriteStream|createReadStream)\s*\(/g)) found.push(`${m[1]}(`);
      for (const m of text.matchAll(/\bfsp\.(\w+)\s*\(/g)) {
        if (!WRAPPED.includes(m[1]!) && !READ_ONLY.includes(m[1]!)) found.push(`fsp.${m[1]}(`);
      }
      const allowed = OUTSIDE_FSP_ALLOWED[file];
      const rest = found.filter((f) => {
        if (allowed && f === allowed.finding) {
          allowedHits.add(file);
          return false;
        }
        return true;
      });
      if (rest.length > 0) escapes.push(`${file}: ${rest.join(', ')}`);
    }
    expect(escapes).toEqual([]);
    // Every allowance is still needed, and says why.
    for (const [file, entry] of Object.entries(OUTSIDE_FSP_ALLOWED)) {
      expect(entry.why.length, file).toBeGreaterThan(20);
      expect(allowedHits.has(file), `${file} no longer needs its allowance`).toBe(true);
    }
  });
});
