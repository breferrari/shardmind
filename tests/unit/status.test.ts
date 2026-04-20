/**
 * Unit tests for `core/status.ts`.
 *
 * These exercise the aggregator against a real installed fixture
 * (`examples/minimal-shard`) rather than fake states, because `detectDrift`
 * expects real files on disk and re-writing a mock around it would lose the
 * fidelity that makes drift detection correct in the first place. The
 * installs are cheap (~50ms) and the tests stay isolated via per-test
 * temp directories.
 *
 * Update-check integration is exercised through the on-disk cache file
 * (priming it directly rather than hitting the network), so every test
 * here runs offline. Network-failure behavior lives in
 * `tests/unit/update-check.test.ts` where it's closer to the source.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { parseManifest } from '../../source/core/manifest.js';
import { parseSchema, buildValuesValidator } from '../../source/core/schema.js';
import {
  defaultModuleSelections,
  resolveComputedDefaults,
} from '../../source/core/install-planner.js';
import { runInstall } from '../../source/core/install-executor.js';
import { buildStatusReport, relativeTimeAgo } from '../../source/core/status.js';
import { primeLatestVersion } from '../../source/core/update-check.js';
import type { ResolvedShard } from '../../source/runtime/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MINIMAL_SHARD = path.resolve(__dirname, '../../examples/minimal-shard');

const RESOLVED: ResolvedShard = {
  namespace: 'shardmind',
  name: 'minimal',
  version: '0.1.0',
  source: 'github:breferrari/minimal-shard',
  tarballUrl: 'n/a (local fixture)',
};

const VALUES = {
  user_name: 'Alice',
  org_name: 'Acme Labs',
  vault_purpose: 'engineering' as const,
  qmd_enabled: true,
};

async function installMinimal(vault: string): Promise<void> {
  const manifest = await parseManifest(path.join(MINIMAL_SHARD, 'shard.yaml'));
  const schema = await parseSchema(path.join(MINIMAL_SHARD, 'shard-schema.yaml'));
  const selections = defaultModuleSelections(schema);
  const validator = buildValuesValidator(schema);
  const values = validator.parse(resolveComputedDefaults(schema, VALUES));

  await runInstall({
    vaultRoot: vault,
    manifest,
    schema,
    tempDir: MINIMAL_SHARD,
    resolved: RESOLVED,
    tarballSha256: 'local-fixture',
    values,
    selections,
  });
}

describe('buildStatusReport', () => {
  let vault: string;

  beforeEach(async () => {
    vault = path.join(os.tmpdir(), `shardmind-status-${crypto.randomUUID()}`);
    await fsp.mkdir(vault, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(vault, { recursive: true, force: true });
  });

  it('returns null when the directory is not a shard-managed vault', async () => {
    const report = await buildStatusReport(vault, { verbose: false, skipUpdateCheck: true });
    expect(report).toBeNull();
  });

  it('reports an up-to-date vault with no drift or warnings (beyond informational)', async () => {
    await installMinimal(vault);
    await primeLatestVersion(vault, RESOLVED.source, '0.1.0');

    const report = await buildStatusReport(vault, { verbose: false });
    expect(report).not.toBeNull();
    expect(report!.update).toEqual({ kind: 'up-to-date', current: '0.1.0' });
    expect(report!.drift.modified).toBe(0);
    expect(report!.drift.managed).toBeGreaterThan(0);

    // No warnings for a clean up-to-date vault.
    expect(report!.warnings).toEqual([]);
  });

  it('flags drift when a managed file is edited by the user', async () => {
    await installMinimal(vault);

    // Edit one managed file.
    const homePath = path.join(vault, 'Home.md');
    const original = await fsp.readFile(homePath, 'utf-8');
    await fsp.writeFile(homePath, original + '\n\n## User addition\n', 'utf-8');

    const report = await buildStatusReport(vault, {
      verbose: false,
      skipUpdateCheck: true,
    });
    expect(report!.drift.modified).toBe(1);
    expect(report!.drift.modifiedPaths).toContain('Home.md');

    const modWarning = report!.warnings.find(w => w.message.includes('modified by you'));
    expect(modWarning?.severity).toBe('warning');
  });

  it('reports "available" when the primed cache shows a higher version', async () => {
    await installMinimal(vault);
    await primeLatestVersion(vault, RESOLVED.source, '4.0.0');

    const report = await buildStatusReport(vault, { verbose: false });
    expect(report!.update).toMatchObject({
      kind: 'available',
      current: '0.1.0',
      latest: '4.0.0',
      cacheAge: 'fresh',
    });
    const upd = report!.warnings.find(w => w.message.startsWith('v4.0.0 available'));
    expect(upd?.severity).toBe('info');
  });

  it('reports "unknown / cache-miss" when the update check is skipped', async () => {
    // `skipUpdateCheck` is semantically distinct from network failure:
    // the caller opted out of the lookup, so the reason is cache-miss,
    // not no-network. Preserves the distinction the UI surfaces.
    await installMinimal(vault);
    const report = await buildStatusReport(vault, {
      verbose: false,
      skipUpdateCheck: true,
    });
    expect(report!.update).toMatchObject({ kind: 'unknown', reason: 'cache-miss' });
  });

  it('populates verbose-only sections when verbose=true', async () => {
    await installMinimal(vault);
    const report = await buildStatusReport(vault, {
      verbose: true,
      skipUpdateCheck: true,
    });
    expect(report!.frontmatter).not.toBeNull();
    expect(report!.environment).not.toBeNull();
    expect(report!.environment!.nodeVersion).toMatch(/^v/);
  });

  it('computes per-modified-file +N/−M line counts in verbose mode', async () => {
    await installMinimal(vault);

    // Edit Home.md with an additive change — should register as +lines, 0 removed
    // because we only append.
    const homePath = path.join(vault, 'Home.md');
    const original = await fsp.readFile(homePath, 'utf-8');
    await fsp.writeFile(homePath, original + '\n\nExtra paragraph.\nAnother line.\n', 'utf-8');

    const report = await buildStatusReport(vault, {
      verbose: true,
      skipUpdateCheck: true,
    });
    expect(report!.drift.modified).toBe(1);
    expect(report!.drift.modifiedChanges).not.toBeNull();
    const entry = report!.drift.modifiedChanges![0];
    expect(entry).toBeDefined();
    if (entry && !('skipped' in entry)) {
      expect(entry.path).toBe('Home.md');
      // Appending lines should register added > 0. We don't assert
      // linesRemoved=0 because line-based diff treats a file's trailing
      // boundary as a hunk edge — an appended paragraph can register
      // a re-written last line as +/− even when only net-additive.
      expect(entry.linesAdded).toBeGreaterThan(0);
      expect(entry.linesAdded).toBeGreaterThanOrEqual(entry.linesRemoved);
    } else {
      throw new Error('expected a non-skipped change entry for Home.md');
    }
  });

  it('omits modifiedChanges in quick mode to keep the fast path fast', async () => {
    await installMinimal(vault);
    const homePath = path.join(vault, 'Home.md');
    const original = await fsp.readFile(homePath, 'utf-8');
    await fsp.writeFile(homePath, original + '\nuser line\n', 'utf-8');

    const report = await buildStatusReport(vault, {
      verbose: false,
      skipUpdateCheck: true,
    });
    expect(report!.drift.modified).toBe(1);
    expect(report!.drift.modifiedChanges).toBeNull();
  });

  it('reports missing files as a warning when a tracked file is deleted', async () => {
    await installMinimal(vault);

    await fsp.rm(path.join(vault, 'Home.md'));

    const report = await buildStatusReport(vault, {
      verbose: false,
      skipUpdateCheck: true,
    });
    expect(report!.drift.missing).toBeGreaterThanOrEqual(1);
    expect(report!.warnings.some(w => w.message.includes('missing from disk'))).toBe(true);
  });

  it('handles a missing values file by emitting a file-missing warning', async () => {
    await installMinimal(vault);
    await fsp.rm(path.join(vault, 'shard-values.yaml'));

    const report = await buildStatusReport(vault, {
      verbose: false,
      skipUpdateCheck: true,
    });
    expect(report!.values.fileMissing).toBe(true);
    expect(report!.warnings.some(w => w.message.includes('shard-values.yaml'))).toBe(true);
  });

  it('leaves updatedAgo as null when state.updated_at equals state.installed_at', async () => {
    await installMinimal(vault);

    const report = await buildStatusReport(vault, {
      verbose: false,
      skipUpdateCheck: true,
    });
    // Fresh installs write installed_at === updated_at, so the "last
    // updated" line must not appear (null, not 'just now').
    expect(report!.state.installed_at).toBe(report!.state.updated_at);
    expect(report!.updatedAgo).toBeNull();
  });

  it('sorts module selections alphabetically so the display is deterministic', async () => {
    await installMinimal(vault);
    const report = await buildStatusReport(vault, {
      verbose: false,
      skipUpdateCheck: true,
    });
    const sorted = [...report!.modules.included].sort();
    expect(report!.modules.included).toEqual(sorted);
  });
});

describe('relativeTimeAgo', () => {
  const NOW = Date.parse('2026-04-20T12:00:00Z');

  it('returns "just now" within a minute', () => {
    expect(relativeTimeAgo(new Date(NOW - 30_000).toISOString(), NOW)).toBe('just now');
    expect(relativeTimeAgo(new Date(NOW).toISOString(), NOW)).toBe('just now');
  });

  it('handles future-dated inputs (clock skew) as "just now"', () => {
    expect(relativeTimeAgo(new Date(NOW + 60_000).toISOString(), NOW)).toBe('just now');
  });

  it('formats minute and hour buckets with singular/plural correctly', () => {
    expect(relativeTimeAgo(new Date(NOW - 60_000).toISOString(), NOW)).toBe('1 minute ago');
    expect(relativeTimeAgo(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('5 minutes ago');
    expect(relativeTimeAgo(new Date(NOW - 60 * 60_000).toISOString(), NOW)).toBe('1 hour ago');
    expect(relativeTimeAgo(new Date(NOW - 5 * 60 * 60_000).toISOString(), NOW)).toBe('5 hours ago');
  });

  it('formats day and week buckets', () => {
    expect(relativeTimeAgo(new Date(NOW - 24 * 60 * 60_000).toISOString(), NOW)).toBe('1 day ago');
    expect(relativeTimeAgo(new Date(NOW - 3 * 24 * 60 * 60_000).toISOString(), NOW)).toBe(
      '3 days ago',
    );
    expect(relativeTimeAgo(new Date(NOW - 7 * 24 * 60 * 60_000).toISOString(), NOW)).toBe(
      '1 week ago',
    );
    expect(relativeTimeAgo(new Date(NOW - 21 * 24 * 60 * 60_000).toISOString(), NOW)).toBe(
      '3 weeks ago',
    );
  });

  it('formats months and years', () => {
    expect(relativeTimeAgo(new Date(NOW - 60 * 24 * 60 * 60_000).toISOString(), NOW)).toBe(
      '2 months ago',
    );
    expect(relativeTimeAgo(new Date(NOW - 365 * 24 * 60 * 60_000).toISOString(), NOW)).toBe(
      'over a year ago',
    );
    expect(relativeTimeAgo(new Date(NOW - 3 * 365 * 24 * 60 * 60_000).toISOString(), NOW)).toBe(
      '3 years ago',
    );
  });

  it('returns "unknown" for unparseable ISO strings', () => {
    expect(relativeTimeAgo('not-a-date', NOW)).toBe('unknown');
    expect(relativeTimeAgo('', NOW)).toBe('unknown');
  });
});
