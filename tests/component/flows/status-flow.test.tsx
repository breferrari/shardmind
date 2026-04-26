/**
 * Layer 1 status command flow tests — scenarios 24-25 of [#111](https://github.com/breferrari/shardmind/issues/111) Phase 1.
 *
 * The status command is read-only: no stdin driving needed. We just
 * mount, wait for the rendered frame, and assert on its shape. Both
 * scenarios run against an installed vault (createInstalledVault) so
 * the views have real data to display.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup } from 'ink-testing-library';

import { setupFlowSuite, mountStatus } from './helpers.js';
import { waitFor } from '../helpers.js';
import { createInstalledVault, type Vault } from '../../e2e/helpers/vault.js';

const SHARD_SLUG = 'acme/demo';
const SHARD_REF = `github:${SHARD_SLUG}`;

const DEFAULT_VALUES = {
  user_name: 'Alice',
  org_name: 'Acme Labs',
  vault_purpose: 'engineering',
  qmd_enabled: true,
};

describe('status command — Layer 1 flow tests (#111 Phase 1, scenarios 24-25)', () => {
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

  // ───── Scenario 24: default `shardmind` → StatusView renders ─────

  it('24. default `shardmind` → StatusView renders shard + version + drift summary', async () => {
    const { stub, fixtures } = getCtx();
    stub.setVersion(SHARD_SLUG, '0.1.0', fixtures.byVersion['0.1.0']!);
    stub.setLatest(SHARD_SLUG, '0.1.0');
    let vault: Vault | null = null;
    try {
      vault = await createInstalledVault({
        stub,
        shardRef: SHARD_REF,
        values: DEFAULT_VALUES,
        prefix: 's24-status-quick',
      });
      const r = mountStatus({ vaultRoot: vault.root });
      // Quick view shows: header (namespace/name + version), installed
      // line (managed file count), and one of the three update states.
      // Use the frame waitFor returns rather than reading r.lastFrame()
      // after it returns — the status command calls `useApp().exit()`
      // 50 ms after rendering, which clears the testing-library buffer.
      const frame = await waitFor(
        r.lastFrame,
        (f) => /shardmind\/minimal/.test(f) && /managed file/.test(f),
        15_000,
      );
      expect(frame).toMatch(/v0\.1\.0/);
      // Drift counts. `0 modified` is the freshly-installed shape.
      expect(frame).toMatch(/0 modified/);
      // One of the three update states must show.
      expect(frame).toMatch(/Up to date|available|Update check/);
    } finally {
      if (vault) await vault.cleanup();
    }
  }, 60_000);

  // ───── Scenario 25: `shardmind --verbose` → VerboseView ─────

  it('25. `shardmind --verbose` → VerboseView shows full file list with ownership', async () => {
    const { stub, fixtures } = getCtx();
    stub.setVersion(SHARD_SLUG, '0.1.0', fixtures.byVersion['0.1.0']!);
    stub.setLatest(SHARD_SLUG, '0.1.0');
    let vault: Vault | null = null;
    try {
      vault = await createInstalledVault({
        stub,
        shardRef: SHARD_REF,
        values: DEFAULT_VALUES,
        prefix: 's25-status-verbose',
      });
      const r = mountStatus({
        vaultRoot: vault.root,
        options: { verbose: true },
      });
      // Verbose view extends Status with Values / Modules / Files /
      // Frontmatter / Environment sections.
      const frame = await waitFor(
        r.lastFrame,
        (f) => f.includes('Values') && f.includes('Modules') && f.includes('Files'),
        15_000,
      );
      expect(frame).toMatch(/Values/);
      expect(frame).toMatch(/Modules/);
      expect(frame).toMatch(/Files/);
      // Module IDs from minimal-shard surface in the Modules section.
      expect(frame).toMatch(/brain/);
      // The Files section renders an aggregate count + bucket summary
      // for an unchanged install ("6 managed (unchanged)"); paths only
      // surface for modified / missing buckets, so we assert on the
      // count-line shape rather than a specific filename.
      expect(frame).toMatch(/\d+ managed/);
    } finally {
      if (vault) await vault.cleanup();
    }
  }, 60_000);
});
