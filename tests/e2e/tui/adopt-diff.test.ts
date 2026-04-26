/**
 * Layer 2 adopt scenario — #111 Phase 2 scenario 20.
 *
 * `≥3 differing files → AdoptDiffView iterates each` — direct #109
 * regression on the adopt flow under PTY raw mode. Layer 1 covers the
 * iteration shape in-process; Layer 2 pins it under the actual TTY
 * surface, the way real users hit it.
 *
 * Skipped on Windows: PTY semantics + cancellation bridge mismatch (#57).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

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
  spawnCliPty,
  ENTER,
  PTY_VIEWPORT_ROWS,
  driveMinimalWizard,
} from './helpers/pty-cli.js';
import { tick } from '../../component/helpers.js';

const SHARD_SLUG = 'acme/demo';
const SHARD_REF = `github:${SHARD_SLUG}`;
const STUB_SHA = 'a'.repeat(40);

let stub: GitHubStub;
let fixtures: TarballFixtures;

const skipOnWindows = process.platform === 'win32';

async function writeRel(root: string, rel: string, body: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body, 'utf-8');
}

describe.skipIf(skipOnWindows)(
  'adopt — Layer 2 PTY scenarios (#111 Phase 2)',
  () => {
    beforeAll(async () => {
      await ensureBuilt();
      fixtures = await buildTarballFixtures();
      stub = await createGitHubStub({
        shards: {
          [SHARD_SLUG]: {
            versions: {
              '0.1.0': fixtures.byVersion['0.1.0'],
            },
            latest: '0.1.0',
            // Pin v0.1.0 to a known SHA so the ref-install path is
            // deterministic — same shape Layer 1's scenario 20 uses.
            refs: { 'v0.1.0': STUB_SHA },
            shaTarballs: { [STUB_SHA]: fixtures.byVersion['0.1.0'] },
          },
        },
      });
    }, 90_000);

    afterAll(async () => {
      await stub?.close();
      await cleanupTarballFixtures();
    });

    // ───── Scenario 20 — multi-file adopt iteration (#109 regression) ─────

    it(
      '20. ≥3 differing files → AdoptDiffView iterates cleanly under TTY raw mode (#109 regression)',
      async () => {
        const vault = await fs.mkdtemp(
          path.join(os.tmpdir(), 'shardmind-l2-s20-'),
        );
        try {
          // Pre-populate three shard-path files with content that
          // diverges from the rendered shard. Each path is a
          // renderable .njk in the shard, so the planner classifies
          // each as `differs` — three sequential AdoptDiffView prompts.
          await writeRel(
            vault,
            'Home.md',
            '# user-only Home content\nLine A\nLine B\n',
          );
          await writeRel(
            vault,
            'brain/North Star.md',
            '# user-only North Star\nLine X\nLine Y\n',
          );
          await writeRel(
            vault,
            '.claude/settings.json',
            '{ "user-only": true, "no": "match" }\n',
          );

          // Pin to v0.1.0 via the SHA-routed ref path so the wizard
          // resolves quickly and the planner runs against a known
          // tarball.
          const handle = await spawnCliPty(['adopt', `${SHARD_REF}#v0.1.0`], {
            cwd: vault,
            env: { SHARDMIND_GITHUB_API_BASE: stub.url },
            rows: PTY_VIEWPORT_ROWS,
          });
          try {
            await driveMinimalWizard(handle);
            handle.write(ENTER); // commit at confirm

            // Walk three sequential AdoptDiffView prompts. ENTER
            // alone selects "Keep mine" (first option). The #109
            // fingerprint: iteration 2's `(2 of 3)` counter must
            // appear after iteration 1's commit. Layer 2 surfaces a
            // raw-mode-specific failure shape that Layer 1's faked
            // raw mode can't.
            for (let i = 1; i <= 3; i++) {
              await handle.waitForScreen(
                (s) => new RegExp(`\\(${i} of 3\\)`).test(s),
                {
                  timeoutMs: 30_000,
                  description: `adopt diff prompt (${i} of 3)`,
                },
              );
              handle.write(ENTER);
              await tick(120);
            }

            await handle.waitForScreen(
              (s) => /Adopted shardmind\/minimal/.test(s),
              { timeoutMs: 60_000, description: 'final adopted summary' },
            );

            const exit = await handle.waitForExit();
            expect(exit.exitCode).toBe(0);

            // Vault is now managed — engine metadata in place.
            const stateExists = await fs
              .stat(path.join(vault, '.shardmind', 'state.json'))
              .then((s) => s.isFile())
              .catch(() => false);
            expect(stateExists).toBe(true);
          } finally {
            await handle.dispose();
          }
        } finally {
          await fs.rm(vault, { recursive: true, force: true });
        }
      },
      180_000,
    );
  },
);
