/**
 * Every `--json` document ends in exactly one newline (#231). Ink's
 * non-interactive unmount used to append a lone '\n' after the document, so
 * a line-oriented (NDJSON) reader saw an empty record.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { ensureBuilt } from './helpers/build-once.js';
import { buildTarballFixtures, cleanupTarballFixtures, type TarballFixtures } from './helpers/tarball.js';
import { createGitHubStub, type GitHubStub } from './helpers/github-stub.js';
import { spawnCli } from './helpers/spawn-cli.js';
import { createInstalledVault, cleanupAllVaults, stripShardmindMetadata, type Vault } from './helpers/vault.js';

const SLUG = 'acme/demo';
const REF = `github:${SLUG}`;
const VALUES = { user_name: 'Alice', org_name: 'Acme Labs', vault_purpose: 'engineering', qmd_enabled: true };

let stub: GitHubStub;
let fixtures: TarballFixtures;
const vaults: Vault[] = [];

async function installed(): Promise<Vault> {
  stub.setLatest(SLUG, '0.1.0');
  const vault = await createInstalledVault({ stub, shardRef: REF, values: VALUES, prefix: 'json-newline' });
  vaults.push(vault);
  return vault;
}

async function stdoutOf(vault: Vault, args: string[]): Promise<string> {
  const result = await spawnCli(args, { cwd: vault.root, env: { SHARDMIND_GITHUB_API_BASE: stub.url } });
  return result.stdout;
}

/** One document, then exactly one newline and nothing after it. */
function expectSingleTrailingNewline(stdout: string): void {
  expect(stdout.endsWith('}\n')).toBe(true);
  expect(stdout.endsWith('\n\n')).toBe(false);
  expect(() => JSON.parse(stdout)).not.toThrow();
}

beforeAll(async () => {
  await ensureBuilt();
  fixtures = await buildTarballFixtures();
  stub = await createGitHubStub({
    shards: { [SLUG]: { versions: { '0.1.0': fixtures.byVersion['0.1.0'], '0.2.0': fixtures.byVersion['0.2.0'] }, latest: '0.1.0' } },
  });
}, 120_000);

afterEach(async () => {
  stub.setLatest(SLUG, '0.1.0');
  for (const vault of vaults.splice(0)) await vault.cleanup();
});

afterAll(async () => {
  await stub?.close();
  await cleanupAllVaults();
  await cleanupTarballFixtures();
});

describe('a --json document ends in a single newline, piped', () => {
  it('status --json', async () => {
    expectSingleTrailingNewline(await stdoutOf(await installed(), ['--json']));
  }, 90_000);

  it('update --dry-run --json on a bump', async () => {
    const vault = await installed();
    stub.setLatest(SLUG, '0.2.0');
    expectSingleTrailingNewline(await stdoutOf(vault, ['update', '--dry-run', '--json']));
  }, 90_000);

  // Up to date: the run answers with an upToDate document (#230), then Ink's
  // unmount newline follows it.
  it('update --dry-run --json on an up-to-date vault', async () => {
    expectSingleTrailingNewline(await stdoutOf(await installed(), ['update', '--dry-run', '--json']));
  }, 90_000);

  it('adopt --dry-run --json --yes on an unmanaged clone', async () => {
    const vault = await installed();
    await stripShardmindMetadata(vault);
    expectSingleTrailingNewline(await stdoutOf(vault, ['adopt', REF, '--dry-run', '--json', '--yes']));
  }, 90_000);
});
