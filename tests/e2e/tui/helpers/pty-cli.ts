/**
 * Real-PTY wrapper for invoking `dist/cli.js`.
 *
 * Layer 2 of #111's three-layer testing strategy. Where
 * `tests/e2e/helpers/spawn-cli.ts` (Layer 3 status quo) pipes stdio so
 * `stdin.isTTY === false` in the child — forcing Ink into its single-
 * frame "render once at the end" mode — this helper allocates a
 * pseudoterminal so the child sees a real TTY. Raw mode, ANSI emission,
 * and OS-delivered SIGINT are all exercised end-to-end.
 *
 * Output flows: PTY → xterm-headless `VirtualScreen` → `screen.serialize()`.
 * Tests assert against the rendered cell grid rather than the raw byte
 * stream, so cursor moves and overdraws don't pollute matches.
 *
 * Input flows: tests call `write(bytes)` to push raw keystrokes into
 * the master side of the PTY — same path a real terminal uses. Helper
 * constants below mirror `tests/component/helpers.ts` (ENTER, ESC, etc.).
 *
 * The CLI is invoked as `node dist/cli.js <args>`, identical to Layer 3.
 * `ensureBuilt()` is called at module scope so the first PTY spawn in a
 * suite waits for the build (memoized — the existing build-once guard).
 *
 * Windows: not supported in this layer. node-pty's ConPTY backend has
 * different semantics than POSIX pty (TerminateProcess vs SIGINT,
 * different alt-screen behavior), and the in-tree SIGINT bridge
 * (`source/core/cancellation.ts`) targets the non-TTY pipe path. Tests
 * `it.skipIf(process.platform === 'win32')` per scenario; tracking
 * follow-up via #57. Importing this module on Windows is allowed (the
 * file parses) but `spawnCliPty` throws — guarding the call site with
 * the skip prevents the throw.
 */

import * as nodePty from 'node-pty';
import type { IPty } from 'node-pty';
import { chmodSync, readdirSync, statSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIST_CLI, ensureBuilt } from '../../helpers/build-once.js';
import { tick } from '../../../component/helpers.js';
import { createVirtualScreen, type VirtualScreen } from './virtual-screen.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');

// ───── Keystroke constants ──────────────────────────────────────────
//
// Bytes a real terminal sends for the corresponding key. The xterm
// sequences for arrow keys are CSI A/B/C/D — same shape Ink's stdin
// reader parses on the child side, since Ink uses a real terminal in
// the PTY case (no shim). ENTER is `\r`, not `\n`, because cooked
// mode would echo + translate, and we run in raw mode.

export const ENTER = '\r';
export const ESC = '\x1b';
export const SPACE = ' ';
export const ARROW_UP = '\x1b[A';
export const ARROW_DOWN = '\x1b[B';
export const ARROW_RIGHT = '\x1b[C';
export const ARROW_LEFT = '\x1b[D';
export const BACKSPACE = '\x7f';
export const CTRL_C = '\x03';

// ───── node-pty prebuild +x fixer ────────────────────────────────────
//
// node-pty 1.1.0's npm tarball does not preserve the executable bit on
// `prebuilds/<platform>-<arch>/spawn-helper`. Without +x, the first
// `pty.spawn` on macOS throws `posix_spawnp failed` because the helper
// binary the native pty.fork tries to exec is not executable. We restore
// the bit at module-load time on POSIX — idempotent, scoped to test
// code, and the only platforms we support in this layer.
//
// Linux's node-pty path doesn't ship a separate spawn-helper (it uses
// pty.node directly via posix_openpt / forkpty), so this is a no-op
// when no helper file is found.
//
// Filed upstream: this is well-known in node-pty's tracker as the
// "npm doesn't preserve mode bits in tarballs" packaging issue. The
// production `node-pty` postinstall (`scripts/post-install.js`)
// only handles the build/Release path, not the prebuilds tree.

let prebuildPermsFixed = false;
function fixNodePtyPrebuildPerms(): void {
  if (prebuildPermsFixed) return;
  prebuildPermsFixed = true;
  if (process.platform === 'win32') return;
  try {
    const prebuildsRoot = path.join(REPO_ROOT, 'node_modules', 'node-pty', 'prebuilds');
    const platformDirs = readdirSync(prebuildsRoot);
    for (const dir of platformDirs) {
      // Only touch directories that look like ours — avoid chmodding a
      // foreign helper binary in a sibling platform's prebuild folder
      // even though the chmod is local to our node_modules.
      if (!dir.startsWith(`${process.platform}-`)) continue;
      const helper = path.join(prebuildsRoot, dir, 'spawn-helper');
      try {
        const st = statSync(helper);
        if (st.isFile() && (st.mode & 0o111) === 0) {
          chmodSync(helper, 0o755);
        }
      } catch {
        // Helper missing for this arch (Linux fallback build) — fine.
      }
    }
  } catch {
    // node-pty not installed at expected path. Test will fail loudly
    // on `nodePty.spawn` with a clearer message than a silent chmod
    // skip would produce.
  }
}

