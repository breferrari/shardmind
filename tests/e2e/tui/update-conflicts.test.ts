/**
 * Layer 2 update + SIGINT scenarios — #111 Phase 2 scenarios 14, 18.
 *
 * Two distinct concerns share this file:
 *   - 14. Multiple conflicts iterate cleanly under TTY raw mode
 *         (#109 regression — Phase 1 covers in-process; Phase 2 pins
 *         the production path under real raw-mode keystroke handling).
 *   - 18. SIGINT during the writing phase rolls back the vault.
 *         Layer-2-only — real OS SIGINT delivery via the PTY exercises
 *         the production `useSigintRollback` handler timing window.
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
import {
  buildTarballFixtures,
  cleanupTarballFixtures,
  type TarballFixtures,
} from '../helpers/tarball.js';
import { ensureBuilt } from '../helpers/build-once.js';
import {
  createInstalledVault,
  type Vault,
} from '../helpers/vault.js';
import {
  spawnCliPty,
  ENTER,
  ARROW_DOWN,
  PTY_VIEWPORT_ROWS,
} from './helpers/pty-cli.js';
import { buildMutatedShard } from './helpers/build-fixture-shard.js';
import { tick } from '../../component/helpers.js';

// Standard slugs.
const SHARD_SLUG = 'acme/demo';
const SHARD_REF = `github:${SHARD_SLUG}`;
const MULTI_CONFLICT_SLUG = 'acme/multi-conflict';
const MULTI_CONFLICT_REF = `github:${MULTI_CONFLICT_SLUG}`;

const DEFAULT_VALUES = {
  user_name: 'Alice',
  org_name: 'Acme Labs',
  vault_purpose: 'engineering',
  qmd_enabled: true,
};

let stub: GitHubStub;
let fixtures: TarballFixtures;

const skipOnWindows = process.platform === 'win32';

/**
 * v0.1.0 stays as the unmodified minimal-shard baseline; only v0.2.0
 * appends to three .njk paths so the user's bottom edits produce real
 * three-way conflicts on update. Appending to v0.1.0 too would put
 * the new line in the common ancestor and let node-diff3 auto-resolve.
 *
 * CLAUDE.md is deliberately skipped — its prose contains a literal
 * `{{ }}` token that `differ.ts::computeMergeAction`'s Nunjucks render
 * rejects on static-file conflicts (a known engine artifact,
 * sidestepped here and in Layer 1 scenario 14).
 */
async function buildMultiConflictTarball(
  version: string,
  outDir: string,
  appendLines: { home: string; northStar: string; settings: string } | null,
): Promise<string> {
  return buildMutatedShard({
    version,
    name: 'multi-conflict',
    namespace: 'l2test',
    dropHooks: true,
    prefix: `multi-conflict-${version}`,
    outDir,
    mutate: async (workDir) => {
      if (!appendLines) return;
      const append = async (rel: string, line: string): Promise<void> => {
        const abs = path.join(workDir, rel);
        const cur = await fs.readFile(abs, 'utf-8');
        await fs.writeFile(abs, `${cur}\n${line}\n`, 'utf-8');
      };
      await append('Home.md.njk', appendLines.home);
      await append('brain/North Star.md.njk', appendLines.northStar);
      await append('.claude/settings.json.njk', appendLines.settings);
    },
  });
}

