/**
 * State machine + async orchestration for the install command.
 *
 * Owns every side-effecting transition (resolve, download, parse,
 * collision detection, backup, render, rollback, hook invocation)
 * behind a hook interface so commands/install.tsx stays thin
 * presentation. The update command (Milestone 4) is expected to
 * reuse the same machine with a few added phase variants.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { useApp, useStdin } from 'ink';
import { loadValuesYaml } from '../../core/values-io.js';

import type {
  ShardManifest,
  ShardSchema,
  ShardState,
  ResolvedShard,
} from '../../runtime/types.js';
import { ShardMindError } from '../../runtime/types.js';

import { resolve as resolveRef } from '../../core/registry.js';
import { downloadShard, DownloadCancelledError } from '../../core/download.js';
import { parseManifest, assertEngineCompatible } from '../../core/manifest.js';
import { resolveEngineVersion } from './cli-version.js';
import { useVaultLock } from './use-vault-lock.js';
import { assertShardInstallable } from '../../core/lint-shard.js';
import { checkExternalToolsForRun } from '../../core/external-tools.js';
import { parseSchema, buildValuesValidator } from '../../core/schema.js';
import { readState } from '../../core/state.js';
import {
  planOutputs,
  detectCollisions,
  mergePrefill,
  resolveComputedDefaults,
  missingValueKeys,
  defaultModuleSelections,
  splitByOwnContent,
  staleOutputs,
  detectStale,
  stillFiles,
  type Collision,
} from '../../core/install-planner.js';
import { installRolledBack, runInstallTransaction, type BackupRecord } from '../../core/install-executor.js';
import type { InstallDestination } from '../../core/install-destination.js';
import { assertSafeVaultPaths } from '../../core/vault-path-guard.js';
import { toPosix } from '../../core/fs-utils.js';
import { type RunningHookPhase } from '../../core/hook.js';
import { runHooks, type HookOutcome } from '../../core/hook-orchestrator.js';
import { rollbackDetail } from '../../core/rollback-report.js';
import { SHARDMIND_DIR, VALUES_FILE } from '../../runtime/vault-paths.js';
import {
  appendHookOutput,
  useSigintRollback,
  isCancelledRun,
  newRunAbort,
  stopRun,
  trackRun,
  type RunInFlight,
} from './shared.js';

import type { WizardResult } from '../../components/InstallWizard.js';
import type { CollisionAction } from '../../components/CollisionReview.js';
import type { GateChoice } from '../../components/ExistingInstallGate.js';

export interface PreparedContext {
  resolved: ResolvedShard;
  manifest: ShardManifest;
  schema: ShardSchema;
  tempDir: string;
  tarballSha256: string;
  cleanup: () => Promise<void>;
  prefillValues: Record<string, unknown>;
  moduleFileCounts: Record<string, number>;
  alwaysIncludedFileCount: number;
  /**
   * The install a reinstall replaces (gate Reinstall or `--force`, #55).
   * Its state and values are set aside with the collisions, and its
   * recorded hashes tell its untouched files from the user's own content.
   */
  previous?: ShardState;
}

export type Phase =
  | { kind: 'booting' }
  | { kind: 'loading'; message: string }
  | { kind: 'gate'; state: ShardState; ctx: PreparedContext }
  | { kind: 'wizard'; ctx: PreparedContext }
  | { kind: 'collision'; collisions: Collision[]; untouched: Collision[]; stale: StaleFiles; result: WizardResult; ctx: PreparedContext }
  | { kind: 'installing'; total: number; current: number; label: string; history: string[]; ctx: PreparedContext; result: WizardResult }
  | RunningHookPhase // a lifecycle hook (bootstrap / personalize / legacy
      // post-install) is streaming output. We are already past the
      // point-of-no-return (state.json written); a Ctrl+C here kills the child
      // but does NOT roll the install back. See docs/ARCHITECTURE.md §9.3 for
      // the Helm-style contract. Shape shared with update via core/hook.ts so
      // `appendHookOutput` narrows generically.
  | { kind: 'summary'; manifest: ShardManifest; vaultRoot: string; folder: string | null; fileCount: number; durationMs: number; backups: BackupRecord[]; replaced: string[]; removed: string[]; keptStale: string[]; hooks: HookOutcome[]; dryRun: boolean; externalTools: string[] }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'error'; error: ShardMindError | Error; detail?: string };

