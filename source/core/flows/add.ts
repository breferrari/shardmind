/**
 * `shardmind add <shard>` as a UI-free flow (#396). Spec:
 * docs/IMPLEMENTATION.md §4.30 step 10; ARCHITECTURE §10.4a; SHARD-LAYOUT
 * §Overlay shards.
 *
 * An overlay shard goes into a ShardMind vault beside the shard installed
 * there: install's resolve, check and values, refused before any prompt or
 * write when it would write a path another shard (or the engine) owns, then
 * written on the vault's `add` transaction, with its own hooks.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ModuleSelections, VaultState } from '../../runtime/types.js';
import { ShardMindError } from '../../runtime/types.js';
import { SHARDMIND_DIR, STATE_FILE, VALUES_FILE, overlayDir, overlayValuesFile } from '../../runtime/vault-paths.js';
import { errnoCode } from '../../runtime/errno.js';
import { resolve as resolveRef } from '../registry.js';
import { readVaultState, writeShardEntry } from '../state.js';
import { assertShardInstallable } from '../lint-shard.js';
import { checkExternalToolsForRun } from '../external-tools.js';
import { assertSafeVaultPaths } from '../vault-path-guard.js';
import { foldOutputPath, pathExists } from '../fs-utils.js';
import { planOutputs, detectCollisions, defaultModuleSelections, type Collision } from '../install-planner.js';
import { runAddTransaction, type BackupRecord, type ProgressEvent } from '../install-executor.js';
import type { HookOutcome } from '../hook-orchestrator.js';
import { prepareShard, type PreparedShard } from './prepare-shard.js';
import { answersFor, loadValuesFile, type ValueAnswers } from './values.js';
import { FlowCancelled } from './cancelled.js';
import { runAndHooks, type FlowRunIO } from './run.js';

export interface AddFlowInput {
  shardRef: string;
  valuesFile: string | undefined;
  yes: boolean;
  /** Schema defaults, no wizard; refused with `--values`. */
  defaults: boolean;
  dryRun: boolean;
  /** `--skip-hooks` (#199): run no hook; the overlay's bootstrap is owed in its own entry. */
  skipHooks: boolean;
  /** A terminal to prompt on: without one, the flow never asks. */
  interactive: boolean;
  /** The vault, found before the run (`findVault`), so the lock can be taken on it. */
  vaultRoot: string;
  engineVersion: string | undefined;
  /** Aborted when an Ink run is superseded by a newer one. */
  stop?: AbortSignal;
}

/** The overlay as the add's questions show it. */
export interface AddShard extends PreparedShard {
  /** The raw `--values` input (or {}): the wizard tells the user's answers from the defaults. */
  prefillValues: Record<string, unknown>;
  moduleFileCounts: Record<string, number>;
  alwaysIncludedFileCount: number;
  /** The vault's base shard, `<namespace>/<name>`. */
  base: string;
}

export type AddQuestion =
  | { kind: 'values'; shard: AddShard }
  | { kind: 'collision'; collisions: Collision[]; shard: AddShard };

export type AddAnswer<Q extends AddQuestion> = Q extends { kind: 'values' } ? ValueAnswers : 'backup' | 'overwrite' | 'cancel';

export type AddFlowPhase = { kind: 'loading'; message: string } | { kind: 'installing' };

export interface AddFlowIO extends FlowRunIO {
  ask<Q extends AddQuestion>(question: Q): Promise<AddAnswer<Q>>;
  phase(phase: AddFlowPhase): void;
  progress(event: ProgressEvent): void;
}

export interface AddFlowResult {
  kind: 'done';
  manifest: PreparedShard['manifest'];
  vaultRoot: string;
  /** The vault's base shard, `<namespace>/<name>`. */
  base: string;
  fileCount: number;
  durationMs: number;
  backups: BackupRecord[];
  /** The user's files replaced without a backup (Overwrite). */
  replaced: string[];
  hooks: HookOutcome[];
  dryRun: boolean;
  externalTools: string[];
}

