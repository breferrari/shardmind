/**
 * Smoke tests for the Layer 1 flow harness.
 *
 * Pins the wiring (env-var, cwd spy, suite teardown, custom-tarball
 * builder) so the larger scenario files in this directory can rely on
 * the harness staying coherent. A regression in the harness should
 * surface here, not as a flake in `install-flow.test.tsx` ten frames
 * deep.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup } from 'ink-testing-library';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  setupFlowSuite,
  mountInstall,
  mountStatus,
  makeVaultDir,
  cleanupVault,
  buildCustomTarball,
  SHARD_SLUG,
  STUB_SHA,
} from './helpers.js';
import { tick, waitFor } from '../helpers.js';

describe('flow harness', () => {
  const getCtx = setupFlowSuite({
    shards: {
      [SHARD_SLUG]: {
        versions: {} as Record<string, string>,
        latest: '0.1.0',
      },
    },
  });

  afterEach(() => {
    cleanup();
  });

  it('routes the install command through the github-stub (no public network)', async () => {
    const { stub, fixtures } = getCtx();
    const tar = fixtures.byVersion['0.1.0'];
    expect(tar).toBeTruthy();

    const vault = await makeVaultDir('harness-route');
    try {
      // Register a `#main` ref → tarball mapping. Reaching the wizard
      // frame after mount proves the registry call hit the stub —
      // otherwise `resolve()` would have thrown a network error long
      // before any frame rendered.
      stub.setRef(SHARD_SLUG, 'main', STUB_SHA, tar!);
      const r = mountInstall({
        shardRef: `github:${SHARD_SLUG}#main`,
        vaultRoot: vault,
      });
      // 15 s timeout (vs waitFor's 2 s default) because the install
      // pipeline under parallel test load (resolve → download →
      // parse) routinely exceeds 2 s on CPU-contended workers — the
      // scenario tests bump the wizard-header waitFor for the same
      // reason (see `driveMinimalWizard`).
      await waitFor(
        r.lastFrame,
        (f) => /questions to answer|Choose modules|Ready to install/.test(f),
        15_000,
      );
    } finally {
      await cleanupVault(vault);
    }
  }, 30_000);

  it('points process.cwd() at the test vault root for the duration of the mount', async () => {
    const vault = await makeVaultDir('harness-cwd');
    try {
      const r = mountStatus({ vaultRoot: vault });
      // Status command wakes up, sees no `.shardmind/`, renders the
      // not-in-vault message. If cwd weren't pointed at our temp dir,
      // the status command would walk up looking for ANY .shardmind in
      // the ancestor chain and either find nothing (same outcome,
      // accidentally) OR find the repo's own .shardmind during a dev
      // run with one present. Asserting on the temp-dir-specific copy
      // would be brittle; instead we assert on the rendered output
      // shape, which IS deterministic given the cwd spy.
      await waitFor(r.lastFrame, (f) => f.includes('Not in a shard-managed vault'));
    } finally {
      await cleanupVault(vault);
    }
  }, 15_000);

  it('stub.setVersion throws on unknown shard slug', () => {
    const { stub } = getCtx();
    // Mirrors setLatest / setRef's unknown-slug guards. Pinned so a
    // typo'd slug in a future scenario surfaces as a clear test-time
    // error instead of a silent 404 from the stub's tarball endpoint
    // (which would manifest as "download failed" 30 seconds later).
    expect(() =>
      stub.setVersion('acme/does-not-exist', '0.1.0', '/dev/null'),
    ).toThrow(/unknown shard/);
  });

  it('builds a custom tarball with overridden schema + manifest', async () => {
    const vault = await makeVaultDir('harness-custom-tar');
    try {
      const tarPath = await buildCustomTarball({
        version: '9.9.9',
        schema: {
          schema_version: 1,
          values: {
            user_name: { type: 'string', required: true, message: 'Name', default: '', group: 'g' },
          },
          groups: [{ id: 'g', label: 'G' }],
          modules: { core: { label: 'Core', paths: ['core/'], removable: false } },
          signals: [],
          frontmatter: {},
          migrations: [],
        },
        manifestOverrides: { hooks: {} },
        outDir: vault,
        prefix: 'minimal-shard-9.9.9',
      });
      // Tarball should exist and be non-empty.
      const stat = await fs.stat(tarPath);
      expect(stat.isFile()).toBe(true);
      expect(stat.size).toBeGreaterThan(0);
      expect(path.basename(tarPath)).toBe('minimal-shard-9.9.9.tar.gz');

      // Tick once so the gzip stream is fully closed before afterEach
      // tries to clean up the parent dir.
      await tick(10);
    } finally {
      await cleanupVault(vault);
    }
  }, 30_000);
});
