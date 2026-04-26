/**
 * Smoke tests for the Layer 2 PTY + virtual-screen helpers themselves.
 *
 * Pins the contract the scenario files rely on: spawn works, stdin
 * round-trips through the PTY, ANSI escape sequences are folded by
 * the headless terminal, and `waitForScreen` produces a useful error
 * when its predicate doesn't match.
 *
 * Mirrors Phase 1's `tests/component/flows/harness.test.tsx` shape —
 * if the helpers regress, this file fails before the actual scenario
 * suites do, narrowing the blame surface.
 *
 * Skipped on Windows: ConPTY semantics diverge from POSIX pty enough
 * that Layer 2 doesn't run there. Tracking via #57.
 */

import { describe, it, expect } from 'vitest';
import { constants as osConstants } from 'node:os';
import os from 'node:os';
import { createVirtualScreen } from './helpers/virtual-screen.js';
import {
  spawnCliPty,
  signalNumberToName,
  ENTER,
} from './helpers/pty-cli.js';

const skipOnWindows = process.platform === 'win32';

describe.skipIf(skipOnWindows)('Layer 2 harness — virtual screen', () => {
  it('renders plain text into the visible viewport', async () => {
    const screen = createVirtualScreen({ cols: 20, rows: 3 });
    await screen.feed('hello world');
    expect(screen.contains('hello world')).toBe(true);
    screen.dispose();
  });

  it('folds ANSI escape sequences (cursor + color) into rendered chars', async () => {
    const screen = createVirtualScreen({ cols: 20, rows: 3 });
    // Red foreground, "RED", reset, then plain text. The serialized
    // grid is the rendered chars only — color codes are gone.
    await screen.feed('\x1b[31mRED\x1b[0m TEXT');
    const out = screen.serialize();
    expect(out).toContain('RED TEXT');
    expect(out).not.toContain('\x1b');
    screen.dispose();
  });

  it('handles cursor overdraw — last write wins on the same cell', async () => {
    const screen = createVirtualScreen({ cols: 20, rows: 3 });
    // Write "first", then carriage-return + "later" (overdrawing the
    // first 5 cells with "later"). The visible row should contain
    // "later" — the transient "first" must NOT show.
    await screen.feed('first\rlater');
    expect(screen.contains('later')).toBe(true);
    expect(screen.contains('first')).toBe(false);
    screen.dispose();
  });

  it('matches regex against the serialized viewport', async () => {
    const screen = createVirtualScreen({ cols: 20, rows: 3 });
    await screen.feed('item (2 of 5)');
    expect(screen.matches(/\(2 of 5\)/)).toBe(true);
    expect(screen.matches(/\(3 of 5\)/)).toBe(false);
    screen.dispose();
  });

  it('dispose() is idempotent — calling twice does not throw', () => {
    // A test's `finally { screen.dispose() }` may run after a higher-
    // level cleanup hook already disposed (e.g. PtyHandle.dispose ran,
    // and then the test's own finally runs the screen path again).
    // The second call must be a silent no-op, not a throw — otherwise
    // tests pass on the green path and explode on the red path.
    const screen = createVirtualScreen({ cols: 10, rows: 2 });
    screen.dispose();
    expect(() => screen.dispose()).not.toThrow();
  });

  it('feed() after dispose() resolves silently — no throw, no buffer write', async () => {
    // Pin the disposed-flag guard. Without it, a late `pty.onData`
    // chunk (kernel race during cleanup) would call `term.write` on
    // a torn-down xterm Terminal, which xterm rejects with a throw —
    // turning a benign cleanup race into a noisy test failure.
    const screen = createVirtualScreen({ cols: 10, rows: 2 });
    await screen.feed('before');
    screen.dispose();
    await expect(screen.feed('after')).resolves.toBeUndefined();
    // Side-channel check: serialize() after dispose isn't part of the
    // contract we're pinning here, so we don't assert on it. The point
    // is `feed` doesn't throw — anything stronger over-specifies the
    // helper's lifecycle.
  });
});