// Run once at import so the first `spawnCliPty` call doesn't race the
// fix. Vitest may import this file in any worker order; idempotency
// guards above keep it safe.
fixNodePtyPrebuildPerms();

// ───── Spawn options ─────────────────────────────────────────────────

export interface SpawnCliPtyOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Default 80. */
  cols?: number;
  /** Default 24. */
  rows?: number;
  /**
   * Default 60_000. Outer ceiling on `waitForExit()` before the helper
   * SIGKILLs. Aligns with the per-test 60s budget we set on every
   * Layer 2 scenario (issue body Strategy §Layer 2).
   */
  timeoutMs?: number;
  /**
   * Override the default `[DIST_CLI, ...args]` argv handed to node.
   * Harness-only escape hatch — lets a smoke test spawn a known-shape
   * node child (e.g. a process that ignores SIGTERM) so the helper's
   * own waitForExit / signal-mapping / dispose contract can be pinned
   * without depending on CLI behavior. When set, `args` is ignored.
   * Scenario callers MUST NOT use this — they drive the CLI as users
   * do via `args`.
   */
  nodeArgs?: string[];
}

/**
 * Default rows for diff / hook scenarios. 80x24 is fine for plain
 * wizard prompts; busy diffs (DiffView, AdoptDiffView) and hook
 * Summary frames overflow that surface and scroll counters off
 * before `waitForScreen` can match. Bumping rows to 50 keeps every
 * frame in-viewport. Cols stay 80 — matches a real terminal column
 * width and is wide enough for status bars.
 */
export const PTY_VIEWPORT_ROWS = 50;

export interface PtyHandle {
  /**
   * The child process's POSIX pid at spawn time. Exposed so harness
   * tests can verify the child has actually been reaped
   * (`process.kill(pid, 0)` throws ESRCH after a forced kill) —
   * `waitForExit`'s synthetic fallback at line 385 reports
   * `signal: 'SIGKILL'` regardless of whether the kill landed, so a
   * process-state check is the only way to pin the force-kill
   * contract from outside the helper.
   *
   * Lifetime: only meaningful between spawn and reap. The kernel
   * recycles pids quickly (Darwin's pid space is 16-bit / wraps under
   * 32768), so a caller that reads `handle.pid` long after `dispose()`
   * or after the child has exited may end up signalling an unrelated
   * process. Use immediately after the kill window — the
   * `waitForReaped` pattern in the harness tests demonstrates this.
   */
  pid: number;
  /** Bytes pushed into the master side of the PTY. */
  write: (data: string) => void;
  /** Cell-grid view of what the child has rendered. */
  screen: VirtualScreen;
  /**
   * Resolve when the screen reaches the predicate. Times out via
   * `opts.timeoutMs` (default 30_000) and throws including the most
   * recent serialized screen, which is what makes failures
   * actionable. Mirrors `tests/component/helpers.ts::waitFor`.
   */
  waitForScreen: (
    predicate: (screen: string) => boolean,
    opts?: { timeoutMs?: number; pollMs?: number; description?: string },
  ) => Promise<string>;
  /** Send SIGINT (POSIX signal); the kernel delivers it through the PTY. */
  sigint: () => void;
  /**
   * Resolve when the child exits. Result includes exit code + signal
   * name. Times out via `SpawnCliPtyOptions.timeoutMs`; on timeout the
   * child is force-killed (SIGKILL) so test workers don't hang.
   */
  waitForExit: () => Promise<{ exitCode: number | null; signal: string | null; timedOut: boolean }>;
  /** Best-effort SIGKILL. Idempotent. */
  kill: () => void;
  /**
   * Tear down everything: SIGKILLs the child if alive and disposes the
   * underlying xterm-headless terminal. Idempotent. Tests that aren't
   * sure whether they reached `waitForExit` should call this in a
   * `finally` block — leaks an xterm Terminal otherwise.
   */
  dispose: () => Promise<void>;
}

