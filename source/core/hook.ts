/**
 * Post-install / post-update hook lookup + execution.
 *
 * The install and update commands both call into this module after the
 * point-of-no-return (state.json already written). A hook declared in
 * `shard.yaml` under `hooks.post-install` or `hooks.post-update` is:
 *
 *   1. **Located** — `lookupHook` validates the path against the sandbox
 *      (no traversal out of the shard's temp directory).
 *   2. **Executed** — `executeHook` spawns a subprocess that loads the
 *      TypeScript hook via the bundled `tsx` ESM loader, hands it a typed
 *      `HookContext`, and captures stdout + stderr separately.
 *
 * Hooks are non-fatal (Helm semantics): a throw / timeout / cancel never
 * rolls back the install or update. It surfaces as a yellow warning in
 * the summary with the captured output and the exit code or reason.
 *
 * Execution is decoupled from lookup. When `runPostInstallHook` /
 * `runPostUpdateHook` are called without a `ctx`, they return `deferred`
 * and the caller renders "skipped" — the shape used for `--dry-run`.
 *
 * See:
 *   - docs/ARCHITECTURE.md §9.3 — hook contract.
 *   - docs/IMPLEMENTATION.md §4.14a — execution algorithm.
 *   - source/internal/hook-runner.ts — subprocess entry point.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { unlinkSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HookContext, ShardManifest } from '../runtime/types.js';
import { DEFAULT_HOOK_TIMEOUT_MS } from './manifest.js';
import { pathExists } from './fs-utils.js';

/**
 * Maximum captured bytes per stream (stdout / stderr). A pathological hook
 * that writes megabytes of output could otherwise pin Ink's render buffer
 * and wedge the terminal. Picked to match common `execFile`-style caps.
 * Documented in docs/AUTHORING.md §6.
 */
const STREAM_CAP_BYTES = 256 * 1024;

/**
 * Grace period between the first termination signal (SIGTERM / Windows
 * TerminateProcess via `child.kill()`) and the hard SIGKILL when a hook
 * times out or the parent aborts. Gives the hook a chance to flush
 * buffered stdout; most platforms surface the buffered bytes before the
 * process exits.
 */
const KILL_GRACE_MS = 2_000;

export type HookResult =
  | { kind: 'absent' }
  | { kind: 'deferred'; hookPath: string }
  | { kind: 'ran'; stdout: string; stderr: string; exitCode: number }
  | { kind: 'failed'; message: string; stdout: string; stderr: string };

/**
 * Options forwarded from the command machine down into `executeHook`.
 *
 * `onStdout` / `onStderr` fire on every chunk the child emits, so the
 * install / update UI can render streaming output during the
 * `running-hook` phase. The same chunks are accumulated into the final
 * `HookResult` — the callbacks are strictly additive.
 *
 * `signal` ties the spawn to an `AbortController`. The command machine
 * aborts on unmount (Ctrl+C, React tear-down). An aborted hook surfaces
 * as `{ kind: 'failed', message: 'cancelled' }` and the install / update
 * flow still reports success (we're already past the point-of-no-return).
 */
export interface HookExecOpts {
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
}

/**
 * Locate and (when `ctx` is provided) execute the post-install hook
 * declared by the shard manifest. Returns a `HookResult` the command
 * layer can surface. Without `ctx`, execution is suppressed and the
 * result is `deferred` — the shape used for `--dry-run` where we want
 * to report that a hook exists but not fire it.
 */
export async function runPostInstallHook(
  tempDir: string,
  manifest: ShardManifest,
  ctx?: HookContext,
  opts?: HookExecOpts,
): Promise<HookResult> {
  const lookup = await lookupHook(tempDir, manifest.hooks?.['post-install']);
  if (lookup.kind !== 'deferred' || ctx === undefined) return lookup;
  const timeoutMs = manifest.hooks?.timeout_ms ?? DEFAULT_HOOK_TIMEOUT_MS;
  return executeHook(lookup.hookPath, ctx, { timeoutMs, ...opts });
}