describe.skipIf(skipOnWindows)('Layer 2 harness — PTY spawn', () => {
  it('spawns the CLI inside a PTY and reads --version through the screen', async () => {
    const handle = await spawnCliPty(['--version'], {
      cwd: os.tmpdir(),
    });
    try {
      // --version exits immediately. Wait for the child to close, then
      // assert the rendered grid carries the version string. We don't
      // pin the exact version — the package bumps independently of
      // this test — but the shape must be `<digits>.<digits>.<digits>`.
      const exit = await handle.waitForExit();
      expect(exit.exitCode).toBe(0);
      expect(handle.screen.matches(/\d+\.\d+\.\d+/)).toBe(true);
    } finally {
      await handle.dispose();
    }
  }, 30_000);

  it('--help renders synchronously and the screen captures the usage line', async () => {
    // Pin two harness contracts in a non-interactive shape:
    //   1. `spawnCliPty` actually spawns the child and reaches its
    //      stdout (the screen ends up with rendered content), and
    //   2. a fast-exit child doesn't deadlock the helper — `waitForExit`
    //      returns within seconds, not minutes.
    // The original test description claimed to verify `write()` round-
    // trips through the child, but `--help` exits immediately without
    // ever reading stdin; renaming so the assertion shape is honest.
    // A genuine input round-trip is exercised by every scenario suite
    // (typeIntoPty / waitForScreen), which is the real coverage.
    const handle = await spawnCliPty(['--help'], {
      cwd: os.tmpdir(),
    });
    try {
      const exit = await handle.waitForExit();
      expect(exit.exitCode).toBe(0);
      const screen = handle.screen.serialize();
      expect(screen.toLowerCase()).toContain('install');
    } finally {
      await handle.dispose();
    }
  }, 30_000);

  it('waitForScreen times out with the last screen captured in the error', async () => {
    const handle = await spawnCliPty(['--version'], {
      cwd: os.tmpdir(),
    });
    try {
      // --version finishes fast; ask for an impossible predicate.
      // The helper must reject with a message that includes the
      // last serialized screen so a real-test failure points at
      // what the user actually saw.
      await expect(
        handle.waitForScreen(() => false, {
          timeoutMs: 200,
          description: 'an impossible predicate',
        }),
      ).rejects.toThrow(/impossible predicate/);
    } finally {
      await handle.dispose();
    }
  }, 30_000);

  it('write(ENTER) is delivered as the literal CR byte', () => {
    // No PTY needed — pin the constant value so a future refactor
    // doesn't accidentally swap to '\n' (which the kernel would
    // translate differently under a cooked-line discipline that
    // this layer specifically avoids).
    expect(ENTER).toBe('\r');
  });

  it('PtyHandle.dispose() is idempotent — sequential calls do not throw', async () => {
    // Mirrors the virtual-screen idempotency above, lifted to the
    // PtyHandle level where dispose also kills the child. The internal
    // `kill()` short-circuits when `exitInfo` is set, so the second
    // dispose must traverse cleanly. Pin it here so a future refactor
    // that re-orders the kill / drain dance surfaces immediately.
    const handle = await spawnCliPty(['--version'], {
      cwd: os.tmpdir(),
    });
    await handle.waitForExit();
    await handle.dispose();
    await expect(handle.dispose()).resolves.toBeUndefined();
  }, 30_000);

  it('waitForExit on a wedged child returns timedOut + SIGKILL with screen captured', async () => {
    // Spawn a node child that ignores BOTH SIGINT and SIGTERM, so the
    // helper's only escape is the SIGKILL force-kill path inside
    // `waitForExit`. Use `nodeArgs` to bypass the CLI — we're testing
    // the helper, not the product. `timeoutMs: 1500` keeps the test
    // bounded; the helper grants a 200 ms grace for SIGKILL to land.
    //
    // The child writes a sentinel string to stdout before wedging so
    // the screen has SOMETHING for the assertion to inspect — proves
    // the screen capture survives all the way through the timeout +
    // kill + drain pipeline. Without the print, an empty screen could
    // mean either "captured correctly but child didn't write" or
    // "screen lost during disposal" — ambiguous.
    const handle = await spawnCliPty([], {
      cwd: os.tmpdir(),
      timeoutMs: 1500,
      nodeArgs: [
        '-e',
        // eslint-disable-next-line no-template-curly-in-string
        'process.stdout.write("WEDGED-SENTINEL\\n"); ' +
          'process.on("SIGINT", () => {}); ' +
          'process.on("SIGTERM", () => {}); ' +
          'setInterval(() => {}, 1e9);',
      ],
    });
    try {
      // Give the child a tick to write its sentinel before we go into
      // waitForExit's timeout dance. 200ms is plenty for a one-line
      // synchronous write.
      await new Promise((r) => setTimeout(r, 200));

      const result = await handle.waitForExit();
      expect(result.timedOut).toBe(true);
      // SIGKILL came from the helper's force-kill on timeout. The
      // signal field rides through `signalNumberToName` so a regression
      // in the mapping function would surface here as numeric '9'
      // instead of 'SIGKILL'.
      expect(result.signal).toBe('SIGKILL');
      // exitCode is intentionally not asserted: node-pty's IExitEvent
      // populates exitCode even on signal termination (platform-
      // dependent — typically 0 on Darwin/Linux when SIGKILL fires
      // before any user exit() call), which doesn't match the POSIX
      // "null on signal" reading. The signal field above is the
      // load-bearing part; exitCode under signal kill is flake.
      // Screen captured everything the child wrote before it went
      // unresponsive. The sentinel is the proof.
      expect(handle.screen.contains('WEDGED-SENTINEL')).toBe(true);
    } finally {
      await handle.dispose();
    }
  }, 10_000);
});

describe.skipIf(skipOnWindows)('Layer 2 harness — signal mapping', () => {
  it('signalNumberToName maps known POSIX signals back to their names', () => {
    // The mapping is a reverse lookup over `os.constants.signals`.
    // Pin the three signals every Layer 2 scenario actually depends
    // on (SIGINT for cancellation, SIGTERM for graceful kill, SIGKILL
    // for the timeout escape path) so a future refactor of the lookup
    // can't silently coerce one to a number string.
    expect(signalNumberToName(osConstants.signals.SIGINT)).toBe('SIGINT');
    expect(signalNumberToName(osConstants.signals.SIGTERM)).toBe('SIGTERM');
    expect(signalNumberToName(osConstants.signals.SIGKILL)).toBe('SIGKILL');
  });

  it('signalNumberToName returns null when the child exited normally (no signal)', () => {
    // node-pty hands `signal: undefined` for clean exits. The mapping
    // must preserve "no signal" as null — a stringified zero would
    // make assertions like `signal === 'SIGINT'` confusing on the
    // happy-path exit branch.
    expect(signalNumberToName(undefined)).toBeNull();
  });

  it('signalNumberToName falls back to the numeric stringification for unknown codes', () => {
    // Linux real-time signals (SIGRTMIN+0 through SIGRTMIN+30) and a
    // handful of Darwin-only signals don't appear in
    // `os.constants.signals`'s reverse map. The function preserves
    // info by stringifying the code rather than throwing or returning
    // null — that's the contract scenario 18 leans on for its
    // diagnostic messages. 999 is well above any real signal number,
    // so a future Node version growing new entries won't collide.
    expect(signalNumberToName(999)).toBe('999');
  });
});