/** Where an install's collisions went before it wrote (#55). */
interface PlacedCollisions {
  /** What the transaction moves out of the way, in order (#300). */
  moveAside: Collision[];
  /** The moves kept as `<path>.shardmind-backup-<timestamp>` and reported; the rest is set aside. */
  keep: ReadonlySet<string>;
  /** A reinstall's old `.shardmind/`, set aside with the rest. */
  oldStatePath: string | undefined;
  /** Replaced with no backup and holding the user's own content; reported. */
  replaced: string[];
  /** Files the previous install wrote and this one no longer plans, untouched: removed (#228). */
  removed: string[];
  /** The same, edited by the user: kept where they are, no longer tracked (#228). */
  keptStale: string[];
}

/**
 * The previous install's files a reinstall no longer plans, split by
 * whether the user edited them (#228). Never prompted for, backed up or
 * overwritten: there is no shard version of them.
 */
type StaleFiles = Awaited<ReturnType<typeof splitByOwnContent>>;

export interface UseInstallMachineInput {
  shardRef: string;
  valuesFile: string | undefined;
  yes: boolean;
  /**
   * `--defaults` — Invariant 1 mode. Mutually exclusive with `--values`;
   * refuses to overwrite an existing install. Implies `--yes` semantics
   * internally.
   */
  defaults: boolean;
  /**
   * `--force` (#55) — answer both destructive prompts: reinstall over an
   * existing install without the gate, and overwrite colliding files
   * without a backup. Answers nothing else; values come as usual.
   */
  force: boolean;
  verbose: boolean;
  dryRun: boolean;
  /** Where the vault goes (#333), decided before the run (`install-destination.ts`). */
  destination: InstallDestination;
}

export interface UseInstallMachineOutput {
  phase: Phase;
  onGateChoice: (choice: GateChoice) => void;
  onWizardComplete: (result: WizardResult) => void;
  onWizardCancel: () => void;
  onWizardError: (err: Error) => void;
  onCollisionChoice: (action: CollisionAction) => void;
}

