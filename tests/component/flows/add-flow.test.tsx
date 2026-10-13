/**
 * Layer 1 `shardmind add` flow tests (#396): the whole `<Add>` tree, driven
 * through stdin against the local GitHub stub, asserted on the frames and
 * the vault on disk. Spec: ARCHITECTURE §10.4a, IMPLEMENTATION §4.30
 * step 10, SHARD-LAYOUT §Overlay shards.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup } from 'ink-testing-library';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  setupFlowSuite,
  mountAdd,
  makeVaultDir,
  cleanupVault,
  buildCustomTarball,
  SHARD_SLUG,
  SHARD_REF,
  DEFAULT_VALUES,
} from './helpers.js';
import { createInstalledVault, type Vault } from '../../e2e/helpers/vault.js';
import { resetSigintRollbackForTests } from '../../../source/commands/hooks/shared.js';
import { waitFor, ENTER } from '../helpers.js';

const OVERLAY_SLUG = 'acme/research';
const OVERLAY_REF = `github:${OVERLAY_SLUG}`;
const TWIN_SLUG = 'acme/twin';

/** An overlay with paths of its own: one value, one removable module, a bootstrap hook that leaves a marker. */
function overlayTarball(outDir: string): Promise<string> {
  return buildCustomTarball({
    version: '0.1.0',
    prefix: 'research-0.1.0',
    outDir,
    manifestOverrides: {
      name: 'research',
      namespace: 'acme',
      hooks: { bootstrap: { script: '.shardmind/hooks/bootstrap.ts', fingerprint: 'r1' } },
    },
    schema: {
      schema_version: 1,
      values: { topic: { type: 'string', message: 'Research topic', default: 'physics', group: 'setup' } },
      groups: [{ id: 'setup', label: 'Setup' }],
      modules: { papers: { label: 'Papers', paths: ['research/papers/'], removable: true } },
      signals: [],
      frontmatter: {},
      migrations: [],
    },
    mutate: async (work) => {
      for (const entry of await fs.readdir(work)) {
        if (entry !== '.shardmind') await fs.rm(path.join(work, entry), { recursive: true, force: true });
      }
      await fs.mkdir(path.join(work, 'research', 'papers'), { recursive: true });
      await fs.writeFile(path.join(work, 'research', 'Index.md.njk'), 'Research on {{ topic }}\n');
      await fs.writeFile(path.join(work, 'research', 'papers', 'Reading.md'), 'reading list\n');
      await fs.mkdir(path.join(work, '.shardmind', 'hooks'), { recursive: true });
      await fs.writeFile(
        path.join(work, '.shardmind', 'hooks', 'bootstrap.ts'),
        "import { writeFile } from 'node:fs/promises';\nimport { join } from 'node:path';\nexport default async function (ctx: { vaultRoot: string; values: Record<string, unknown> }) {\n  await writeFile(join(ctx.vaultRoot, 'research-bootstrapped.txt'), String(ctx.values['topic']));\n}\n",
      );
    },
  });
}

