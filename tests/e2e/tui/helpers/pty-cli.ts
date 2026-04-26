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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIST_CLI, ensureBuilt } from '../../helpers/build-once.js';
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
}

export interface PtyHandle {
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

  await ensureBuilt();

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
  // Real-TTY env. xterm-256color is what most modern emulators
  // advertise; Ink + @inkjs/ui adapt to it, and our virtual-screen
  // emulator parses everything they emit.
  Object.assign(env, { TERM: 'xterm-256color' }, opts.env ?? {});

  const screen = createVirtualScreen({ cols, rows });

  const pty: IPty = nodePty.spawn(process.execPath, [DIST_CLI, ...args], {
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

  let exitInfo: { exitCode: number | null; signal: string | null } | null = null;
  pty.onExit(({ exitCode, signal }) => {
    exitInfo = { exitCode, signal: signal !== undefined ? String(signal) : null };
  });

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
      if (predicate(last)) return last;
      await sleep(poll);
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
    const start = Date.now();
    while (exitInfo === null) {
      if (Date.now() - start >= timeoutMs) {
        // Force-kill so vitest workers don't hang on a stuck child.
        try {
          pty.kill('SIGKILL');
        } catch {
          // Already dead.
        }
        // Give the kernel a beat to deliver the close event so exitInfo
        // is populated; if not, return synthetic timeout state.
        await sleep(100);
        if (exitInfo === null) {
          return { exitCode: null, signal: 'SIGKILL', timedOut: true };
        }
        return { ...exitInfo, timedOut: true };
      }
      await sleep(20);
    }
    return { ...exitInfo, timedOut: false };
  };

  const kill = (): void => {
    if (exitInfo !== null) return;
    try {
      pty.kill('SIGKILL');
    } catch {
      // Already dead.
    }
  };

  return { write, screen, waitForScreen, sigint, waitForExit, kill };
}

/**
 * Type a string one character at a time, with a short pause between
 * each keystroke so React commits each insert before the next byte
 * arrives. Mirrors `tests/component/helpers.ts::typeText` — same
 * rationale (see comment there) translated to PTY: @inkjs/ui's
 * TextInput onSubmit captures `state.value` in a useCallback closure;
 * batching multiple bytes into one render leaves the closure stale
 * relative to the rendered string.
 */
export async function typeIntoPty(
  handle: { write: (s: string) => void },
  text: string,
  perCharDelayMs = 25,
): Promise<void> {
  for (const ch of text) {
    handle.write(ch);
    await new Promise((r) => setTimeout(r, perCharDelayMs));
  }
}

function stripUndefined(env: NodeJS.ProcessEnv): { [key: string]: string } {
  const out: { [key: string]: string } = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