/**
 * Post-update sibling of `runPostInstallHook`. Same contract and sandbox
 * invariants; `ctx.previousVersion` carries the pre-update shard version.
 */
export async function runPostUpdateHook(
  tempDir: string,
  manifest: ShardManifest,
  ctx?: HookContext,
  opts?: HookExecOpts,
): Promise<HookResult> {
  const lookup = await lookupHook(tempDir, manifest.hooks?.['post-update']);
  if (lookup.kind !== 'deferred' || ctx === undefined) return lookup;
  const timeoutMs = manifest.hooks?.timeout_ms ?? DEFAULT_HOOK_TIMEOUT_MS;
  return executeHook(lookup.hookPath, ctx, { timeoutMs, ...opts });
}

/**
 * Resolve `hookRelPath` inside `tempDir` and verify it stays within.
 * Rejects absolute paths and any path that normalizes to a location
 * outside the shard's extracted directory (e.g. `../../etc/shadow`).
 * A shard that declares a traversing hook path is treated as if the
 * hook is absent — the engine does not probe filesystem paths outside
 * the shard, even for existence detection.
 */
async function lookupHook(tempDir: string, hookRelPath: string | undefined): Promise<HookResult> {
  if (!hookRelPath) return { kind: 'absent' };
  const normalized = path.normalize(hookRelPath);
  if (
    path.isAbsolute(normalized) ||
    normalized.startsWith('..') ||
    normalized.split(/[\\/]/).includes('..')
  ) {
    return { kind: 'absent' };
  }
  const hookPath = path.resolve(tempDir, normalized);
  const resolvedRoot = path.resolve(tempDir);
  if (!hookPath.startsWith(resolvedRoot + path.sep) && hookPath !== resolvedRoot) {
    return { kind: 'absent' };
  }
  if (!(await pathExists(hookPath))) return { kind: 'absent' };
  return { kind: 'deferred', hookPath };
}

/**
 * Spawn the bundled hook-runner in a subprocess, feed it the serialized
 * `HookContext`, and capture stdout + stderr. Returns a `HookResult`
 * that `summarizeHook` maps into `HookSummary` for the UI.
 *
 * Never throws — every failure mode (tsx missing, spawn error, timeout,
 * abort, non-zero exit, throw inside the hook) maps to `kind: 'ran'`
 * (process started) or `kind: 'failed'` (process never meaningfully
 * started). The install / update flow is not rolled back either way.
 */
