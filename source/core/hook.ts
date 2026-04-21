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
import { fileURLToPath, pathToFileURL } from 'node:url';
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
 * Back a byte-offset cut up to the last complete UTF-8 code point that
 * ends at or before `offset`. Used by `appendCapped` to avoid slicing
 * mid-multibyte when saturating the stream cap — a naive cut on an
 * emoji's 4-byte sequence would produce a U+FFFD replacement char on
 * decode AND would throw the dropped-byte accounting off by 1-3.
 *
 * UTF-8 encoding: leading byte has high bits `0xxxxxxx`, `110xxxxx`,
 * `1110xxxx`, or `11110xxx`; continuation bytes are `10xxxxxx`. The
 * walk-back is bounded by 3 bytes (longest continuation sequence in
 * modern UTF-8; older 5-6 byte sequences are no longer valid UTF-8 per
 * RFC 3629) so the loop is O(1).
 */
function lastCompleteUtf8Boundary(buf: Buffer, offset: number): number {
  if (offset <= 0) return 0;
  if (offset >= buf.length) return buf.length;
  // If the byte AT `offset` is a continuation (`10xxxxxx`), the code
  // point starting before `offset` is incomplete — back up.
  let cut = offset;
  for (let i = 0; i < 3 && cut > 0; i++) {
    const byte = buf[cut];
    if (byte === undefined || (byte & 0b1100_0000) !== 0b1000_0000) break;
    cut--;
  }
  return cut;
}

/**
 * Return the last `capBytes` bytes of `s` as valid UTF-8 — adjusted
 * forward from the byte cut to the next complete code point boundary
 * so the returned string never starts with an orphaned continuation
 * byte.
 *
 * Used by the UI-side streaming buffer in `source/commands/hooks/shared.ts`,
 * where we want to keep the MOST RECENT N bytes (tail-trim) rather than
 * the prefix. A naive `s.slice(s.length - N)` trims by JS character
 * count, which drifts 2-4× wide for mostly-multibyte output and can
 * blow past the byte budget. A `Buffer`-based trim on a mid-multibyte
 * boundary produces U+FFFD like the prefix-trim case.
 *
 * Exported so the UI-side appendHookOutput can share the UTF-8 walker
 * with `appendCapped` above.
 */
export function tailAtUtf8Boundary(s: string, capBytes: number): string {
  if (capBytes <= 0) return '';
  const buf = Buffer.from(s, 'utf-8');
  if (buf.length <= capBytes) return s;
  // Initial cut: keep the last `capBytes` bytes. If that cut lands on a
  // continuation byte, walk FORWARD to the next lead byte so the tail
  // starts with a complete code point. Bounded by 3 bytes for the same
  // reason as `lastCompleteUtf8Boundary`.
  let cut = buf.length - capBytes;
  for (let i = 0; i < 3 && cut < buf.length; i++) {
    const byte = buf[cut];
    if (byte === undefined || (byte & 0b1100_0000) !== 0b1000_0000) break;
    cut++;
  }
  return buf.slice(cut).toString('utf-8');
}

/**
 * Grace period between the first termination signal (SIGTERM / Windows
 * TerminateProcess via `child.kill()`) and the hard SIGKILL when a hook
 * times out or the parent aborts. Gives the hook a chance to flush
 * buffered stdout; most platforms surface the buffered bytes before the
 * process exits.
 */
const KILL_GRACE_MS = 2_000;

/**
 * Which lifecycle slot fired the hook. Exported so the command machines,
 * the HookProgress component, and the hook-runner wrapper can all share
 * one source of truth for the two allowed phase strings (and so a future
 * third phase becomes a compile-time update rather than a search-and-fix).
 */
export type HookStage = 'post-install' | 'post-update';

/**
 * The shape of a command-machine `Phase` variant while a hook subprocess
 * is running. Each machine's full Phase union intersects this — sharing
 * the variant here lets `appendHookOutput` in shared.ts typecheck
 * generically without either machine leaking its internal phases.
 */
