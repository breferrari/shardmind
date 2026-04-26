/**
 * Layer 2 install-wizard scenarios — #111 Phase 2 scenarios 1, 9, 11.
 *
 * Drives the install wizard end-to-end inside a real PTY so the
 * production raw-mode keystroke handlers (`@inkjs/ui` Select / TextInput,
 * `useInput`) run against actual TTY semantics. Layer 1's in-process
 * mount fakes raw mode; this layer is the ground truth.
 *
 * Scenarios:
 *   - 1  — select default = first option → Enter advances (#103 regression)
 *   - 9  — full happy path → vault written + Summary frame
 *   - 11 — Confirm → Cancel → no vault writes
 *
 * Each test owns its own vault tempdir and runs against a shared
 * github-stub serving the standard minimal-shard fixtures. Skipped on
 * Windows: ConPTY divergence + cancellation bridge mismatch (#57).
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
  ARROW_DOWN,
  driveMinimalWizard,
} from './helpers/pty-cli.js';

const SHARD_SLUG = 'acme/demo';
const SHARD_REF = `github:${SHARD_SLUG}`;

let stub: GitHubStub;
let fixtures: TarballFixtures;
const tempVaults: string[] = [];

const skipOnWindows = process.platform === 'win32';

async function makeVault(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), `shardmind-l2-install-${prefix}-`),
  );
  tempVaults.push(root);
  return root;
}

async function cleanupVaults(): Promise<void> {
  while (tempVaults.length > 0) {
    const root = tempVaults.pop();
    if (!root) continue;
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

describe.skipIf(skipOnWindows)(
  'install — Layer 2 PTY scenarios (#111 Phase 2)',
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
          },
        },
      });
    }, 90_000);

    afterAll(async () => {
      await stub?.close();
      await cleanupTarballFixtures();
      await cleanupVaults();
    });

    // ───── Scenario 1 — select default=first option, Enter advances ─────

    it(
      '1. select default = first option → Enter advances under TTY (#103 regression)',
      async () => {
        const vault = await makeVault('s1');
        const handle = await spawnCliPty(['install', SHARD_REF], {
          cwd: vault,
          env: { SHARDMIND_GITHUB_API_BASE: stub.url },
        });
        try {
          // The #103 fingerprint sits inside `driveMinimalWizard` —
          // step 3 (vault_purpose select with default = first option:
          // engineering) presses ENTER on a pre-positioned cursor,
          // which must advance rather than re-render. Under PTY raw
          // mode, this is the actual production path the bug shipped
          // against; if the helper times out at any internal step, the
          // regression is back.
          await driveMinimalWizard(handle);
          handle.write(ENTER); // commit at confirm

          await handle.waitForScreen(
            (s) => /Installed shardmind\/minimal@0\.1\.0/.test(s),
            { timeoutMs: 30_000, description: 'final install summary' },
          );

          const exit = await handle.waitForExit();
          expect(exit.exitCode).toBe(0);

          const stateExists = await fs
            .stat(path.join(vault, '.shardmind', 'state.json'))
            .then((s) => s.isFile())
            .catch(() => false);
          expect(stateExists).toBe(true);
        } finally {
          await handle.dispose();
        }
      },
      90_000,
    );

    // ───── Scenario 9 — full happy path → Summary ─────

    it(
      '9. full happy path → Summary frame contains shard slug + version',
      async () => {
        const vault = await makeVault('s9');
        const handle = await spawnCliPty(['install', SHARD_REF], {
          cwd: vault,
          env: { SHARDMIND_GITHUB_API_BASE: stub.url },
        });
        try {
          await driveMinimalWizard(handle, 'Dana');
          handle.write(ENTER); // commit at confirm

          await handle.waitForScreen(
            (s) => /Installed shardmind\/minimal@0\.1\.0/.test(s),
            { timeoutMs: 30_000, description: 'final summary' },
          );

          const exit = await handle.waitForExit();
          expect(exit.exitCode).toBe(0);

          // Vault was actually written + persona-driven content
          // landed under the user's typed name.
          const valuesYaml = await fs.readFile(
            path.join(vault, 'shard-values.yaml'),
            'utf-8',
          );
          expect(valuesYaml).toContain('Dana');
          const stateExists = await fs
            .stat(path.join(vault, '.shardmind', 'state.json'))
            .then((s) => s.isFile())
            .catch(() => false);
          expect(stateExists).toBe(true);
        } finally {
          await handle.dispose();
        }
      },
      90_000,
    );

    // ───── Scenario 11 — Confirm → Cancel → no vault writes ─────

    it(
      '11. Confirm → Cancel → no vault writes (no .shardmind/, no rendered files)',
      async () => {
        const vault = await makeVault('s11');
        const handle = await spawnCliPty(['install', SHARD_REF], {
          cwd: vault,
          env: { SHARDMIND_GITHUB_API_BASE: stub.url },
        });
        try {
          await driveMinimalWizard(handle, 'Eve');

          // Confirm Select options: [Install, Back to module review,
          // Cancel]. Two ARROW_DOWN advances + Enter selects Cancel.
          handle.write(ARROW_DOWN);
          handle.write(ARROW_DOWN);
          handle.write(ENTER);

          await handle.waitForScreen(
            (s) => s.toLowerCase().includes('cancelled'),
            { timeoutMs: 15_000, description: 'cancelled banner' },
          );

          const exit = await handle.waitForExit();
          expect(exit.exitCode).toBe(0);

          // Vault must be untouched: no engine metadata, no rendered
          // content, no values file. The cancel branch returns from
          // the wizard before any write phase begins.
          const [stateExists, homeExists, valuesExists] = await Promise.all([
            fs.stat(path.join(vault, '.shardmind')).then(() => true).catch(() => false),
            fs.stat(path.join(vault, 'Home.md')).then(() => true).catch(() => false),
            fs.stat(path.join(vault, 'shard-values.yaml')).then(() => true).catch(() => false),
          ]);
          expect(stateExists).toBe(false);
          expect(homeExists).toBe(false);
          expect(valuesExists).toBe(false);
        } finally {
          await handle.dispose();
        }
      },
      90_000,
    );
  },
);