/**
 * Spawn `dist/cli.js` inside a PTY and return a typed handle for tests.
 *
 * The PTY itself runs `node dist/cli.js <args>` directly (no `npm
 * exec` shim) so the env we hand in is the env the CLI sees. The env
 * is built from `process.env` minus any `SHARDMIND_*` keys (so a stale
 * shell-level env var doesn't poison the test) plus `opts.env` merged
 * last. Unlike Layer 3's `spawnCli`, we do NOT set `CI=1 / TERM=dumb /
 * NO_COLOR=1` — the entire point of Layer 2 is real TTY rendering, so
 * `TERM=xterm-256color` matches what a human's terminal advertises.
 */
export async function spawnCliPty(
  args: string[],
  opts: SpawnCliPtyOptions,
): Promise<PtyHandle> {
  if (process.platform === 'win32') {
    throw new Error(
      'spawnCliPty is not supported on Windows — Layer 2 scenarios skip via it.skipIf. See #57.',
    );
  }

  // `ensureBuilt` is memoized after the first call so the build is
  // amortized across the suite. Skip it when the caller is using a
  // node-args override — those harness tests don't touch dist/cli.js
  // and shouldn't pay the build cost on a fresh tree.
  if (!opts.nodeArgs) await ensureBuilt();

  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  // Strip SHARDMIND_* from the inherited env before merging the test
  // overrides. Without this, a developer running the suite with a
  // shell-level SHARDMIND_GITHUB_API_BASE pointing at a prior stub
  // would silently route the test against a stale endpoint.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('SHARDMIND_')) delete env[key];
  }
  // Strip CI-detection env vars. Ink uses `is-ci` to decide whether
  // to render incrementally or batch into a single final frame; when
  // any of these are set, it picks the batched path even with
  // `stdin.isTTY === true`. Layer 2's whole reason to exist is real
  // interactive rendering, so we delete every CI hint the inherited
  // env carries and let `process.stdout.isTTY` (true under PTY)
  // drive Ink's mode choice. Mirrors `is-ci`'s detection list.
  for (const key of [
    'CI',
    'CONTINUOUS_INTEGRATION',
    'BUILD_NUMBER',
    'RUN_ID',
    'GITHUB_ACTIONS',
    'GITLAB_CI',
    'CIRCLECI',
    'TRAVIS',
    'APPVEYOR',
    'BUILDKITE',
    'DRONE',
    'SEMAPHORE',
    'TEAMCITY_VERSION',
    'TF_BUILD',
  ]) {
    delete env[key];
  }
  // Real-TTY env. xterm-256color is what most modern emulators
  // advertise; Ink + @inkjs/ui adapt to it, and our virtual-screen
  // emulator parses everything they emit.
  Object.assign(env, { TERM: 'xterm-256color' }, opts.env ?? {});

  const screen = createVirtualScreen({ cols, rows });

  const argv = opts.nodeArgs ?? [DIST_CLI, ...args];
  const pty: IPty = nodePty.spawn(process.execPath, argv, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: opts.cwd,
    // node-pty's IPtyForkOptions types env as `{ [key: string]: string }`
    // (no undefined). Strip undefined keys before handing off so the
    // shape lines up exactly.
    env: stripUndefined(env),
  });

  // Buffer every byte the child emits into the headless terminal.
  // `feed` returns a Promise (xterm-headless processes writes on the
  // next tick); we deliberately don't await — successive `pty.onData`
  // chunks settle in order via xterm's internal queue, and
  // `waitForScreen`'s 50 ms poll cadence is the synchronization seam
  // that matters. `void` makes the fire-and-forget intent explicit
  // and quiets the no-floating-promises lint that ts strict + vitest
  // surface for unhandled returns.
  pty.onData((chunk) => {
    void screen.feed(chunk);
  });

  // Capture exit info via a single Promise resolved by `pty.onExit`.
  // Polling `exitInfo === null` would burn CPU on the 20 ms cadence
  // even on instant exits; awaiting the Promise lets the event loop
  // sleep until node-pty actually fires.
  //
  // node-pty's `signal` is a numeric POSIX code (2 for SIGINT, 9 for
  // SIGKILL, etc.), not the symbolic name. We map back to the
  // symbolic form via `os.constants.signals` so test assertions can
  // compare against `'SIGINT'` etc. without knowing the platform's
  // numeric mapping (which differs between BSD and Linux for some
  // signals).
  let exitInfo: { exitCode: number | null; signal: string | null } | null = null;
  const exitPromise = new Promise<{ exitCode: number | null; signal: string | null }>(
    (resolve) => {
      pty.onExit(({ exitCode, signal }) => {
        const info = { exitCode, signal: signalNumberToName(signal) };
        exitInfo = info;
        resolve(info);
      });
    },
  );

  const write = (data: string): void => {
    pty.write(data);
  };

  const waitForScreen = async (
    predicate: (s: string) => boolean,
    waitOpts?: { timeoutMs?: number; pollMs?: number; description?: string },
  ): Promise<string> => {
    const limit = waitOpts?.timeoutMs ?? 30_000;
    const poll = waitOpts?.pollMs ?? 50;
    const description = waitOpts?.description ?? 'predicate';
    const start = Date.now();
    let last = '';
    while (Date.now() - start < limit) {
      last = screen.serialize();
      if (predicate(last)) {
        // Post-predicate settle: Ink renders the frame BEFORE the
        // newly-mounted component's `useInput` subscription is fully
        // registered. A keystroke written immediately after a match
        // can land between render-commit and effect-flush, where no
        // input handler exists yet — the byte gets dropped silently
        // (TextInput shows "lice" instead of "Alice", etc.).
        // Layer 1's `tests/component/helpers.ts::waitFor` settles 30
        // ms because in-process effects flush within a microtask.
        // Layer 2 has to absorb the kernel PTY pipeline on top of
        // that — master → slave → child stdin → Ink raw-mode reader
        // — and the worst case under 4× full-suite + 8× isolated
        // parallel pressure measured ~70 ms before the first
        // keystroke would land. 100 ms gives headroom; the only
        // cost is `~1 s` of cumulative delay across the L2 suite,
        // which is dwarfed by the 5 s wall clock the suite spends
        // in actual PTY work.
        await tick(100);
        return last;
      }
      await tick(poll);
    }
    throw new Error(
      `waitForScreen timed out after ${limit}ms waiting for ${description}.\nLast screen:\n${last}`,
    );
  };

  const sigint = (): void => {
    // node-pty exposes a `kill(signal)` that delivers via the kernel,
    // matching what a real terminal sends on Ctrl+C. The string form
    // is required by node-pty's typings.
    pty.kill('SIGINT');
  };

  const waitForExit = async (): Promise<{
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
  }> => {
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timeoutHandle = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const winner = await Promise.race([exitPromise, timeoutPromise]);
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    if (winner === 'timeout') {
      // Force-kill so vitest workers don't hang on a stuck child.
      try {
        pty.kill('SIGKILL');
      } catch {
        // Already dead.
      }
      // The SIGKILL above eventually fires `onExit` and resolves
      // `exitPromise`. If it lands within the grace window, surface
      // the captured info; otherwise return a synthetic SIGKILL state
      // (test workers can't wait forever on a wedged child). Either
      // way, clear the grace timer so an orphan setTimeout doesn't
      // pin the worker after this function returns.
      let graceHandle: NodeJS.Timeout | undefined;
      const gracePromise = new Promise<'killed'>((resolve) => {
        graceHandle = setTimeout(() => resolve('killed'), 200);
      });
      const graceWinner = await Promise.race([exitPromise, gracePromise]);
      if (graceHandle !== undefined) clearTimeout(graceHandle);
      if (graceWinner === 'killed') {
        return { exitCode: null, signal: 'SIGKILL', timedOut: true };
      }
      return { ...graceWinner, timedOut: true };
    }
    return { ...winner, timedOut: false };
  };

  const kill = (): void => {
    if (exitInfo !== null) return;
    try {
      pty.kill('SIGKILL');
    } catch {
      // Already dead.
    }
  };

  const dispose = async (): Promise<void> => {
    // Skip the kill + drain race when the child already exited.
    // Without the early-return, every clean test path waits 200 ms
    // for nothing — across the L2 suite that's tens of seconds of
    // orphan-timer cost. Clearing the timer below is what keeps the
    // worker from being pinned after dispose returns.
    if (exitInfo === null) {
      kill();
      let drainHandle: NodeJS.Timeout | undefined;
      const drainPromise = new Promise<void>((resolve) => {
        drainHandle = setTimeout(resolve, 200);
      });
      await Promise.race([exitPromise, drainPromise]);
      if (drainHandle !== undefined) clearTimeout(drainHandle);
    }
    screen.dispose();
  };

  return { pid: pty.pid, write, screen, waitForScreen, sigint, waitForExit, kill, dispose };
}