export async function executeHook(
  hookPath: string,
  ctx: HookContext,
  opts: HookExecOpts = {},
): Promise<HookResult> {
  const { timeoutMs = DEFAULT_HOOK_TIMEOUT_MS, onStdout, onStderr, signal } = opts;

  // Resolve tsx's loader path. Failure here means the user's node_modules
  // was pruned — not recoverable in-process.
  let tsxLoaderPath: string;
  try {
    const require_ = createRequire(import.meta.url);
    tsxLoaderPath = require_.resolve('tsx');
  } catch {
    return {
      kind: 'failed',
      message: 'tsx runtime not found in shardmind install. Reinstall shardmind (the bundled TypeScript loader for hooks is missing).',
      stdout: '',
      stderr: '',
    };
  }

  // Locate the sibling hook-runner emitted by tsup at `dist/internal/hook-runner.js`.
  // Resolve via the package's own `exports` map rather than a relative path —
  // tsup's chunk-splitting places core/hook.ts's compiled output in a hashed
  // chunk under `dist/`, so a relative `new URL(...)` would drift with each
  // build. `require.resolve('shardmind/internal/hook-runner')` self-resolves
  // against our package.json regardless of how the consumer installed us.
  let hookRunnerPath: string;
  try {
    const require_ = createRequire(import.meta.url);
    hookRunnerPath = require_.resolve('shardmind/internal/hook-runner');
  } catch {
    return {
      kind: 'failed',
      message: 'hook-runner not found in shardmind install. Did `npm run build` fail to emit the internal bundle?',
      stdout: '',
      stderr: '',
    };
  }
  if (!(await pathExists(hookRunnerPath))) {
    return {
      kind: 'failed',
      message: `hook-runner resolved to ${hookRunnerPath} but the file is missing. Reinstall shardmind.`,
      stdout: '',
      stderr: '',
    };
  }

  // Serialize ctx to a 0o600 temp file. We use a file (not env / stdin)
  // because Windows env has a 32KB per-var cap and large `values` payloads
  // would truncate silently; stdin would entangle with the cancellation
  // bridge in `source/core/cancellation.ts`.
  const ctxPath = path.join(
    os.tmpdir(),
    `shardmind-hook-${crypto.randomBytes(8).toString('hex')}.json`,
  );
  try {
    await fsp.writeFile(ctxPath, JSON.stringify(ctx), { mode: 0o600 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: 'failed',
      message: `failed to write hook context to ${ctxPath}: ${message}`,
      stdout: '',
      stderr: '',
    };
  }

  // Guard against parent Ctrl+C during the spawn window: `useSigintRollback`
  // handles the React-side rollback, but we additionally unlink the ctx
  // tempfile so it doesn't leak under `%TEMP%\` / `/tmp/`. Removed in the
  // normal `finally` path; the SIGINT handler is a belt-and-braces safety.
  const sigintCleanup = (): void => {
    try {
      // Synchronous — we're on the interrupt path and the process may exit
      // before an async `fsp.unlink` completes. Leaking the ctx file under
      // `%TEMP%\` or `/tmp/` is a best-effort concern, not a correctness
      // one, so any failure is swallowed.
      unlinkSync(ctxPath);
    } catch {
      // swallow — best-effort
    }
  };
  process.once('SIGINT', sigintCleanup);

  try {
    const phase = ctx.previousVersion === undefined ? 'post-install' : 'post-update';

    // `node --import file:///.../tsx/dist/loader.mjs runner.js hookPath ctxPath`
    // The `--import` specifier is resolved via file:// URL so Windows
    // absolute paths don't confuse node's parser.
    const child = spawn(
      process.execPath,
      [
        '--import',
        pathToFileURL(tsxLoaderPath).href,
        hookRunnerPath,
        hookPath,
        ctxPath,
      ],
      {
        cwd: ctx.vaultRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          SHARDMIND_HOOK: '1',
          SHARDMIND_HOOK_PHASE: phase,
        },
        signal,
      },
    );

    // Capture stdout + stderr into separate buffers. `appendCapped` enforces
    // the per-stream 256 KB cap; anything beyond gets a single trailing
    // truncation marker so the author can tell output was cut.
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let stdoutDropped = 0;
    let stderrDropped = 0;

    const appendCapped = (
      current: string,
      chunk: string,
      truncated: boolean,
      dropped: number,
    ): { out: string; truncated: boolean; dropped: number } => {
      if (truncated) {
        return { out: current, truncated: true, dropped: dropped + Buffer.byteLength(chunk) };
      }
      const currentBytes = Buffer.byteLength(current);
      const chunkBytes = Buffer.byteLength(chunk);
      if (currentBytes + chunkBytes <= STREAM_CAP_BYTES) {
        return { out: current + chunk, truncated: false, dropped: 0 };
      }
      const remaining = STREAM_CAP_BYTES - currentBytes;
      const kept = remaining > 0 ? Buffer.from(chunk).slice(0, remaining).toString('utf-8') : '';
      return {
        out: current + kept,
        truncated: true,
        dropped: chunkBytes - Buffer.byteLength(kept),
      };
    };

    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => {
      const r = appendCapped(stdout, chunk, stdoutTruncated, stdoutDropped);
      stdout = r.out;
      stdoutTruncated = r.truncated;
      stdoutDropped = r.dropped;
      onStdout?.(chunk);
    });
    child.stderr?.on('data', (chunk: string) => {
      const r = appendCapped(stderr, chunk, stderrTruncated, stderrDropped);
      stderr = r.out;
      stderrTruncated = r.truncated;
      stderrDropped = r.dropped;
      onStderr?.(chunk);
    });

    // Timeout: a soft SIGTERM (emulated as TerminateProcess on Windows)
    // with a KILL_GRACE_MS fallback to SIGKILL. The abort path and the
    // timeout path both land in the same place — see `terminate` below.
    let timedOut = false;
    let cancelled = false;
    const terminate = (reason: 'timeout' | 'cancel'): void => {
      if (reason === 'timeout') timedOut = true;
      if (reason === 'cancel') cancelled = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // swallow — might have already exited
      }
      setTimeout(() => {
        try {
          if (!child.killed) child.kill('SIGKILL');
        } catch {
          // swallow
        }
      }, KILL_GRACE_MS).unref();
    };

    const timeoutHandle = setTimeout(() => terminate('timeout'), timeoutMs);
    timeoutHandle.unref();

    // `spawn({ signal })` auto-kills on abort, but we also track it so the
    // result message names "cancelled" rather than a generic exit code.
    const onAbort = (): void => terminate('cancel');
    signal?.addEventListener('abort', onAbort, { once: true });

    const exitInfo = await new Promise<{ code: number | null; signalName: NodeJS.Signals | null; spawnErr?: Error }>(
      (resolve) => {
        child.once('error', (err: Error) => {
          resolve({ code: null, signalName: null, spawnErr: err });
        });
        child.once('close', (code: number | null, signalName: NodeJS.Signals | null) => {
          resolve({ code, signalName });
        });
      },
    );

    clearTimeout(timeoutHandle);
    signal?.removeEventListener('abort', onAbort);

    // Append truncation markers AFTER capture — if both happen they read
    // in stream-order rather than interleaving with live output.
    if (stdoutTruncated) stdout += `\n[… stdout truncated, ${stdoutDropped} bytes discarded]`;
    if (stderrTruncated) stderr += `\n[… stderr truncated, ${stderrDropped} bytes discarded]`;

    // Result-decision order: cancel > timeout > spawn-error > exit. When
    // `spawn({ signal })` auto-kills on abort, node emits both an 'error'
    // event on the child (our `spawnErr` path) AND fires the abort listener
    // (our `cancelled = true` path). Checking `cancelled` first keeps the
    // user-facing message honest about the reason — the spawn error is a
    // symptom of the cancel, not an independent failure. Same reasoning
    // for timeout: the post-SIGTERM exit looks like a close-with-null-code,
    // but we want the user-facing message to name the timeout.
    if (cancelled) {
      return {
        kind: 'failed',
        message: 'cancelled',
        stdout,
        stderr,
      };
    }

    if (timedOut) {
      return {
        kind: 'failed',
        message: `timed out after ${(timeoutMs / 1000).toFixed(1)}s`,
        stdout,
        stderr,
      };
    }

    if (exitInfo.spawnErr) {
      return {
        kind: 'failed',
        message: `spawn failed: ${exitInfo.spawnErr.message}`,
        stdout,
        stderr,
      };
    }

    // Node maps a signal-terminated child to `{code: null, signalName: 'SIGTERM'}`.
    // We fold that into exitCode -1 so the UI still has a numeric to show —
    // negative codes are conventional for signal-death in shell parlance.
    const exitCode = exitInfo.code ?? -1;
    return { kind: 'ran', stdout, stderr, exitCode };
  } finally {
    process.removeListener('SIGINT', sigintCleanup);
    try {
      await fsp.unlink(ctxPath);
    } catch {
      // The file may already have been removed by sigintCleanup.
    }
  }
}