describe.skipIf(skipOnWindows)(
  'update — Layer 2 PTY scenarios (#111 Phase 2)',
  () => {
    beforeAll(async () => {
      await ensureBuilt();
      fixtures = await buildTarballFixtures();
      stub = await createGitHubStub({
        shards: {
          [SHARD_SLUG]: {
            versions: {
              '0.1.0': fixtures.byVersion['0.1.0'],
              '0.2.0': fixtures.byVersion['0.2.0'],
              '0.3.0': fixtures.byVersion['0.3.0'],
            },
            latest: '0.1.0',
          },
          [MULTI_CONFLICT_SLUG]: {
            versions: {} as Record<string, string>,
            latest: '0.1.0',
          },
        },
      });
    }, 90_000);

    afterAll(async () => {
      await stub?.close();
      await cleanupTarballFixtures();
    });

    // ───── Scenario 14 — multi-file conflict iteration (#109 regression) ─────

    it(
      '14. ≥3 conflicts → DiffView iterates cleanly under TTY raw mode (#109 regression)',
      async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'l2-mc-'));
        let vault: Vault | null = null;
        try {
          // Build the 0.1.0 / 0.2.0 pair. v0.1.0 is the baseline; v0.2.0
          // appends three distinct lines to three .njk paths. The user
          // pre-edits the rendered counterparts at the same regions, so
          // each of three update paths becomes a genuine three-way
          // conflict.
          const v01 = await buildMultiConflictTarball('0.1.0', tmpDir, null);
          const v02 = await buildMultiConflictTarball('0.2.0', tmpDir, {
            home: 'v0.2.0 home append',
            northStar: 'v0.2.0 north star append',
            settings: '"v0.2.0-settings": true',
          });

          stub.setVersion(MULTI_CONFLICT_SLUG, '0.1.0', v01);
          stub.setLatest(MULTI_CONFLICT_SLUG, '0.1.0');
          vault = await createInstalledVault({
            stub,
            shardRef: MULTI_CONFLICT_REF,
            values: DEFAULT_VALUES,
            prefix: 'l2-s14',
          });

          // User edits at bottom of all three rendered files.
          await vault.writeFile(
            'Home.md',
            (await vault.readFile('Home.md')) + '\nUser bottom edit (Home).\n',
          );
          await vault.writeFile(
            'brain/North Star.md',
            (await vault.readFile('brain/North Star.md')) + '\nUser bottom edit (NS).\n',
          );
          await vault.writeFile(
            '.claude/settings.json',
            (await vault.readFile('.claude/settings.json')) + '\nUser bottom edit (settings).\n',
          );

          stub.setVersion(MULTI_CONFLICT_SLUG, '0.2.0', v02);
          stub.setLatest(MULTI_CONFLICT_SLUG, '0.2.0');

          // PTY_VIEWPORT_ROWS (50) keeps the `(N of 3)` counter on
          // screen — 80x24 scrolls it off as the diff body fills the
          // viewport.
          const handle = await spawnCliPty(['update'], {
            cwd: vault.root,
            env: { SHARDMIND_GITHUB_API_BASE: stub.url },
            rows: PTY_VIEWPORT_ROWS,
          });
          try {
            // Walk three sequential conflict prompts. The #109
            // fingerprint: iteration 2's `(2 of 3)` counter must
            // appear after iteration 1's keystroke commits. If the
            // dedup ref leaks across files, this waitForScreen times
            // out on iteration 2.
            for (let i = 1; i <= 3; i++) {
              await handle.waitForScreen(
                (s) => new RegExp(`\\(${i} of 3\\)`).test(s),
                { timeoutMs: 30_000, description: `conflict prompt (${i} of 3)` },
              );
              // ARROW_DOWN once + ENTER selects "Keep mine".
              handle.write(ARROW_DOWN);
              await tick(80);
              handle.write(ENTER);
              await tick(120);
            }

            await handle.waitForScreen(
              (s) => /Updated 0\.1\.0 → 0\.2\.0/.test(s),
              { timeoutMs: 60_000, description: 'final updated frame' },
            );

            const exit = await handle.waitForExit();
            expect(exit.exitCode).toBe(0);

            const state = JSON.parse(
              await vault.readFile('.shardmind/state.json'),
            ) as { files: Record<string, { ownership: string }> };
            expect(state.files['Home.md']?.ownership).toBe('modified');
            expect(state.files['brain/North Star.md']?.ownership).toBe(
              'modified',
            );
            expect(state.files['.claude/settings.json']?.ownership).toBe(
              'modified',
            );
          } finally {
            await handle.dispose();
          }
        } finally {
          if (vault) await vault.cleanup();
          await fs.rm(tmpDir, { recursive: true, force: true });
        }
      },
      180_000,
    );

    // ───── Scenario 18 — SIGINT mid-install rollback (L2-only) ─────

    it(
      '18. SIGINT during downloading phase → exit 130 + vault restored',
      async () => {
        // Slow the tarball stream so SIGINT lands while the engine is
        // still in the download/extract phase. Same pattern as
        // `tests/e2e/cli.test.ts:537` — a 2 s delay gives the parent
        // ~500 ms to fire SIGINT mid-flight.
        stub.setTarballDelay(2000);
        const vault = await fs.mkdtemp(
          path.join(os.tmpdir(), 'shardmind-l2-s18-'),
        );
        try {
          // Use --yes --values <file> so the install is non-interactive
          // and the only event we drive is the SIGINT itself. The PTY
          // delivers a real OS signal that the production
          // `useSigintRollback` handles; under POSIX raw mode this is
          // the same path a user pressing Ctrl+C in their terminal
          // hits.
          const valuesPath = path.join(vault, '.values.yaml');
          await fs.writeFile(valuesPath, stringifyYaml(DEFAULT_VALUES), 'utf-8');

          const handle = await spawnCliPty(
            ['install', SHARD_REF, '--yes', '--values', valuesPath],
            {
              cwd: vault,
              env: { SHARDMIND_GITHUB_API_BASE: stub.url },
            },
          );
          try {
            // 500 ms in: well before download finishes (we slowed the
            // stream to 2 s) and well before any write begins.
            await tick(500);
            handle.sigint();

            const exit = await handle.waitForExit();
            // The CLI must respond to SIGINT itself — either the
            // cancellation handler fires and exits 130, or the kernel
            // delivers the signal directly. Accepting SIGKILL would
            // mask a wedged CLI that the helper's own timeout had to
            // force-kill, defeating the point of the test.
            // `timedOut: false` AND (130 OR SIGINT) is the contract.
            expect(
              exit.timedOut,
              `waitForExit timed out — CLI didn't respond to SIGINT. exitCode=${exit.exitCode} signal=${exit.signal} screen:\n${handle.screen.serialize()}`,
            ).toBe(false);
            const exitOk =
              exit.exitCode === 130 || exit.signal === 'SIGINT';
            expect(
              exitOk,
              `exitCode=${exit.exitCode} signal=${exit.signal} screen:\n${handle.screen.serialize()}`,
            ).toBe(true);

            // Vault invariant: no engine metadata, no rendered files,
            // no leftover backups. The values file we wrote ourselves
            // is fine — that's pre-install user content.
            const stateExists = await fs
              .stat(path.join(vault, '.shardmind'))
              .then(() => true)
              .catch(() => false);
            expect(stateExists).toBe(false);
            const homeExists = await fs
              .stat(path.join(vault, 'Home.md'))
              .then(() => true)
              .catch(() => false);
            expect(homeExists).toBe(false);
          } finally {
            await handle.dispose();
          }
        } finally {
          stub.setTarballDelay(0);
          await fs.rm(vault, { recursive: true, force: true });
        }
      },
      60_000,
    );
  },
);