/**
 * Type a string into a TextInput, verifying the rendered content
 * matches and retrying on partial drops.
 *
 * The first byte after a TextInput mounts can be dropped under
 * heavy parallel-CPU contention: Ink's render commit precedes its
 * `useInput` subscription, so a byte arriving in the kernel PTY
 * buffer between those phases is consumed before any handler exists.
 * Symptom: "Alice" appears as "lice" — leading 'A' lost.
 *
 * Mitigation here is content-aware retry rather than longer settle:
 *   1. Write the full string char-by-char (same per-char delay as
 *      `tests/component/helpers.ts::typeText`).
 *   2. Verify `text` appears in the rendered screen. The user
 *      names this helper handles (e.g. "Alice", "Dana") never
 *      collide with the wizard chrome, so a substring match is a
 *      sufficient predicate.
 *   3. On miss: clear any partial input via repeated BACKSPACE
 *      (no-op once the input is empty), then loop. Three attempts
 *      total before surrender — by then either the input pipeline
 *      is genuinely broken (real bug) or this scenario's wall-clock
 *      budget is the right place to surface it via the caller's
 *      eventual `waitForScreen` timeout.
 */
export async function typeIntoPty(
  handle: PtyHandle,
  text: string,
  perCharDelayMs = 25,
): Promise<void> {
  if (text.length === 0) return;
  const VERIFY_BUDGET_MS = 400;
  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    for (const ch of text) {
      handle.write(ch);
      await tick(perCharDelayMs);
    }
    const deadline = Date.now() + VERIFY_BUDGET_MS;
    while (Date.now() < deadline) {
      if (handle.screen.contains(text)) return;
      await tick(30);
    }
    if (attempt === MAX_ATTEMPTS - 1) return;
    // Clear any partial input. Send `text.length + 2` BACKSPACEs:
    // worst case the input is full (length chars) + cursor at end;
    // BACKSPACE on empty is a TextInput no-op so over-clearing is
    // safe.
    for (let i = 0; i < text.length + 2; i++) {
      handle.write(BACKSPACE);
      await tick(10);
    }
    await tick(50);
  }
}