/** `--defaults` with `--values` is `ADD_FLAG_CONFLICT`: checked first, before the vault is looked for. */
export function assertAddFlags(input: Pick<AddFlowInput, 'defaults' | 'valuesFile'>): void {
  if (input.defaults && input.valuesFile !== undefined) {
    throw new ShardMindError(
      '--defaults and --values cannot be combined',
      'ADD_FLAG_CONFLICT',
      "--defaults uses the shard's schema defaults for every value; --values would override them. Drop one of the two flags.",
    );
  }
}

export async function runAddFlow(input: AddFlowInput, io: AddFlowIO): Promise<AddFlowResult> {
  // Before any network call, so a misconfigured invocation fails at once.
  assertAddFlags(input);
  const { vaultRoot } = input;
  // Before state is read: a plan made from a state another run is changing
  // would be stale (#253). --dry-run writes nothing and takes no lock.
  if (!input.dryRun) io.lock();
  const vault = await readVaultState(vaultRoot);
  if (!vault) throw noInstall(vaultRoot);

  let prepared: PreparedShard | undefined;
  try {
    prepared = await prepareShard(input.shardRef, {
      resolve: (ref) => resolveRef(ref, { command: 'add' }),
      engineVersion: input.engineVersion,
      onLoading: (message) => io.phase({ kind: 'loading', message }),
      onCleanup: io.onCleanup,
    });
    if (input.stop?.aborted) throw new FlowCancelled('Superseded by a newer run.');
    const name = `${prepared.manifest.namespace}/${prepared.manifest.name}`;
    const base = vault.shards[0]!.shard;
    if (vault.shards.some((s) => s.shard === name)) {
      throw new ShardMindError(
        `This vault already holds ${name}${name === base ? ', as its base shard' : ''}`,
        'ADD_SHARD_PRESENT',
        'A vault holds each shard once. To move it to a newer version, run `shardmind update`.',
      );
    }
    // The overlay's own engine paths, left by a hand edit or an earlier run
    // the vault no longer records: refused before any prompt, rather than
    // after the wizard by the transaction's exclusive writes.
    const leftover = [];
    for (const rel of [overlayValuesFile(name), overlayDir(name)]) {
      if (await pathExists(path.join(vaultRoot, rel))) leftover.push(rel.replaceAll('\\', '/'));
    }
    if (leftover.length > 0) {
      throw new ShardMindError(
        `${name} would write ${leftover.join(' and ')}, which ${leftover.length === 1 ? 'is' : 'are'} already in the vault though state.json lists no ${name}`,
        'ADD_PATH_OWNED',
        `Left by an earlier run, or put there by hand. Remove ${leftover.length === 1 ? 'it' : 'them'}, then run \`shardmind add\` again.`,
      );
    }
    // A path the overlay writes whatever is answered, already owned: refused
    // before any prompt (R2). The full set is checked once answered.
    const owned = ownedPaths(vault, name);
    assertNoOwnedPaths(owned, await pathsWrittenRegardless(prepared), prepared);
    const prefill = input.valuesFile ? await loadValuesFile(input.valuesFile, prepared.schema) : {};
    io.phase({ kind: 'loading', message: 'Checking the shard…' });
    await assertShardInstallable(prepared.tempDir, prefill, vaultRoot);
    const { moduleFileCounts, alwaysIncludedFileCount } = await planOutputs(
      prepared.schema,
      prepared.tempDir,
      defaultModuleSelections(prepared.schema),
    );
    const shard: AddShard = { ...prepared, prefillValues: prefill, moduleFileCounts, alwaysIncludedFileCount, base };
    const answers = await valueAnswers(input, io, shard);
    return await planAndAdd(input, io, vaultRoot, owned, shard, answers);
  } finally {
    await prepared?.cleanup().catch(() => {});
  }
}

