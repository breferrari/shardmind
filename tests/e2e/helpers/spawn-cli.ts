/**
 * Subprocess wrapper for invoking `dist/cli.js` as a user would.
 *
 * Uses Node's built-in `child_process.spawn` (no `execa` dependency added
 * for test-only concerns). Stdout/stderr are captured; exit codes and
 * signals are reported. A `signalAt` option delivers a signal mid-run
 * once a stdout pattern matches — this is how we get deterministic
 * SIGINT-during-installing coverage without timing-dependent sleeps.
 *
 * Non-TTY environment variables (`CI=1`, `TERM=dumb`, `NO_COLOR=1`) are
 * applied by default so Ink produces stable, ANSI-clean output we can
 * grep against. Tests that need TTY semantics can override.
 *
 * The CLI is invoked as `node dist/cli.js <args>` — we don't rely on the
 * package.json bin shim because that requires `npm link` or an install
 * step we'd rather skip. Invoking via `node` directly mirrors what a
 * user running `npx shardmind` ends up executing.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { DIST_CLI } from './build-once.js';

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Milliseconds from spawn to close. */
  duration: number;
  /** True when the outer timeout fired before the process exited. */
  timedOut: boolean;
}

export interface SignalAt {
  signal: NodeJS.Signals;
  /**
   * Fire the signal when stdout matches this pattern. Works in TTY mode
   * where Ink streams intermediate frames. In non-TTY mode Ink renders
   * once at the end, so pattern-based firing is unreliable for mid-run
   * signals — use `afterMs` instead.
   */
  afterPattern?: RegExp;
  /**
   * Fire the signal a fixed number of milliseconds after spawn. Preferred
   * for mid-run signal tests in non-TTY mode where stdout-pattern matching
   * doesn't see intermediate frames. Pair with a slow stub (e.g.
   * `setTarballDelay`) so there's actually an active download to signal.
   */
  afterMs?: number;
  /** Optional grace period after the match before signalling (ms). */
  delayMs?: number;
}

export interface SpawnCliOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  /** Default 15_000. The outer ceiling on how long we wait before SIGKILL. */
  timeoutMs?: number;
  /** Deliver a signal after a stdout regex matches. */
  signalAt?: SignalAt;
  /** Override the default CI=1 / TERM=dumb non-TTY defaults (escape hatch). */
  ttyLike?: boolean;
}

const DEFAULT_TIMEOUT = 15_000;

/**
 * Spawn the CLI, wait for it to exit (or timeout), return captured output.
 */
export async function spawnCli(args: string[], opts: SpawnCliOptions): Promise<CliResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const env: NodeJS.ProcessEnv = {
    // Start from a clean slate so the test doesn't inherit the dev's
    // SHARDMIND_GITHUB_API_BASE pointing at a previous run's stub, etc.
    ...process.env,
    ...(opts.ttyLike
      ? {}
      : { CI: '1', TERM: 'dumb', NO_COLOR: '1', FORCE_COLOR: '0' }),
    ...(opts.env ?? {}),
  };

  const startedAt = Date.now();
  const child = spawn('node', [DIST_CLI, ...args], {
    cwd: opts.cwd,
    env,
    // Pipe all three — write stdin explicitly when we actually need to.
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf-8');
  child.stderr?.setEncoding('utf-8');

  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const signalAt = opts.signalAt;
  if (signalAt) {
    wireSignalAt(child, signalAt);
  }

  if (opts.stdin !== undefined) {
    child.stdin?.write(opts.stdin);
  }
  // Keep stdin open when signalAt is configured so the handler can write
  // the ETX byte (Windows path) later. Otherwise close immediately — an
  // open stdin keeps the child's event loop alive on some Node versions.
  if (!opts.signalAt) {
    child.stdin?.end();
  }

  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    // SIGKILL — the outer timeout means the child has already ignored
    // SIGINT (or was never signalled). Force-kill so tests don't hang.
    child.kill('SIGKILL');
  }, timeoutMs);

  const [exitCode, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(
    (resolve) => {
      child.once('close', (code, sig) => resolve([code, sig]));
    },
  );
  clearTimeout(timeoutHandle);

  return {
    stdout: normalizeLineEndings(stdout),
    stderr: normalizeLineEndings(stderr),
    exitCode,
    signal,
    duration: Date.now() - startedAt,
    timedOut,
  };
}

function wireSignalAt(child: ChildProcess, spec: SignalAt): void {
  let fired = false;

  const deliver = (): void => {
    if (child.pid === undefined || child.killed) return;
    // On Windows, `child.kill('SIGINT')` becomes `TerminateProcess` — it
    // skips every SIGINT handler and leaves the vault in whatever state
    // the write phase had reached. Instead, write the ETX byte to stdin;
    // `installStdinCancellation` inside the CLI emits SIGINT within the
    // child's own process, where every registered handler actually fires.
    // POSIX keeps the native signal path.
    if (process.platform === 'win32' && spec.signal === 'SIGINT') {
      child.stdin?.write(Buffer.from([0x03]));
      child.stdin?.end();
      return;
    }
    child.kill(spec.signal);
    child.stdin?.end();
  };

  const fire = (): void => {
    if (fired) return;
    fired = true;
    if (spec.delayMs && spec.delayMs > 0) {
      setTimeout(deliver, spec.delayMs);
    } else {
      deliver();
    }
  };

  if (spec.afterMs !== undefined) {
    setTimeout(fire, spec.afterMs);
  }

  if (spec.afterPattern) {
    let buffer = '';
    child.stdout?.on('data', (chunk: string) => {
      if (fired) return;
      buffer += chunk;
      if (spec.afterPattern!.test(buffer)) fire();
    });
  }
}

/**
 * CRLF → LF normalization so Windows stdout captures diff against
 * POSIX-written expected strings.
 */
function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n/g, '\n');
}