describe('add command — Layer 1 flow tests (#396)', () => {
  const getCtx = setupFlowSuite({
    shards: {
      [SHARD_SLUG]: { versions: {} as Record<string, string>, latest: '0.1.0' },
      [OVERLAY_SLUG]: { versions: {} as Record<string, string>, latest: '0.1.0' },
      [TWIN_SLUG]: { versions: {} as Record<string, string>, latest: '0.1.0' },
    },
  });

  let work: string;
  const vaults: Vault[] = [];

  afterEach(async () => {
    cleanup();
    resetSigintRollbackForTests();
    for (const v of vaults.splice(0)) await v.cleanup();
    if (work) await cleanupVault(work);
  });

  /** A vault with the base shard installed (the stub serves shardmind/minimal as acme/demo), and the overlay published. */
  async function baseVault(prefix: string): Promise<Vault> {
    const { stub, fixtures } = getCtx();
    stub.setVersion(SHARD_SLUG, '0.1.0', fixtures.byVersion['0.1.0']!);
    stub.setLatest(SHARD_SLUG, '0.1.0');
    work = await fs.mkdtemp(path.join(os.tmpdir(), 'add-flow-'));
    stub.setVersion(OVERLAY_SLUG, '0.1.0', await overlayTarball(work));
    const vault = await createInstalledVault({ stub, shardRef: SHARD_REF, values: DEFAULT_VALUES, prefix });
    vaults.push(vault);
    return vault;
  }

  const stateOf = async (vault: Vault) =>
    JSON.parse(await vault.readFile('.shardmind/state.json')) as { schema_version: number; shards: Array<Record<string, unknown>> };

  it('answers the wizard, adds the overlay beside the base, and runs its own bootstrap', async () => {
    const vault = await baseVault('add-wizard');
    const baseState = JSON.parse(await vault.readFile('.shardmind/state.json')) as Record<string, unknown>;
    const r = mountAdd({ shardRef: OVERLAY_REF, cwd: vault.root });
    await waitFor(r.lastFrame, (f) => f.includes('1 question to answer'), 30_000);
    r.stdin.write(ENTER);
    // The field is prefilled with the default: accept it.
    await waitFor(r.lastFrame, (f) => f.includes('Research topic'));
    r.stdin.write(ENTER);
    await waitFor(r.lastFrame, (f) => f.includes('Choose modules to install'));
    r.stdin.write(ENTER);
    await waitFor(r.lastFrame, (f) => f.includes('Ready to install'));
    r.stdin.write(ENTER);
    const done = await waitFor(r.lastFrame, (f) => /Added acme\/research@0\.1\.0 beside shardmind\/minimal/.test(f.replace(/\s+/g, ' ')), 30_000);
    expect(done).toBeTruthy();

    const state = await stateOf(vault);
    expect(state.schema_version).toBe(3);
    expect(state.shards.map((s) => s['shard'])).toEqual(['shardmind/minimal', 'acme/research']);
    const { schema_version: _v, ...baseEntry } = baseState;
    expect(state.shards[0]).toEqual(baseEntry);
    // The overlay's own bootstrap ran with its own values, and recorded its fingerprint in its entry.
    expect(await vault.readFile('research-bootstrapped.txt')).toBe('physics');
    expect(state.shards[1]!['bootstrap_fingerprint']).toBe('r1');
    expect(await vault.readFile('research/Index.md')).toBe('Research on physics\n');
    expect(await vault.readFile('shard-values.acme.research.yaml')).toContain('physics');
    expect(await vault.exists('.shardmind/shards/acme/research/shard.yaml')).toBe(true);
  }, 90_000);

  it('runs from a folder inside the vault', async () => {
    const vault = await baseVault('add-nested');
    await fs.mkdir(path.join(vault.root, 'brain', 'deep'), { recursive: true });
    const r = mountAdd({ shardRef: OVERLAY_REF, cwd: path.join(vault.root, 'brain', 'deep'), options: { yes: true } });
    await waitFor(r.lastFrame, (f) => /Added acme\/research/.test(f), 30_000);
    expect((await stateOf(vault)).shards).toHaveLength(2);
  }, 60_000);

  it('refuses an overlay that writes the base shard\'s paths, naming each, before any prompt or write', async () => {
    const vault = await baseVault('add-owned');
    const { stub } = getCtx();
    stub.setVersion(
      TWIN_SLUG,
      '0.1.0',
      await buildCustomTarball({ version: '0.1.0', prefix: 'twin-0.1.0', outDir: work, manifestOverrides: { name: 'twin', namespace: 'acme' } }),
    );
    const before = await vault.readFile('.shardmind/state.json');
    const r = mountAdd({ shardRef: `github:${TWIN_SLUG}`, cwd: vault.root });
    const frame = (await waitFor(r.lastFrame, (f) => f.includes('ADD_PATH_OWNED'), 30_000)).replace(/\s+/g, ' ');
    expect(frame).toContain('Home.md (shardmind/minimal)');
    expect(frame).not.toContain('question');
    expect(await vault.readFile('.shardmind/state.json')).toBe(before);
    expect(await vault.exists('.shardmind/shards')).toBe(false);
  }, 60_000);

  it('refuses a shard the vault already holds', async () => {
    const vault = await baseVault('add-present');
    const r = mountAdd({ shardRef: SHARD_REF, cwd: vault.root, options: { yes: true } });
    const frame = await waitFor(r.lastFrame, (f) => f.includes('ADD_SHARD_PRESENT'), 30_000);
    expect(frame.replace(/\s+/g, ' ')).toContain('as its base shard');
  }, 60_000);

  it('refuses outside a ShardMind vault', async () => {
    const empty = await makeVaultDir('add-no-vault');
    try {
      const r = mountAdd({ shardRef: OVERLAY_REF, cwd: empty, options: { yes: true } });
      await waitFor(r.lastFrame, (f) => f.includes('ADD_NO_INSTALL'), 15_000);
    } finally {
      await cleanupVault(empty);
    }
  }, 30_000);

  it('refuses --defaults with --values before looking for the vault', async () => {
    const empty = await makeVaultDir('add-flags');
    try {
      const r = mountAdd({ shardRef: OVERLAY_REF, cwd: empty, options: { defaults: true, values: 'v.yaml' } });
      await waitFor(r.lastFrame, (f) => f.includes('ADD_FLAG_CONFLICT'), 15_000);
    } finally {
      await cleanupVault(empty);
    }
  }, 30_000);

  it('asks about a file of the user\'s at an overlay path, and backs it up', async () => {
    const vault = await baseVault('add-collision');
    await vault.writeFile('research/Index.md', 'my own index\n');
    const r = mountAdd({ shardRef: OVERLAY_REF, cwd: vault.root, options: { values: await valuesFile(vault) } });
    // Every value prefilled: the wizard opens on the module review.
    await waitFor(r.lastFrame, (f) => f.includes('Choose modules to install'), 30_000);
    r.stdin.write(ENTER);
    await waitFor(r.lastFrame, (f) => f.includes('Ready to install'));
    r.stdin.write(ENTER);
    await waitFor(r.lastFrame, (f) => /back them up|Back up/i.test(f), 30_000);
    r.stdin.write(ENTER);
    await waitFor(r.lastFrame, (f) => /Added acme\/research/.test(f), 30_000);
    const backups = (await fs.readdir(path.join(vault.root, 'research'))).filter((n) => n.startsWith('Index.md.shardmind-backup-'));
    expect(backups).toHaveLength(1);
    expect(await vault.readFile(`research/${backups[0]}`)).toBe('my own index\n');
  }, 90_000);

  it('a dry run writes nothing', async () => {
    const vault = await baseVault('add-dry');
    const before = await vault.readFile('.shardmind/state.json');
    const r = mountAdd({ shardRef: OVERLAY_REF, cwd: vault.root, options: { yes: true, dryRun: true } });
    await waitFor(r.lastFrame, (f) => /files would be added beside shardmind\/minimal/.test(f.replace(/\s+/g, ' ')), 30_000);
    expect(await vault.readFile('.shardmind/state.json')).toBe(before);
    expect(await vault.exists('research')).toBe(false);
    expect(await vault.exists('shard-values.acme.research.yaml')).toBe(false);
  }, 60_000);

  it('--skip-hooks owes the overlay\'s bootstrap in its own entry, leaving the base\'s alone', async () => {
    const vault = await baseVault('add-skip');
    const r = mountAdd({ shardRef: OVERLAY_REF, cwd: vault.root, options: { yes: true, skipHooks: true } });
    const done = await waitFor(r.lastFrame, (f) => /Added acme\/research/.test(f), 30_000);
    expect(done).toContain('Bootstrap hook skipped (--skip-hooks).');
    const state = await stateOf(vault);
    expect(state.shards[1]!['bootstrap_pending']).toBe(true);
    expect(state.shards[0]).not.toHaveProperty('bootstrap_pending');
    expect(await vault.exists('research-bootstrapped.txt')).toBe(false);
  }, 60_000);

  async function valuesFile(vault: Vault): Promise<string> {
    const file = path.join(work, `${path.basename(vault.root)}-values.yaml`);
    await fs.writeFile(file, 'topic: optics\n');
    return file;
  }
});