/** The nearest folder, from `cwd` up, holding `.shardmind/state.json`; none is `ADD_NO_INSTALL`. */
export async function findVault(cwd: string): Promise<string> {
  for (let at = path.resolve(cwd); ; at = path.dirname(at)) {
    const stat = await fsp.stat(path.join(at, STATE_FILE)).catch((err: unknown) => {
      const code = errnoCode(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw err;
    });
    if (stat?.isFile()) return at;
    if (path.dirname(at) === at) throw noInstall(cwd);
  }
}

function noInstall(cwd: string): ShardMindError {
  return new ShardMindError(
    `No ShardMind vault at ${cwd} or above it`,
    'ADD_NO_INSTALL',
    'Run `shardmind add` inside a vault. To start one, run `shardmind install <shard>`; to bring ShardMind to a clone, `shardmind adopt <shard>`.',
  );
}

/** The answers, as install takes them (`answersFor`), refused without a terminal or values as `ADD_NON_INTERACTIVE_WITHOUT_VALUES`. */
async function valueAnswers(input: AddFlowInput, io: AddFlowIO, shard: AddShard): Promise<ValueAnswers> {
  return answersFor(
    input,
    shard,
    () => io.ask({ kind: 'values', shard }),
    () =>
      new ShardMindError(
        'No interactive terminal, and no values were supplied',
        'ADD_NON_INTERACTIVE_WITHOUT_VALUES',
        'Pass --values <file> to supply answers, or --yes / --defaults to accept the schema defaults deliberately.',
      ),
  );
}

/**
 * Every path an overlay may not write (R2, #396), keyed by its case-folded
 * form, with its owner: each shard's files, every values file (the one
 * `adding` will write included), and each folder holding a shard's files,
 * keyed with a trailing `/` (a file there would move them aside). Anything
 * under `.shardmind/` is the engine's, by prefix, in `ownerOf`.
 */
export function ownedPaths(vault: VaultState, adding: string): Map<string, string> {
  const owned = new Map<string, string>();
  const own = (rel: string, owner: string) => owned.set(foldPath(rel), owner);
  vault.shards.forEach((shard, i) => {
    for (const rel of Object.keys(shard.files)) {
      own(rel, shard.shard);
      const parts = foldPath(rel).split('/');
      for (let depth = 1; depth < parts.length; depth++) {
        const folder = `${parts.slice(0, depth).join('/')}/`;
        if (!owned.has(folder)) owned.set(folder, `${shard.shard} (a folder of its files)`);
      }
    }
    own(i === 0 ? VALUES_FILE : overlayValuesFile(shard.shard), `${shard.shard} (its values file)`);
  });
  // The values file the add itself writes: a shard that ships it would fail
  // the exclusive write after its files, so it is refused up front.
  own(overlayValuesFile(adding), `${adding} (the values file add writes)`);
  return owned;
}

/**
 * `ADD_PATH_OWNED` when any of `paths` is owned (R2, #396), naming every
 * such path with its owner.
 */
function assertNoOwnedPaths(owned: Map<string, string>, paths: readonly string[], shard: PreparedShard): void {
  const taken = paths
    .map((rel) => ({ rel, owner: ownerOf(rel, owned) }))
    .filter((t): t is { rel: string; owner: string } => t.owner !== null);
  if (taken.length === 0) return;
  const name = `${shard.manifest.namespace}/${shard.manifest.name}`;
  throw new ShardMindError(
    `${name} would write ${taken.length === 1 ? 'a path' : `${taken.length} paths`} another shard or ShardMind owns: ${listed(taken.map((t) => `${t.rel} (${t.owner})`))}`,
    'ADD_PATH_OWNED',
    "Each file has one owner. The overlay's author can move these files or exclude them in its .shardmindignore; or leave this shard out of the vault.",
  );
}

/** Up to `OWNED_LISTED` entries, then how many more. */
const OWNED_LISTED = 20;
function listed(items: readonly string[]): string {
  const shown = items.slice(0, OWNED_LISTED).join(', ');
  return items.length > OWNED_LISTED ? `${shown}, and ${items.length - OWNED_LISTED} more` : shown;
}

/**
 * The paths the overlay writes whatever is answered: every module that can
 * be left out left out, no values. Checked before the wizard, so a conflict
 * no answer could avoid is refused before any prompt.
 */
async function pathsWrittenRegardless(shard: PreparedShard): Promise<string[]> {
  const selections: ModuleSelections = {};
  for (const [id, mod] of Object.entries(shard.schema.modules)) selections[id] = mod.removable ? 'excluded' : 'included';
  const { outputs } = await planOutputs(shard.schema, shard.tempDir, selections);
  return outputs.map((o) => o.outputPath);
}

/**
 * Who owns `rel`, if anyone: the engine (`.shardmind/`); a shard, when it
 * manages the path, keeps a folder of files there, or manages a file at a
 * folder above it (the file is in the way); or nobody.
 */
export function ownerOf(rel: string, owned: Map<string, string>): string | null {
  const folded = foldPath(rel);
  if (folded === SHARDMIND_DIR || folded.startsWith(`${SHARDMIND_DIR}/`)) return 'ShardMind (the engine folder)';
  const exact = owned.get(folded) ?? owned.get(`${folded}/`);
  if (exact !== undefined) return exact;
  const parts = folded.split('/');
  for (let depth = 1; depth < parts.length; depth++) {
    const above = owned.get(parts.slice(0, depth).join('/'));
    if (above !== undefined) return `${above} (a file above this path)`;
  }
  return null;
}

/**
 * One spelling per path, as the vault-path guard folds it (`foldOutputPath`:
 * NFC, lower case), with forward slashes.
 */
function foldPath(rel: string): string {
  return foldOutputPath(rel.replaceAll('\\', '/'));
}

async function planAndAdd(
  input: AddFlowInput,
  io: AddFlowIO,
  vaultRoot: string,
  owned: Map<string, string>,
  shard: AddShard,
  answers: ValueAnswers,
): Promise<AddFlowResult> {
  const externalTools = await checkExternalToolsForRun({ manifest: shard.manifest, values: answers.values, dryRun: input.dryRun });
  const { outputs } = await planOutputs(shard.schema, shard.tempDir, answers.selections, answers.values);
  const plannedPaths = outputs.map((o) => o.outputPath);

  // One owner per file (R2), now with the modules and values chosen: refused
  // before any write, dry run included, naming every such path.
  assertNoOwnedPaths(owned, plannedPaths, shard);

  await assertSafeVaultPaths(vaultRoot, plannedPaths);
  // Owned by no shard, so the user's own: install's collision review.
  const userFiles = await detectCollisions(vaultRoot, plannedPaths);
  let policy: 'backup' | 'overwrite' = 'backup';
  if (userFiles.length > 0 && input.interactive && !input.yes && !input.defaults) {
    const action = await io.ask({ kind: 'collision', collisions: userFiles, shard });
    if (action === 'cancel') throw new FlowCancelled('User cancelled at collision review.');
    policy = action;
  }

  const name = `${shard.manifest.namespace}/${shard.manifest.name}`;
  const start = Date.now();
  io.phase({ kind: 'installing' });
  const { result, hooks } = await runAndHooks(
    io,
    (signal) =>
      runAddTransaction({
        vaultRoot,
        manifest: shard.manifest,
        schema: shard.schema,
        tempDir: shard.tempDir,
        resolved: shard.resolved,
        tarballSha256: shard.tarballSha256,
        values: answers.values,
        selections: answers.selections,
        dryRun: input.dryRun,
        signal,
        moveAside: userFiles,
        keep: new Set(policy === 'backup' ? userFiles.map((c) => c.absolutePath) : []),
        onProgress: io.progress,
      }),
    (done) => ({
      // The overlay's own install: install's slots (bootstrap, personalize).
      command: 'install',
      tempDir: shard.tempDir,
      manifest: shard.manifest,
      schema: shard.schema,
      vaultRoot,
      state: done.state,
      values: answers.values,
      modules: answers.selections,
      newFiles: [],
      removedFiles: [],
      dryRun: input.dryRun,
      skipHooks: input.skipHooks,
      // The overlay's entry, written back into shards[] (#396).
      persist: (state) => writeShardEntry(vaultRoot, state),
      logShard: name,
    }),
  );

  return {
    kind: 'done',
    manifest: shard.manifest,
    vaultRoot,
    base: shard.base,
    fileCount: result.fileCount,
    durationMs: Date.now() - start,
    backups: [...result.backups, ...result.left],
    replaced: policy === 'overwrite' ? userFiles.map((c) => c.outputPath) : [],
    hooks,
    dryRun: input.dryRun,
    externalTools,
  };
}
