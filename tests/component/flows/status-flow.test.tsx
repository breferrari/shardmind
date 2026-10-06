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

import {
  setupFlowSuite,
  mountStatus,
  SHARD_SLUG,
  SHARD_REF,
  DEFAULT_VALUES,
} from './helpers.js';
import { waitFor } from '../helpers.js';
import { createInstalledVault, type Vault } from '../../e2e/helpers/vault.js';
import { runStatusJson } from '../../../source/commands/headless/status.js';

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

  // ───── `shardmind --json` → one document on stdout, no frame (#139) ─────

  // `--json` runs headless, without this tree (#302): the document for an
  // installed vault, from the runner `cli.ts` calls.
  it('`shardmind --json` → one status document for the installed vault, exit 0', async () => {
    const { stub, fixtures } = getCtx();
    stub.setVersion(SHARD_SLUG, '0.1.0', fixtures.byVersion['0.1.0']!);
    stub.setLatest(SHARD_SLUG, '0.1.0');
    let vault: Vault | null = null;
    const written: string[] = [];
    const cwd = process.cwd();
    try {
      vault = await createInstalledVault({
        stub,
        shardRef: SHARD_REF,
        values: DEFAULT_VALUES,
        prefix: 's26-status-json',
      });
      process.chdir(vault.root);
      const code = await runStatusJson(['--json'], undefined, (chunk) => void written.push(chunk));
      expect(code).toBe(0);
      expect(written).toHaveLength(1);
      const doc = JSON.parse(written[0]!) as {
        command: string;
        ok: boolean;
        result: { installed: boolean; shard: string; files: { counts: { modified: number } } };
      };
      expect(doc.command).toBe('status');
      expect(doc.ok).toBe(true);
      expect(doc.result.installed).toBe(true);
      expect(doc.result.shard).toMatch(/shardmind\/minimal/);
      expect(doc.result.files.counts.modified).toBe(0);
    } finally {
      process.chdir(cwd);
      if (vault) await vault.cleanup();
    }
  }, 60_000);

  // ───── #344: a state.json from a newer ShardMind ─────

  async function newerStateVault(prefix: string): Promise<Vault> {
    const { stub, fixtures } = getCtx();
    stub.setVersion(SHARD_SLUG, '0.1.0', fixtures.byVersion['0.1.0']!);
    stub.setLatest(SHARD_SLUG, '0.1.0');
    const vault = await createInstalledVault({ stub, shardRef: SHARD_REF, values: DEFAULT_VALUES, prefix });
    const state = JSON.parse(await vault.readFile('.shardmind/state.json')) as Record<string, unknown>;
    await vault.writeFile('.shardmind/state.json', JSON.stringify({ ...state, schema_version: 9, shape: 'from the future' }));
    return vault;
  }

  it('a state.json from a newer ShardMind: a notice with both schema numbers and the upgrade, not an error (#344)', async () => {
    let vault: Vault | null = null;
    try {
      vault = await newerStateVault('s344-newer-human');
      const r = mountStatus({ vaultRoot: vault.root });
      const frame = await waitFor(r.lastFrame, (f) => f.includes('newer ShardMind'), 30_000);
      expect(frame).toContain('state schema 9; this one reads up to 2');
      expect(frame).toContain('npm install -g shardmind@latest');
      expect(frame).not.toContain('STATE_UNSUPPORTED_VERSION');
    } finally {
      if (vault) await vault.cleanup();
    }
  }, 60_000);

  it('`shardmind --json` on a newer state.json: ok false, the code, error.details with both numbers, exit 1 (#344)', async () => {
    let vault: Vault | null = null;
    const written: string[] = [];
    const cwd = process.cwd();
    try {
      vault = await newerStateVault('s344-newer-json');
      process.chdir(vault.root);
      const code = await runStatusJson(['--json'], undefined, (chunk) => void written.push(chunk));
      expect(code).toBe(1);
      const doc = JSON.parse(written[0]!) as {
        ok: boolean;
        result?: unknown;
        error: { code: string; message: string; hint: string; details?: { stateSchemaVersion: number; supportedSchemaVersion: number } };
      };
      expect(doc.ok).toBe(false);
      expect(doc.result).toBeUndefined();
      expect(doc.error.code).toBe('STATE_UNSUPPORTED_VERSION');
      expect(doc.error.details).toEqual({ stateSchemaVersion: 9, supportedSchemaVersion: 2 });
      expect(doc.error.hint).toContain('npm install -g shardmind@latest');
    } finally {
      process.chdir(cwd);
      if (vault) await vault.cleanup();
    }
  }, 60_000);
});