export function useInstallMachine(input: UseInstallMachineInput): UseInstallMachineOutput {
  const { shardRef, valuesFile, yes, defaults, force, verbose, dryRun, destination } = input;
  const vaultRoot = destination.root;
  // A folder this run makes is locked by its transaction, from the moment it
  // exists (§4.28 step 1a); there is none to lock while the run plans.
  const creating = destination.create.length > 0;
  const { exit } = useApp();

  // `--defaults` implies `--yes` semantics internally (single non-interactive
  // path through `runNonInteractive`). Computed once so the boot effect and
  // gate handler agree on which mode is active.
  const nonInteractive = yes || defaults;

  // Whether an interactive phase (wizard, existing-install gate) can run at
  // all. Read from Ink's own stdin rather than `process.stdin` so it reflects
  // the stream Ink will actually attach to — the injected stub under
  // ink-testing-library, the real handle in production.
  //
  // Without this gate, a non-TTY invocation renders the wizard and Ink throws
  // "Raw mode is not supported". That throw happens inside Ink's render tree,
  // not this machine, so it never reaches `finish({ kind: 'error' })` — the
  // process writes a stack trace, installs NOTHING, and **exits 0**. Any
  // caller branching on `$?` reads a total failure as success (#139).
  const { isRawModeSupported } = useStdin();

  const [phase, setPhase] = useState<Phase>({ kind: 'booting' });

  // The external-tools check's summary lines (#138).
  const externalToolsRef = useRef<string[]>([]);
  // The install in flight, from the first move aside to the discard after
  // state.json, which a Ctrl+C stops and waits for (#249). Its abort stops
  // the transaction before its next move or write; the transaction's own
  // rollback then runs once (#300).
  const runRef = useRef<RunInFlight | null>(null);
  // AbortController that owns the currently-executing post-install hook.
  // Null when no hook is in flight. Ctrl+C in the running-hook phase
  // aborts the subprocess but does NOT roll back the install (we're
  // already past the point-of-no-return — see the running-hook phase
  // docstring for the Helm-style contract).
  const hookAbortRef = useRef<AbortController | null>(null);
  // Shard tempdir cleanup, populated once the shard download completes.
  // A SIGINT between download and wizard-submit needs to run this.
  const ctxCleanupRef = useRef<(() => Promise<void>) | null>(null);
  // Mutable pointer to the latest handleWizardComplete closure so
  // runNonInteractive can call it without circular useCallback deps.
  const handleWizardCompleteRef = useRef<(r: WizardResult, c: PreparedContext) => Promise<void>>(
    async () => {},
  );

  // One run per vault (#253); --dry-run writes nothing and takes no lock.
  const { take: takeLock, release: releaseLock } = useVaultLock(vaultRoot, 'install', !dryRun);

  const finish = useCallback(
    (next: Phase) => {
      setPhase(next);
      if (next.kind === 'summary' || next.kind === 'cancelled' || next.kind === 'error') {
        // Set the exit code BEFORE scheduling the Ink teardown so the
        // process exits non-zero on error. Success and user-cancel stay
        // at 0 — cancelled is the user's choice, not a failure.
        if (next.kind === 'error') process.exitCode = 1;
        // The run is over: the next one may start (#253).
        releaseLock();
        setTimeout(() => exit(), 100);
      }
    },
    [exit, releaseLock],
  );

  // A Ctrl+C while the install runs stops it and waits for its own
  // rollback (#249, #300). `cleanup` drops the shard tempdir regardless of
  // phase — without it, cancelling at the wizard or collision screens
  // leaks the extracted shard on disk.
  useSigintRollback({
    isActive: () => !dryRun && runRef.current !== null,
    rollback: () => stopRun(runRef.current),
    cleanup: async () => {
      // Abort any in-flight post-install hook subprocess. Intentionally
      // runs on every Ctrl+C, regardless of `isActive` — during the
      // running-hook phase `isActive` is already false (state.json has
      // been written) so the install-rollback path won't fire, and we
      // still need the child to die so the parent process exits.
      hookAbortRef.current?.abort();
      if (ctxCleanupRef.current) await ctxCleanupRef.current();
    },
  });

  useEffect(() => {
    let disposed = false;

    (async () => {
      try {
        // Pre-flight rejections fire before any network call so a
        // misconfigured invocation fails in milliseconds. The state read
        // is shared with the existing-install gate further down — under
        // `--defaults` the throw forecloses the gate, under non-defaults
        // the gate consumes the same value.
        if (defaults && valuesFile !== undefined) {
          throw new ShardMindError(
            '--defaults and --values cannot be combined',
            'INSTALL_FLAG_CONFLICT',
            '--defaults uses schema defaults for every value; --values would override them. Drop one of the two flags.',
          );
        }
        // Before state is read: a plan made from a state another run is
        // changing would be stale (#253).
        if (!creating) takeLock();
        // A folder the install will make holds no state yet (§4.31 step 4).
        const existing = creating ? null : await readState(vaultRoot);
        if (defaults && existing && !force) {
          throw new ShardMindError(
            `Vault already shardmind-managed (${existing.shard}@${existing.version}); --defaults refuses to overwrite`,
            'INSTALL_DEFAULTS_OVER_EXISTING',
            'Run `shardmind update` to upgrade the existing install in place, or add --force to reinstall from scratch.',
          );
        }

        setPhase({ kind: 'loading', message: `Resolving ${shardRef}…` });
        const resolved = await resolveRef(shardRef);

        setPhase({ kind: 'loading', message: `Downloading ${resolved.namespace}/${resolved.name}@${resolved.version}…` });
        // The cleanup is registered before the fetch, so a Ctrl+C during the
        // download removes the temp dir too (#57).
        const temp = await downloadShard(resolved.tarballUrl, (cleanup) => {
          // A superseded run removes its own dir instead of taking the ref.
          if (disposed) void cleanup().catch(() => {});
          else ctxCleanupRef.current = cleanup;
        });

        setPhase({ kind: 'loading', message: 'Parsing manifest and schema…' });
        const manifest = await parseManifest(temp.manifest);
        // Refuse before any vault write if this engine can't satisfy the
        // shard's declared requires.shardmind range (#121).
        assertEngineCompatible(manifest, resolveEngineVersion());
        const schema = await parseSchema(temp.schema);

        const prefill = valuesFile ? await loadValuesFile(valuesFile, schema) : {};
        // A template that cannot render fails here, every one listed, before
        // the user answers anything (#35).
        if (disposed) return;
        setPhase({ kind: 'loading', message: 'Checking the shard…' });
        await assertShardInstallable(temp.tempDir, prefill, vaultRoot);

        const { moduleFileCounts, alwaysIncludedFileCount } = await planOutputs(
          schema,
          temp.tempDir,
          defaultModuleSelections(schema),
        );

        // `prefillValues` carries the *raw* user input from --values (or {}).
        // Both the wizard and the non-interactive path merge schema defaults
        // in themselves (`mergePrefill`). Threading raw user input lets the
        // wizard distinguish user-supplied vs default-supplied values, which
        // matters under v6 where every value has a default.
        const ctx: PreparedContext = {
          resolved,
          manifest,
          schema,
          tempDir: temp.tempDir,
          tarballSha256: temp.tarball_sha256,
          cleanup: temp.cleanup,
          prefillValues: prefill,
          moduleFileCounts,
          alwaysIncludedFileCount,
        };

        if (disposed) return;
        if (existing) {
          if (force) {
            await collectAnswers({ ...ctx, previous: existing });
            return;
          }
          // The gate is a prompt, and `--yes` does not answer it — overwriting
          // an existing managed vault is not a default anyone should inherit.
          // Refuse loudly instead of rendering a prompt nobody can answer.
          if (!isRawModeSupported) {
            throw new ShardMindError(
              `Vault already shardmind-managed (${existing.shard}@${existing.version}); cannot prompt for a choice without an interactive terminal`,
              'INSTALL_GATE_NON_INTERACTIVE',
              'Run `shardmind update` to upgrade in place, or add --force to reinstall from scratch.',
            );
          }
          setPhase({ kind: 'gate', state: existing, ctx });
          return;
        }
        await collectAnswers(ctx);
      } catch (err) {
        // A Ctrl+C mid-download stops the fetch; the command is exiting, so
        // that is not an error to render.
        if (disposed || err instanceof DownloadCancelledError) return;
        finish({ kind: 'error', error: err as Error });
      }
    })();

    return () => {
      disposed = true;
      if (ctxCleanupRef.current) {
        ctxCleanupRef.current().catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shardRef, valuesFile, yes, defaults, force, isRawModeSupported]);

  const runNonInteractive = useCallback(
    async (ctx: PreparedContext) => {
      const merged = mergePrefill(ctx.schema, ctx.prefillValues);
      const missing = missingValueKeys(ctx.schema, merged);
      if (missing.length > 0) {
        // The hint has to match how we got here. This path is reachable two
        // ways now: `--yes` (defaults accepted, a required value has no
        // usable default) and a headless `--values` run. Telling the latter
        // to "drop --yes" is advice it cannot follow.
        throw new ShardMindError(
          `Missing required values: ${missing.join(', ')}`,
          'VALUES_MISSING',
          yes
            ? 'Provide them via --values <file> or drop --yes to prompt interactively.'
            : 'Add them to your --values file, or run in an interactive terminal to be prompted.',
        );
      }
      const validator = buildValuesValidator(ctx.schema);
      const validated = validator.parse(
        resolveComputedDefaults(ctx.schema, merged),
      ) as Record<string, unknown>;
      await handleWizardCompleteRef.current(
        { values: validated, selections: defaultModuleSelections(ctx.schema) },
        ctx,
      );
    },
    [yes],
  );

  /**
   * Get the install's answers: without a wizard when the flags or a
   * headless `--values` run supply them, else from the wizard. Shared by a
   * fresh install and a reinstall, so `--force` without a terminal follows
   * the same rules as any install (#55). A reinstall carries the old state
   * on `ctx.previous` and removes nothing here: the old install is set
   * aside only once the answers are in (`placeCollisions`), so a cancelled
   * wizard or a bad `--values` file leaves it as it was.
   */
  const collectAnswers = useCallback(
    async (ctx: PreparedContext) => {
      if (nonInteractive) {
        await runNonInteractive(ctx);
      } else if (!isRawModeSupported) {
        // `--values` is a *prefill* for the wizard, not a skip — which is
        // right with a terminal and impossible without one. When every
        // answer is already on disk there is nothing left to prompt for, so
        // take the non-interactive path rather than failing on a wizard the
        // caller never needed.
        if (valuesFile !== undefined) {
          await runNonInteractive(ctx);
        } else {
          // No terminal and no answers. Refusing beats installing schema
          // defaults nobody chose: a silently-defaulted vault records
          // `user_name: ""` as if the user had picked it (#139).
          throw new ShardMindError(
            'No interactive terminal, and no values were supplied',
            'INSTALL_NON_INTERACTIVE_WITHOUT_VALUES',
            'Pass --values <file> to supply answers, or --yes / --defaults to accept schema defaults deliberately.',
          );
        }
      } else {
        setPhase({ kind: 'wizard', ctx });
      }
    },
    [nonInteractive, isRawModeSupported, valuesFile, runNonInteractive],
  );

  /**
   * Run the install transaction (#300): the executor moves the collisions
   * aside, writes the vault and, until state.json is written, rolls itself
   * back on a failure or a Ctrl+C, as update's and adopt's do. The machine
   * tracks the run for the Ctrl+C handler and renders.
   */
  const executeInstall = useCallback(
    async (ctx: PreparedContext, result: WizardResult, placed: PlacedCollisions) => {
      const { moveAside, keep, oldStatePath, replaced, removed, keptStale } = placed;
      const start = Date.now();
      const history: string[] = [];

      setPhase({
        kind: 'installing',
        total: 0,
        current: 0,
        label: 'Preparing…',
        history,
        ctx,
        result,
      });

      try {
        const abort = newRunAbort();
        const run = runInstallTransaction({
          vaultRoot,
          manifest: ctx.manifest,
          schema: ctx.schema,
          tempDir: ctx.tempDir,
          resolved: ctx.resolved,
          tarballSha256: ctx.tarballSha256,
          values: result.values,
          selections: result.selections,
          dryRun,
          signal: abort.signal,
          moveAside,
          keep,
          oldStatePath,
          createRoot: creating
            ? {
                folders: destination.create,
                lock: () => {
                  takeLock();
                  return { release: releaseLock };
                },
              }
            : undefined,
          onProgress: (ev) => {
            if (ev.kind === 'start') {
              setPhase((prev) =>
                prev.kind === 'installing' && (prev.total !== ev.total || prev.current !== 0)
                  ? { ...prev, total: ev.total, current: 0, label: 'Starting…' }
                  : prev,
              );
            } else if (ev.kind === 'file') {
              if (verbose) {
                history.push(ev.outputPath);
                if (history.length > 5) history.shift();
              }
              setPhase((prev) => {
                if (prev.kind !== 'installing') return prev;
                if (prev.current === ev.index && prev.label === ev.label) return prev;
                return {
                  ...prev,
                  current: ev.index,
                  total: ev.total,
                  label: ev.label,
                  history: verbose ? [...history] : prev.history,
                };
              });
            }
          },
        });
        runRef.current = trackRun(abort, run);
        const runResult = await run;

        // State.json is on disk and the set-aside discarded: past the
        // point-of-no-return. Drop the run BEFORE firing the hook so a
        // SIGINT during hook execution can't walk the install back. The
        // only remaining work (hook subprocess) is non-fatal per spec §9.3.
        runRef.current = null;

        // A stale file whose set-aside copy could not be deleted is still in
        // the vault under its backup name: listed as such, never as removed.
        const leftPaths = new Set(runResult.left.map((r) => toPosix(vaultRoot, r.originalPath)));
        const removedNow = removed.filter((rel) => !leftPaths.has(rel));
        const leftBackups = runResult.left.filter((r) => r.originalPath !== oldStatePath);

        // The hook orchestrator owns slot selection (bootstrap → personalize,
        // legacy post-install once), per-slot context, write-boundary checks,
        // the post-hook re-hash, and fingerprint persistence. A fresh
        // AbortController per run is cleared in a finally so repeat installs
        // (test harness) start clean. In dry-run the orchestrator reports
        // deferred outcomes without spawning anything (and without setPhase).
        hookAbortRef.current = new AbortController();
        let hookOutcomes: HookOutcome[];
        try {
          const hookRun = await runHooks(
            {
              command: 'install',
              tempDir: ctx.tempDir,
              manifest: ctx.manifest,
              schema: ctx.schema,
              vaultRoot,
              state: runResult.state,
              values: result.values,
              modules: result.selections,
              newFiles: [],
              // A reinstall removes the files the shard no longer has (#228).
              removedFiles: dryRun ? [] : removedNow,
              dryRun: Boolean(dryRun),
            },
            {
              setPhase: (p) => setPhase(p),
              onStdout: (chunk) => appendHookOutput(setPhase, chunk),
              onStderr: (chunk) => appendHookOutput(setPhase, chunk),
              signal: hookAbortRef.current.signal,
            },
          );
          hookOutcomes = hookRun.outcomes;
        } finally {
          hookAbortRef.current = null;
        }

        finish({
          kind: 'summary',
          manifest: ctx.manifest,
          vaultRoot,
          folder: destination.folder,
          fileCount: runResult.fileCount,
          durationMs: Date.now() - start,
          backups: [...runResult.backups, ...leftBackups],
          replaced,
          removed: dryRun ? removed : removedNow,
          keptStale,
          hooks: hookOutcomes,
          dryRun: Boolean(dryRun),
          externalTools: externalToolsRef.current,
        });
      } catch (err) {
        runRef.current = null;
        if (isCancelledRun(err)) {
          // The Ctrl+C handler reports any rollback failure and exits 130.
          finish({ kind: 'cancelled', reason: 'Cancelled with Ctrl+C.' });
          return;
        }
        finish({
          kind: 'error',
          error: err as Error,
          // Only when the transaction rolled back: a failure after
          // state.json rolls nothing back.
          detail: installRolledBack(err)
            ? rollbackDetail(err, 'Rolled back partial install (including any pre-install backups).')
            : undefined,
        });
      }
    },
    [vaultRoot, verbose, dryRun, finish, destination, creating, takeLock, releaseLock],
  );

  /**
   * Decide what moves out of the way, then install. `own` holds the user's
   * content: `backup` keeps it as `<path>.shardmind-backup-<timestamp>`;
   * `overwrite` (the Overwrite choice, or `--force`, #55) sets it aside,
   * restores it if the install fails, and deletes it once the new state is
   * written. A reinstall's old `.shardmind/`, `shard-values.yaml` and
   * untouched files are always set aside that way. A directory at a planned
   * file path moves too, so `writeFile` doesn't hit EISDIR; a symlink
   * moves, not its target. The moves themselves, and putting them back,
   * are the transaction's (#300). A dry run moves nothing.
   */
  const placeCollisions = useCallback(
    async (
      ctx: PreparedContext,
      result: WizardResult,
      own: Collision[],
      untouched: Collision[],
      policy: 'backup' | 'overwrite',
      stale: StaleFiles,
    ) => {
      // Classified before a prompt that may have stayed open: a file edited
      // since is the user's now, so check the untouched ones again.
      const recheck = await splitByOwnContent(untouched, ctx.previous ?? null);
      const ownNow = [...own, ...recheck.own];
      const replaced = policy === 'overwrite' ? ownNow.map((c) => c.outputPath) : [];
      // A stale file edited during the prompts is the user's now: kept (#228).
      const staleNow = await splitByOwnContent(stale.untouched, ctx.previous ?? null);
      const removed = staleNow.untouched.map((c) => c.outputPath);
      // Only files still there are reported as kept: a folder at the path,
      // or a file deleted meanwhile, is not one the user edited.
      const keptStale = await stillFiles(vaultRoot, [...stale.own, ...staleNow.own]);
      const oldInstall = ctx.previous ? await detectCollisions(vaultRoot, [SHARDMIND_DIR, VALUES_FILE]) : [];
      // A dry run moves nothing: the transaction skips the moves itself.
      await executeInstall(ctx, result, {
        moveAside: [...oldInstall, ...recheck.untouched, ...staleNow.untouched, ...ownNow],
        keep: new Set(policy === 'backup' ? ownNow.map((c) => c.absolutePath) : []),
        oldStatePath: oldInstall.find((c) => c.outputPath === SHARDMIND_DIR)?.absolutePath,
        replaced,
        removed,
        keptStale,
      });
    },
    [dryRun, vaultRoot, executeInstall],
  );

  const handleWizardComplete = useCallback(
    async (result: WizardResult, ctx: PreparedContext) => {
      try {
        const validator = buildValuesValidator(ctx.schema);
        const validated = validator.parse(result.values) as Record<string, unknown>;
        const validatedResult: WizardResult = { values: validated, selections: result.selections };
        // With the values final, before any prompt or move (#138).
        externalToolsRef.current = await checkExternalToolsForRun({ manifest: ctx.manifest, values: validated, dryRun: Boolean(dryRun) });

        // With the values, an `_each` template is planned under the paths it
        // expands to, so a user file at one is a collision like any other (#214).
        const { outputs } = await planOutputs(ctx.schema, ctx.tempDir, validatedResult.selections, validated);
        // Refuse before any prompt or move, as update and adopt do, so a dry
        // run and the run agree (#163). `runInstall` checks again at write
        // time, for a caller that plans without values.
        // A reinstall also removes the files the shard no longer has (#228):
        // those go through the guard as deletes, as an update's do.
        const plannedPaths = outputs.map((o) => o.outputPath);
        const stalePaths = staleOutputs(ctx.previous ?? null, plannedPaths);
        await assertSafeVaultPaths(vaultRoot, plannedPaths, stalePaths);
        const collisions = await detectCollisions(vaultRoot, plannedPaths);

        // Only the user's own content is prompted for, backed up or
        // reported; a reinstall's untouched files are simply replaced.
        const { own, untouched } = await splitByOwnContent(collisions, ctx.previous ?? null);
        // What the previous install wrote and this one no longer plans: an
        // untouched one is removed, an edited one kept as the user's (#228).
        const stale = await splitByOwnContent(await detectStale(vaultRoot, stalePaths), ctx.previous ?? null);
        if (own.length > 0 && force) {
          await placeCollisions(ctx, validatedResult, own, untouched, 'overwrite', stale);
        } else if (own.length > 0 && !nonInteractive) {
          setPhase({ kind: 'collision', collisions: own, untouched, stale, result: validatedResult, ctx });
        } else {
          // Non-interactive policy: auto-backup. Applies to both `--yes` and
          // `--defaults`; the collision UI requires interactive input neither
          // mode can provide. With nothing of the user's in the way this only
          // sets a reinstall's old install aside.
          await placeCollisions(ctx, validatedResult, own, untouched, 'backup', stale);
        }
      } catch (err) {
        finish({ kind: 'error', error: err as Error });
      }
    },
    [force, nonInteractive, vaultRoot, placeCollisions, finish],
  );

  useEffect(() => {
    handleWizardCompleteRef.current = handleWizardComplete;
  }, [handleWizardComplete]);

  const onCollisionChoice = useCallback(
    async (action: CollisionAction) => {
      if (phase.kind !== 'collision') return;
      const { collisions, untouched, stale, result, ctx } = phase;
      if (action === 'cancel') {
        finish({ kind: 'cancelled', reason: 'User cancelled at collision review.' });
        return;
      }

      try {
        await placeCollisions(ctx, result, collisions, untouched, action, stale);
      } catch (err) {
        finish({ kind: 'error', error: err as Error });
      }
    },
    [phase, finish, placeCollisions],
  );

  const onGateChoice = useCallback(
    (choice: GateChoice) => {
      if (phase.kind !== 'gate') return;
      if (choice === 'cancel') {
        finish({ kind: 'cancelled', reason: 'User cancelled at existing-install gate.' });
        return;
      }
      if (choice === 'update') {
        finish({
          kind: 'cancelled',
          reason: 'Existing install preserved. Run `shardmind update` to pick up a newer version, or re-run `install` and pick Reinstall for a fresh start.',
        });
        return;
      }
      if (choice === 'reinstall') {
        collectAnswers({ ...phase.ctx, previous: phase.state }).catch((err: unknown) => {
          finish({ kind: 'error', error: err as Error });
        });
      }
    },
    [phase, finish, collectAnswers],
  );

  const onWizardComplete = useCallback(
    (result: WizardResult) => {
      if (phase.kind !== 'wizard') return;
      void handleWizardComplete(result, phase.ctx);
    },
    [phase, handleWizardComplete],
  );

  const onWizardCancel = useCallback(
    () => finish({ kind: 'cancelled', reason: 'User cancelled in wizard.' }),
    [finish],
  );

  const onWizardError = useCallback(
    (err: Error) => finish({ kind: 'error', error: err }),
    [finish],
  );

  return {
    phase,
    onGateChoice,
    onWizardComplete,
    onWizardCancel,
    onWizardError,
    onCollisionChoice,
  };
}

async function loadValuesFile(
  filePath: string,
  schema: ShardSchema,
): Promise<Record<string, unknown>> {
  return loadValuesYaml(filePath, {
    label: '--values file',
    schemaFilter: schema,
    errors: { readFailed: 'VALUES_FILE_READ_FAILED', invalid: 'VALUES_FILE_INVALID' },
  });
}

