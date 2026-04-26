/**
 * Layer 2 hook lifecycle scenarios — #111 Phase 2 scenarios 26, 27, 28.
 *
 * Three flavors of post-install hook behavior:
 *   - 26. Hook prints to stdout → live tail visible during the
 *         `running-hook` phase.
 *   - 27. Hook throws → Summary shows non-fatal warning + captured
 *         stderr (install itself succeeded).
 *   - 28. Hook timeout (manifest `timeout_ms: 1000` + a 5s sleep
 *         hook) → Summary shows "timed out after 1.0s".
 *
 * Each scenario builds its own custom-tarball derived from
 * `examples/minimal-shard` with a hand-rolled `hooks/post-install.ts`
 * via the shared `buildHookFixtureShard` helper. Install is driven
 * via `--yes --values <file>` so the only event we drive is whatever
 * the scenario actually exercises in the hook phase.
 *
 * Skipped on Windows: PTY semantics + cancellation bridge mismatch (#57).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { stringify as stringifyYaml } from 'yaml';

import {
  createGitHubStub,
  type GitHubStub,
} from '../helpers/github-stub.js';
import { ensureBuilt } from '../helpers/build-once.js';
import { spawnCliPty } from './helpers/pty-cli.js';
import { buildHookFixtureShard } from './helpers/build-fixture-shard.js';

const STDOUT_SLUG = 'l2hooks/stdout';
const THROW_SLUG = 'l2hooks/throw';
const TIMEOUT_SLUG = 'l2hooks/timeout';

const DEFAULT_VALUES = {
  user_name: 'Alice',
  org_name: 'Acme Labs',
  vault_purpose: 'engineering',
  qmd_enabled: true,
};

const skipOnWindows = process.platform === 'win32';

// Stable marker the stdout scenario greps for. Picked to be obviously
// not anywhere in the engine's normal output so a false-positive match
// against unrelated UI text is impossible.
const LIVE_TAIL_MARKER = 'L2_HOOK_LIVE_TAIL_MARKER_2026';

let stub: GitHubStub;
let scratch: string;

describe.skipIf(skipOnWindows)(
  'hook lifecycle — Layer 2 PTY scenarios (#111 Phase 2)',
  () => {
    beforeAll(async () => {
      await ensureBuilt();
      scratch = await fs.mkdtemp(
        path.join(os.tmpdir(), 'shardmind-l2-hooks-'),
      );

      // Hook 26 — prints a marker line, sleeps so the running-hook
      // phase has a window to render, prints another line, exits 0.
      // The sleep is what gives the test a deterministic frame to
      // assert against during `running-hook`; without it, the hook
      // completes faster than waitForScreen's poll cadence.
      const stdoutHookSrc = [
        'export default async function (_ctx) {',
        `  console.log('${LIVE_TAIL_MARKER}');`,
        '  await new Promise((r) => setTimeout(r, 1500));',
        `  console.log('${LIVE_TAIL_MARKER}_DONE');`,
        '}',
        '',
      ].join('\n');

      // Hook 27 — synchronously throws. Node propagates the throw to
      // the runner, which prints the stack to stderr and exits non-zero.
      // The captured stderr should land in HookSummarySection's
      // `Hook stderr:` block under a yellow warning headline.
      const throwHookSrc = [
        'export default async function (_ctx) {',
        "  throw new Error('L2_HOOK_THROW_BANG');",
        '}',
        '',
      ].join('\n');

      // Hook 28 — sleeps far longer than the manifest's `timeout_ms`.
      // The engine SIGTERMs after 1 s and SIGKILLs after a 2 s grace,
      // so total runtime is bounded ~3 s. Result-decision order in
      // `executeHook` puts `timedOut` before exit-code, so the
      // Summary's stderr starts with `hook timed out after 1.0s`.
      const timeoutHookSrc = [
        'export default async function (_ctx) {',
        '  await new Promise((r) => setTimeout(r, 5000));',
        '}',
        '',
      ].join('\n');

      // Each fixture overrides name/namespace so the rendered Summary
      // names the scenario's shard rather than minimal-shard's
      // `shardmind/minimal` identity (the manifest's default).
      const stdoutTar = await buildHookFixtureShard({
        version: '0.1.0',
        prefix: 'l2hooks-stdout-0.1.0',
        outDir: scratch,
        hookSource: stdoutHookSrc,
        namespace: 'l2hooks',
        name: 'stdout',
      });
      const throwTar = await buildHookFixtureShard({
        version: '0.1.0',
        prefix: 'l2hooks-throw-0.1.0',
        outDir: scratch,
        hookSource: throwHookSrc,
        namespace: 'l2hooks',
        name: 'throw',
      });
      const timeoutTar = await buildHookFixtureShard({
        version: '0.1.0',
        prefix: 'l2hooks-timeout-0.1.0',
        outDir: scratch,
        hookSource: timeoutHookSrc,
        hookTimeoutMs: 1000,
        namespace: 'l2hooks',
        name: 'timeout',
      });

      stub = await createGitHubStub({
        shards: {
          [STDOUT_SLUG]: { versions: { '0.1.0': stdoutTar }, latest: '0.1.0' },
          [THROW_SLUG]: { versions: { '0.1.0': throwTar }, latest: '0.1.0' },
          [TIMEOUT_SLUG]: {
            versions: { '0.1.0': timeoutTar },
            latest: '0.1.0',
          },
        },
      });
    }, 90_000);

    afterAll(async () => {
      await stub?.close();
      if (scratch) {
        await fs.rm(scratch, { recursive: true, force: true });
      }
    });

    // ───── Scenario 26 — hook stdout live tail ─────

    it(
      '26. hook stdout → live tail visible during running-hook phase + Summary',
      async () => {
        const vault = await fs.mkdtemp(
          path.join(os.tmpdir(), 'shardmind-l2-s26-'),
        );
        try {
          const valuesPath = path.join(vault, '.values.yaml');
          await fs.writeFile(valuesPath, stringifyYaml(DEFAULT_VALUES), 'utf-8');

          const handle = await spawnCliPty(
            [
              'install',
              `github:${STDOUT_SLUG}`,
              '--yes',
              '--values',
              valuesPath,
            ],
            {
              cwd: vault,
              env: { SHARDMIND_GITHUB_API_BASE: stub.url },
              rows: 50,
            },
          );
          try {
            // Live tail: the marker should appear DURING the
            // running-hook phase, before the Summary frame swaps in.
            // The hook sleeps 1.5s after the first print, so this
            // poll has a comfortable window to catch it.
            await handle.waitForScreen(
              (s) => s.includes(LIVE_TAIL_MARKER),
              {
                timeoutMs: 30_000,
                description: 'live tail marker mid-hook',
              },
            );

            // Final Summary: hook completed cleanly + captured
            // stdout block names both marker lines.
            await handle.waitForScreen(
              (s) =>
                s.includes('Post-install hook completed') &&
                s.includes(`${LIVE_TAIL_MARKER}_DONE`),
              {
                timeoutMs: 30_000,
                description: 'final summary with completed hook',
              },
            );

            const exit = await handle.waitForExit();
            expect(exit.exitCode).toBe(0);
          } finally {
            handle.kill();
          }
        } finally {
          await fs.rm(vault, { recursive: true, force: true });
        }
      },
      90_000,
    );

    // ───── Scenario 27 — hook throws → non-fatal warning ─────

    it(
      '27. hook throws → Summary shows warning + captured stderr (install succeeded)',
      async () => {
        const vault = await fs.mkdtemp(
          path.join(os.tmpdir(), 'shardmind-l2-s27-'),
        );
        try {
          const valuesPath = path.join(vault, '.values.yaml');
          await fs.writeFile(valuesPath, stringifyYaml(DEFAULT_VALUES), 'utf-8');

          const handle = await spawnCliPty(
            [
              'install',
              `github:${THROW_SLUG}`,
              '--yes',
              '--values',
              valuesPath,
            ],
            {
              cwd: vault,
              env: { SHARDMIND_GITHUB_API_BASE: stub.url },
              rows: 50,
            },
          );
          try {
            // The Summary must say:
            //   - "Installed l2hooks/throw@0.1.0" — install itself
            //     succeeded (Helm semantics: hook is non-fatal).
            //   - "Post-install hook exited with code <N>" — the
            //     warning headline from HookSummarySection.
            //   - the thrown message (or its stderr trail) somewhere
            //     in the captured stderr block.
            await handle.waitForScreen(
              (s) =>
                /Installed l2hooks\/throw@0\.1\.0/.test(s) &&
                /Post-install hook exited with code/.test(s),
              {
                timeoutMs: 30_000,
                description: 'install summary + hook warning',
              },
            );
            const screen = handle.screen.serialize();
            // The thrown error string ("L2_HOOK_THROW_BANG") lands in
            // stderr via Node's default uncaught-error printer; under
            // PTY's 50-row viewport it surfaces in the Hook stderr
            // section.
            expect(screen).toMatch(/L2_HOOK_THROW_BANG/);

            const exit = await handle.waitForExit();
            // Install itself succeeded — exit 0 even though hook
            // failed (the contract).
            expect(exit.exitCode).toBe(0);
          } finally {
            handle.kill();
          }
        } finally {
          await fs.rm(vault, { recursive: true, force: true });
        }
      },
      90_000,
    );

    // ───── Scenario 28 — hook timeout → "timed out after Xs" ─────

    it(
      '28. hook timeout → Summary shows "timed out after Xs" warning',
      async () => {
        const vault = await fs.mkdtemp(
          path.join(os.tmpdir(), 'shardmind-l2-s28-'),
        );
        try {
          const valuesPath = path.join(vault, '.values.yaml');
          await fs.writeFile(valuesPath, stringifyYaml(DEFAULT_VALUES), 'utf-8');

          const handle = await spawnCliPty(
            [
              'install',
              `github:${TIMEOUT_SLUG}`,
              '--yes',
              '--values',
              valuesPath,
            ],
            {
              cwd: vault,
              env: { SHARDMIND_GITHUB_API_BASE: stub.url },
              rows: 50,
            },
          );
          try {
            // 30s timeout is comfortable: hook timeout = 1s + KILL_GRACE
            // = 2s + Summary render. Total ~4s on a healthy machine,
            // up to ~10s under parallel pressure.
            await handle.waitForScreen(
              (s) =>
                /Installed l2hooks\/timeout@0\.1\.0/.test(s) &&
                /timed out after 1\.0s/.test(s),
              {
                timeoutMs: 30_000,
                description: 'summary with timeout warning',
              },
            );

            const exit = await handle.waitForExit();
            expect(exit.exitCode).toBe(0);
          } finally {
            handle.kill();
          }
        } finally {
          await fs.rm(vault, { recursive: true, force: true });
        }
      },
      60_000,
    );
  },
);
