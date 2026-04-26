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
import fs from 'node:fs/promises';
import path from 'node:path';
import { constants as osConstants } from 'node:os';
import os from 'node:os';
import { parse as parseYaml } from 'yaml';
import { unpackInto } from '../helpers/tarball-utils.js';
import { createVirtualScreen } from './helpers/virtual-screen.js';
import {
  spawnCliPty,
  signalNumberToName,
  ENTER,
} from './helpers/pty-cli.js';
import {
  buildHookFixtureShard,
  buildMutatedShard,
  FIXTURE_TMP_PREFIX,
} from './helpers/build-fixture-shard.js';

const skipOnWindows = process.platform === 'win32';

/**
 * Poll `process.kill(pid, 0)` until the kernel reports the process as
 * gone (ESRCH). Returns true if reaped within `timeoutMs`, false on
 * timeout. The 0 signal is a permissions/existence probe — it doesn't
 * actually deliver a signal, just throws ESRCH when the pid no longer
 * names a live process.
 *
 * Used by the wedged-child harness test to verify the helper's
 * force-kill path actually unwedges the child, separately from the
 * `waitForExit` return shape (which can synthesize SIGKILL on grace-
 * window expiry whether or not the kill landed).
 */
async function waitForReaped(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return true;
      // EPERM means the pid exists but we can't signal it. Treat as
      // alive — relevant only if a privilege-dropping shell ran the
      // test, which doesn't apply here, but pinning the predicate
      // avoids surprises.
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

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
    //
    // First dispose kills + drains (exit fires within ~200ms);
    // second dispose hits the `exitInfo !== null` early-return.
    // Skipping `waitForExit` saves the spawn-to-`--version`-exit
    // wall-clock without changing what's pinned.
    const handle = await spawnCliPty(['--version'], {
      cwd: os.tmpdir(),
    });
    await handle.dispose();
    await expect(handle.dispose()).resolves.toBeUndefined();
  }, 30_000);

  it('waitForExit on a wedged child force-kills the process and reaps it', async () => {
    // Spawn a node child that wedges in `setInterval` — uncatchable
    // SIGKILL is the only way to free the worker slot. Use `nodeArgs`
    // to bypass the CLI; we're testing the helper, not the product.
    // `timeoutMs: 1500` bounds the test; the helper grants a 200 ms
    // grace for SIGKILL to be reaped after firing.
    //
    // The contract pinned: the helper's timeout branch ACTUALLY
    // delivers SIGKILL and the child is gone after `waitForExit`
    // returns. `result.signal === 'SIGKILL'` alone is insufficient —
    // the synthetic-grace branch at `pty-cli.ts:386` returns that
    // shape unconditionally, so an audit-mutation that removes the
    // `pty.kill('SIGKILL')` line at line 369 would still pass on
    // signal+timedOut alone. `process.kill(pid, 0)` is the real
    // contract: ESRCH means the kernel has reaped the process, which
    // happens iff SIGKILL was actually delivered.
    const childScript =
      'process.stdout.write("WEDGED-SENTINEL\\n"); ' +
      'setInterval(() => {}, 1e9);';
    const handle = await spawnCliPty([], {
      cwd: os.tmpdir(),
      timeoutMs: 1500,
      nodeArgs: ['-e', childScript],
    });
    try {
      // Pre-check: confirm the sentinel arrived through the PTY before
      // we enter the timeout dance. Without this, a slow node cold-
      // start under heavy parallel pressure could collide with the
      // 1500ms window and the post-test sentinel assertion would
      // fail-flake. The waitForScreen guarantees the child started
      // and is now wedged in `setInterval`.
      await handle.waitForScreen(
        (s) => s.includes('WEDGED-SENTINEL'),
        { timeoutMs: 5_000, description: 'wedged-child sentinel' },
      );

      const result = await handle.waitForExit();
      expect(result.timedOut).toBe(true);
      expect(result.signal).toBe('SIGKILL');

      // The load-bearing assertion: the child must actually be reaped.
      // Retry briefly because POSIX makes no hard guarantee about how
      // quickly the kernel reflects a SIGKILL'd process as ESRCH after
      // `pty.kill` returns. The 200ms grace inside `waitForExit`
      // already gave the kernel time to do this; this loop is a final
      // 500ms safety belt for very contended runners.
      const reaped = await waitForReaped(handle.pid, 500);
      expect(
        reaped,
        `child pid ${handle.pid} still alive ${500}ms after waitForExit returned timedOut — force-kill did not land`,
      ).toBe(true);
    } finally {
      await handle.dispose();
    }
  }, 10_000);

  it('PtyHandle.dispose() is idempotent after a timeout (wedged-child path)', async () => {
    // Companion to the clean-exit idempotency test above. The dangerous
    // path is when `waitForExit` returned a synthetic SIGKILL because
    // the grace window expired before `pty.onExit` fired. In that
    // shape `exitInfo` may still be null when `dispose` runs, so the
    // dispose-level early-return doesn't fire and the second dispose
    // re-enters the kill+drain. The first dispose's drain timer
    // already cleared, so the second's drain race is between an
    // already-resolved `exitPromise` and a fresh 200ms timer — both
    // safe, but only if neither path throws.
    const childScript = 'setInterval(() => {}, 1e9);';
    const handle = await spawnCliPty([], {
      cwd: os.tmpdir(),
      timeoutMs: 800,
      nodeArgs: ['-e', childScript],
    });
    try {
      await handle.waitForExit();
      await handle.dispose();
      await expect(handle.dispose()).resolves.toBeUndefined();
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

describe.skipIf(skipOnWindows)('Layer 2 harness — fixture builders', () => {
  it('buildHookFixtureShard honors name + namespace overrides', async () => {
    // Hook scenarios assert against the Summary frame, which prints
    // `<namespace>/<name>@<version>`. Without per-fixture identity,
    // every hook scenario's Summary would render `shardmind/minimal`
    // and assertions for distinct slugs would fail. Pin the override
    // path here so a future refactor of `cloneAndPack`'s manifest
    // write can't silently drop one of the fields.
    const outDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'shardmind-fixture-name-test-'),
    );
    try {
      const tarPath = await buildHookFixtureShard({
        version: '0.1.0',
        name: 'phase3-named-shard',
        namespace: 'l2test',
        prefix: 'phase3-named-shard-0.1.0',
        outDir,
        hookSource: 'export default async () => {};',
      });
      // `unpackInto` strips the top-level prefix dir (matches the
      // engine's own `tar.x({ strip: 1 })` extraction path), so the
      // manifest lands directly under `<extractDir>/.shardmind/`.
      const extractDir = path.join(outDir, 'extract');
      await unpackInto(tarPath, extractDir);
      const manifest = parseYaml(
        await fs.readFile(
          path.join(extractDir, '.shardmind', 'shard.yaml'),
          'utf-8',
        ),
      ) as Record<string, unknown>;
      expect(manifest.name).toBe('phase3-named-shard');
      expect(manifest.namespace).toBe('l2test');
      expect(manifest.version).toBe('0.1.0');
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('buildMutatedShard cleans the tmp clone dir if mutate throws', async () => {
    // A future contributor's mutate callback may panic during scenario
    // shake-out. The helper's try/finally must keep the filesystem
    // tidy — otherwise `/tmp` accumulates `shardmind-fixture-*` clones
    // until the dev box rebuilds. Use a unique version stamp so this
    // test's signature doesn't collide with leftover dirs from prior
    // runs. The exported `FIXTURE_TMP_PREFIX` keeps the assertion's
    // glob in sync with the helper's `mkdtemp` so a future rename
    // breaks both at once.
    const outDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'shardmind-fixture-throw-out-'),
    );
    const uniqueVersion = '0.0.0-mutate-throw-test';
    const orphanPrefix = `${FIXTURE_TMP_PREFIX}${uniqueVersion}-`;
    try {
      // Pre-clean any orphans left by a prior run that detected this
      // exact regression and surfaced it. Without this, the test
      // sticks-fail across runs after the first true positive: the
      // test discovers the orphan, the assertion fails, the dev fixes
      // the helper, but the orphan from the prior failing run is
      // still on disk and the test keeps reporting non-empty until a
      // manual cleanup. Running the cleanup at the top makes the
      // assertion deterministic across runs.
      for (const stale of (await fs.readdir(os.tmpdir())).filter((n) =>
        n.startsWith(orphanPrefix),
      )) {
        await fs.rm(path.join(os.tmpdir(), stale), {
          recursive: true,
          force: true,
        });
      }

      // Force the throw from inside the try block by flipping a flag
      // before throwing — pinned afterwards. Without the flag, a
      // future refactor that moves `mkdtemp` out of the try (or wraps
      // the build in a precondition check that throws BEFORE entering
      // the try) would still pass this test even though `mutate`
      // never ran.
      let mutateRan = false;
      await expect(
        buildMutatedShard({
          version: uniqueVersion,
          prefix: `mutate-throw-${uniqueVersion}`,
          outDir,
          dropHooks: true,
          mutate: async () => {
            mutateRan = true;
            throw new Error('intentional-mutate-throw');
          },
        }),
      ).rejects.toThrow('intentional-mutate-throw');
      expect(mutateRan).toBe(true);

      const orphans = (await fs.readdir(os.tmpdir())).filter((n) =>
        n.startsWith(orphanPrefix),
      );
      expect(orphans).toEqual([]);
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  }, 30_000);
});