export interface RunningHookPhase {
  kind: 'running-hook';
  stage: HookStage;
  output: string;
  shardLabel: string;
}

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

  // Locate the sibling hook-runner. Two resolution paths:
  //
  //   (prod) `require.resolve('shardmind/internal/hook-runner')` against the
  //     package's own `exports` map — stable across install layouts and
  //     tsup's chunk hashing (core/hook.ts's compiled output lives in a
  //     hashed `dist/chunk-*.js`, so a relative URL would drift per build).
  //
  //   (dev)  walk from `import.meta.url` to the adjacent source file at
  //     `../internal/hook-runner.ts`. This covers vitest runs where the
  //     package has not been built yet — tsx transpiles the runner on
  //     subprocess load either way, so the .ts path works identically to
  //     the .js one from the spawn's perspective.
  //
  // Both paths tolerate failure: if neither finds a usable runner we surface
  // a `failed` result with a reinstall hint rather than throwing.
  let hookRunnerPath: string | null = null;
  try {
    const require_ = createRequire(import.meta.url);
    const candidate = require_.resolve('shardmind/internal/hook-runner');
    if (await pathExists(candidate)) hookRunnerPath = candidate;
  } catch {
    // Fall through to the dev-mode attempt.
  }
  if (hookRunnerPath === null) {
    const devCandidate = fileURLToPath(new URL('../internal/hook-runner.ts', import.meta.url));
    if (await pathExists(devCandidate)) hookRunnerPath = devCandidate;
  }
  if (hookRunnerPath === null) {
    return {
      kind: 'failed',
      message: 'hook-runner not found in shardmind install. Did `npm run build` fail to emit the internal bundle?',
      stdout: '',
      stderr: '',
    };
  }

  // Serialize ctx to a 0o600 temp file. We use a file (not env / stdin)
  // because Windows env has a 32KB per-var cap and large `values` payloads
  // would truncate silently; stdin would entangle with the cancellation
  // bridge in `source/core/cancellation.ts`.
  //
  // `flag: 'wx'` opens with O_EXCL: the write fails atomically if anything
  // exists at the path, which closes the TOCTOU window an attacker would
  // otherwise have to race-symlink a tempfile at the resolved name before
  // our write. An 8-byte random suffix makes collisions astronomically
  // unlikely on its own; wx is belt-and-braces against a hostile
  // multi-user `os.tmpdir()`.
  const ctxPath = path.join(
    os.tmpdir(),
    `shardmind-hook-${crypto.randomBytes(8).toString('hex')}.json`,
  );
  try {
    await fsp.writeFile(ctxPath, JSON.stringify(ctx), { mode: 0o600, flag: 'wx' });
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
    const phase: HookStage = ctx.previousVersion === undefined ? 'post-install' : 'post-update';

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
    //
    // Byte counts are tracked incrementally in the closure below rather
    // than recomputed via `Buffer.byteLength(current)` per chunk. At a
    // stream saturating the 256 KB cap in small chunks, the naive
    // recompute would be O(n²) on the combined byte size; tracking the
    // running total is O(1) per chunk.
    const streams = {
      stdout: { out: '', bytes: 0, truncated: false, dropped: 0 },
      stderr: { out: '', bytes: 0, truncated: false, dropped: 0 },
    };

    const appendCapped = (
      stream: { out: string; bytes: number; truncated: boolean; dropped: number },
      chunk: string,
    ): void => {
      if (stream.truncated) {
        stream.dropped += Buffer.byteLength(chunk);
        return;
      }
      const chunkBytes = Buffer.byteLength(chunk);
      if (stream.bytes + chunkBytes <= STREAM_CAP_BYTES) {
        stream.out += chunk;
        stream.bytes += chunkBytes;
        return;
      }
      // Truncation boundary: `remaining` bytes fit; everything past that is
      // dropped. A naive `Buffer.from(chunk).slice(0, remaining).toString('utf-8')`
      // would insert a U+FFFD replacement character whenever `remaining`
      // falls mid-multibyte (common around emoji / CJK output) AND the
      // resulting string's byte count would no longer match `remaining`,
      // throwing the `dropped` accounting off by 1-3 bytes. Back the cut
      // up to the last complete UTF-8 code point we can keep, measure
      // keptBytes from the final slice, and charge the full input minus
      // kept to `dropped`.
      const remaining = STREAM_CAP_BYTES - stream.bytes;
      const chunkBuffer = Buffer.from(chunk);
      const safeCut = remaining > 0 ? lastCompleteUtf8Boundary(chunkBuffer, remaining) : 0;
      const kept = safeCut > 0 ? chunkBuffer.slice(0, safeCut).toString('utf-8') : '';
      const keptBytes = safeCut;
      stream.out += kept;
      stream.bytes += keptBytes;
      stream.truncated = true;
      stream.dropped = chunkBytes - keptBytes;
    };

    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => {
      appendCapped(streams.stdout, chunk);
      onStdout?.(chunk);
    });
    child.stderr?.on('data', (chunk: string) => {
      appendCapped(streams.stderr, chunk);
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
    let stdout = streams.stdout.out;
    let stderr = streams.stderr.out;
    if (streams.stdout.truncated) {
      stdout += `\n[… stdout truncated, ${streams.stdout.dropped} bytes discarded]`;
    }
    if (streams.stderr.truncated) {
      stderr += `\n[… stderr truncated, ${streams.stderr.dropped} bytes discarded]`;
    }

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