/**
 * Drive the standard 4-question minimal-shard wizard through the
 * confirm step. Returns once "Ready to install" is on screen and the
 * caller can decide whether to commit (ENTER) or cancel
 * (ARROW_DOWN×2 + ENTER). Mirrors the Layer 1 helper of the same
 * name in `tests/component/flows/helpers.tsx` — same wizard shape,
 * driven through the PTY rather than ink-testing-library's stdin.
 */
export async function driveMinimalWizard(
  handle: PtyHandle,
  userName = 'Alice',
): Promise<void> {
  await handle.waitForScreen(
    (s) => /4 questions to answer/.test(s),
    { timeoutMs: 30_000, description: 'wizard intro frame' },
  );
  handle.write(ENTER);
  await handle.waitForScreen((s) => s.includes('Your name'));
  await typeIntoPty(handle, userName);
  handle.write(ENTER);
  await handle.waitForScreen((s) => s.includes('Organization'));
  handle.write(ENTER);
  await handle.waitForScreen((s) => s.includes('How will you use this vault'));
  handle.write(ENTER);
  await handle.waitForScreen((s) => s.includes('QMD'));
  handle.write('n');
  await handle.waitForScreen(
    (s) => s.includes('Choose modules to install'),
    { timeoutMs: 15_000 },
  );
  handle.write(ENTER);
  await handle.waitForScreen((s) => s.includes('Ready to install'));
}

function stripUndefined(env: NodeJS.ProcessEnv): { [key: string]: string } {
  const out: { [key: string]: string } = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Map node-pty's numeric `signal` field back to its POSIX symbolic
 * name (`2` → `'SIGINT'`). Falls back to the numeric stringification
 * for codes not present in `os.constants.signals` (e.g. real-time
 * signals on Linux), which keeps the field always-stringy without
 * losing information. Returns null when the child exited normally
 * (no signal involved).
 *
 * Exported for harness tests that pin the mapping against
 * `os.constants.signals` directly — the function is small but
 * platform-sensitive, and a regression here misjudges scenario 18's
 * SIGINT-vs-SIGKILL contract.
 */
export function signalNumberToName(num: number | undefined): string | null {
  if (num === undefined) return null;
  // os.constants.signals is a record `{ SIGINT: 2, SIGKILL: 9, ... }`.
  // The reverse lookup is small (~30 entries) and runs once per
  // process exit — no need to memoize.
  for (const [name, code] of Object.entries(osConstants.signals)) {
    if (code === num) return name;
  }
  return String(num);
}
