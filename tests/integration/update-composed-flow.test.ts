/**
 * `runUpdateFlow` on a vault holding several shards (#407): every shard in
 * install order, or the one named; a failure stops the run with the shards
 * before it kept. Spec: docs/IMPLEMENTATION.md §4.30 step 6; ARCHITECTURE
 * §10.5; SHARD-LAYOUT §Update semantics (R3).
 *
 * In-process and hook-free: the vault is built by the install and add
 * flows against the GitHub stub, and no shard declares a hook, so nothing
 * here spawns a process.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { createGitHubStub, type GitHubStub } from '../e2e/helpers/github-stub.js';
import {
  buildCustomTarball,
  buildOverlayTarball,
  installComposedVault,
  serveLatest,
  silentFlowIO as io,
  OVERLAY_SCHEMA,
} from '../component/flows/helpers.js';
import { runInstallFlow } from '../../source/core/flows/install.js';
import { runUpdateFlow, type UpdateFlowInput, type ShardRun } from '../../source/core/flows/update.js';
import { resolveInstallDestination } from '../../source/core/install-destination.js';
import type { VaultState } from '../../source/runtime/types.js';
import { runUpdateJson } from '../../source/commands/headless/update.js';

const BASE = 'acme/base';
const OVERLAY = 'acme/research';

let stub: GitHubStub;
let tarDir: string;
const tarballs: Record<string, string> = {};
let vault: string;

/** A base release: the minimal shard as acme/base, hook-free, with `extra` files. */
const baseRelease = (version: string, extra: Record<string, string> = {}) =>
  buildCustomTarball({
    version,
    prefix: `base-${version}-${Object.keys(extra).length}`,
    manifestOverrides: { name: 'base', namespace: 'acme', hooks: {} },
    mutate: async (dir) => {
      await fsp.appendFile(path.join(dir, 'CLAUDE.md'), `\nRelease ${version}.\n`);
      for (const [rel, content] of Object.entries(extra)) {
        await fsp.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
        await fsp.writeFile(path.join(dir, rel), content);
      }
    },
    outDir: tarDir,
  });

/** An overlay release: only its own files (none of the minimal shard's), hook-free. */
const overlayRelease = (version: string, files: Record<string, string>, name = 'research') =>
  buildOverlayTarball({
    namespace: 'acme',
    name,
    version,
    files,
    prefix: `overlay-${name}-${version}-${Object.keys(files).join('-').replaceAll('/', '_')}`,
    outDir: tarDir,
  });

beforeAll(async () => {
  tarDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'shardmind-composed-flow-tar-'));
  tarballs['base-0.1.0'] = await baseRelease('0.1.0');
  tarballs['base-0.2.0'] = await baseRelease('0.2.0');
  tarballs['base-0.2.0-claims'] = await baseRelease('0.2.0', { 'research/Papers.md': 'the base wants this\n' });
  tarballs['overlay-1.0.0'] = await overlayRelease('1.0.0', { 'research/Papers.md.njk': '# Papers\n\nOn {{ topic }}.\n' });
  tarballs['overlay-2.0.0'] = await overlayRelease('2.0.0', { 'research/Papers.md.njk': '# Papers\n\nOn {{ topic }}, v2.\n' });
  tarballs['overlay-2.0.0-claims'] = await overlayRelease('2.0.0', {
    'research/Papers.md.njk': '# Papers\n\nOn {{ topic }}, v2.\n',
    'Home.md': 'the overlay wants this\n',
  });
  // Claims a base file, and offers a new optional module: a question the
  // refusal must come before.
  tarballs['overlay-2.0.0-claims-asks'] = await buildOverlayTarball({
    namespace: 'acme',
    name: 'research',
    version: '2.0.0',
    files: { 'research/Papers.md.njk': '# Papers\n', 'extras/Extra.md': 'extra\n', 'Home.md': 'the overlay wants this\n' },
    schema: { ...OVERLAY_SCHEMA, modules: { extras: { label: 'Extras', paths: ['extras/'], removable: true } } },
    prefix: 'overlay-research-2.0.0-claims-asks',
    outDir: tarDir,
  });
  tarballs['overlay-2.0.0-renamed'] = await overlayRelease('2.0.0', { 'research/Papers.md.njk': '# Papers\n' }, 'studies');
  stub = await createGitHubStub({
    shards: {
      [BASE]: { versions: { '0.1.0': tarballs['base-0.1.0']! }, latest: '0.1.0' },
      [OVERLAY]: { versions: { '1.0.0': tarballs['overlay-1.0.0']! }, latest: '1.0.0' },
    },
  });
}, 60_000);

afterAll(async () => {
  await stub?.close();
  await fsp.rm(tarDir, { recursive: true, force: true });
});

/** Serve `version` of `slug` as its latest release. */
const serve = (slug: string, version: string, tarball: string) => serveLatest(stub, slug, version, tarball);

beforeEach(async () => {
  vi.stubEnv('SHARDMIND_GITHUB_API_BASE', stub.url);
  serve(BASE, '0.1.0', tarballs['base-0.1.0']!);
  serve(OVERLAY, '1.0.0', tarballs['overlay-1.0.0']!);
  vault = path.join(os.tmpdir(), `shardmind-composed-flow-${crypto.randomUUID()}`);
  await fsp.mkdir(vault, { recursive: true });
  await installComposedVault({ vault, base: BASE, overlay: OVERLAY });
}, 60_000);

afterEach(async () => {
  vi.unstubAllEnvs();
  await fsp.rm(vault, { recursive: true, force: true });
});

const update = (over: Partial<UpdateFlowInput> = {}) =>
  runUpdateFlow(
    {
      vaultRoot: vault,
      yes: true,
      dryRun: false,
      json: false,
      release: undefined,
      includePrerelease: false,
      adoptPreexisting: false,
      skipHooks: false,
      engineVersion: undefined,
      ...over,
    },
    io(),
  );
const read = (rel: string) => fsp.readFile(path.join(vault, rel), 'utf-8');
const state = async () => JSON.parse(await read('.shardmind/state.json')) as VaultState;
const versions = async () => (await state()).shards.map((s) => [s.shard, s.version]);
/** Each run's shard and how it ended: a result's kind, an error's code, or skipped. */
const outcomes = (runs: ShardRun[]) =>
  runs.map((r) =>
    'result' in r ? [r.shard, r.result.kind] : 'error' in r ? [r.shard, (r.error as { code?: string }).code] : [r.shard, r.skipped],
  );

describe('update across shards (#407)', () => {
  it('updates every shard, the base first, each from its own files', async () => {
    serve(BASE, '0.2.0', tarballs['base-0.2.0']!);
    serve(OVERLAY, '2.0.0', tarballs['overlay-2.0.0']!);
    const result = await update();
    expect(result.kind).toBe('shards');
    if (result.kind !== 'shards') return;
    expect(outcomes(result.runs)).toEqual([[BASE, 'done'], [OVERLAY, 'done']]);
    expect(await versions()).toEqual([[BASE, '0.2.0'], [OVERLAY, '2.0.0']]);
    expect(await read('CLAUDE.md')).toContain('Release 0.2.0.');
    expect(await read('research/Papers.md')).toBe('# Papers\n\nOn physics, v2.\n');
    expect(await read('.shardmind/shards/acme/research/shard.yaml')).toContain('2.0.0');
    expect(await read('shard-values.acme.research.yaml')).toBe('topic: physics\n');
  });

  it('reports a shard already up to date and moves on', async () => {
    serve(OVERLAY, '2.0.0', tarballs['overlay-2.0.0']!);
    const result = await update();
    if (result.kind !== 'shards') throw new Error(`expected shards, got ${result.kind}`);
    expect(outcomes(result.runs)).toEqual([[BASE, 'up-to-date'], [OVERLAY, 'done']]);
    expect(await versions()).toEqual([[BASE, '0.1.0'], [OVERLAY, '2.0.0']]);
  });

  it('`update <shard>` updates that shard alone; the base entry is kept byte for byte', async () => {
    serve(BASE, '0.2.0', tarballs['base-0.2.0']!);
    serve(OVERLAY, '2.0.0', tarballs['overlay-2.0.0']!);
    const before = (await state()).shards[0];
    const result = await update({ shard: OVERLAY });
    if (result.kind !== 'shards') throw new Error(`expected shards, got ${result.kind}`);
    expect(outcomes(result.runs)).toEqual([[OVERLAY, 'done']]);
    expect((await state()).shards[0]).toEqual(before);
    expect(await versions()).toEqual([[BASE, '0.1.0'], [OVERLAY, '2.0.0']]);
  });

  it('a name the vault does not hold is UPDATE_SHARD_UNKNOWN, listing the shards it holds', async () => {
    await expect(update({ shard: 'acme/nope' })).rejects.toMatchObject({
      code: 'UPDATE_SHARD_UNKNOWN',
      hint: expect.stringContaining(`${BASE}, ${OVERLAY}`),
    });
    // Matched exactly, as state.json records it.
    await expect(update({ shard: 'Acme/Research' })).rejects.toMatchObject({ code: 'UPDATE_SHARD_UNKNOWN' });
  });

  it('--release on a bare update of several shards is UPDATE_FLAG_CONFLICT; named, it pins that shard', async () => {
    serve(OVERLAY, '2.0.0', tarballs['overlay-2.0.0']!);
    await expect(update({ release: '2.0.0' })).rejects.toMatchObject({ code: 'UPDATE_FLAG_CONFLICT' });
    const result = await update({ shard: OVERLAY, release: '2.0.0' });
    if (result.kind !== 'shards') throw new Error(`expected shards, got ${result.kind}`);
    expect(outcomes(result.runs)).toEqual([[OVERLAY, 'done']]);
  });

  it("an overlay whose release claims a base file fails alone: the base stays updated, the overlay as it was", async () => {
    serve(BASE, '0.2.0', tarballs['base-0.2.0']!);
    serve(OVERLAY, '2.0.0', tarballs['overlay-2.0.0-claims']!);
    const result = await update();
    if (result.kind !== 'shards') throw new Error(`expected shards, got ${result.kind}`);
    expect(outcomes(result.runs)).toEqual([[BASE, 'done'], [OVERLAY, 'UPDATE_PATH_OWNED']]);
    const err = (result.runs[1] as { error: Error }).error;
    expect(err.message).toContain('Home.md');
    expect(err.message).toContain(BASE);
    expect(await versions()).toEqual([[BASE, '0.2.0'], [OVERLAY, '1.0.0']]);
    // The base's own render (dated), never the overlay's bytes.
    expect(await read('Home.md')).not.toContain('the overlay wants this');
    expect(await read('research/Papers.md')).toBe('# Papers\n\nOn physics.\n');
  });

  it("refuses a release that claims another shard's file before asking its questions", async () => {
    serve(OVERLAY, '2.0.0', tarballs['overlay-2.0.0-claims-asks']!);
    // No --yes: the new optional module would be asked; silentFlowIO rejects any question.
    const result = await update({ yes: false });
    if (result.kind !== 'shards') throw new Error(`expected shards, got ${result.kind}`);
    expect(outcomes(result.runs)).toEqual([[BASE, 'up-to-date'], [OVERLAY, 'UPDATE_PATH_OWNED']]);
  });

  it('a base whose release claims an overlay file stops the run: the overlay is not reached', async () => {
    serve(BASE, '0.2.0', tarballs['base-0.2.0-claims']!);
    serve(OVERLAY, '2.0.0', tarballs['overlay-2.0.0']!);
    const result = await update();
    if (result.kind !== 'shards') throw new Error(`expected shards, got ${result.kind}`);
    expect(outcomes(result.runs)).toEqual([[BASE, 'UPDATE_PATH_OWNED'], [OVERLAY, 'not-reached']]);
    expect(await versions()).toEqual([[BASE, '0.1.0'], [OVERLAY, '1.0.0']]);
    expect(await read('research/Papers.md')).toBe('# Papers\n\nOn physics.\n');
  });

  it('an overlay release under another name is UPDATE_SHARD_RENAMED, before any write for it', async () => {
    serve(OVERLAY, '2.0.0', tarballs['overlay-2.0.0-renamed']!);
    const result = await update();
    if (result.kind !== 'shards') throw new Error(`expected shards, got ${result.kind}`);
    expect(outcomes(result.runs)).toEqual([[BASE, 'up-to-date'], [OVERLAY, 'UPDATE_SHARD_RENAMED']]);
    expect(await versions()).toEqual([[BASE, '0.1.0'], [OVERLAY, '1.0.0']]);
  });

  it('a dry run plans each shard and writes nothing', async () => {
    serve(BASE, '0.2.0', tarballs['base-0.2.0']!);
    serve(OVERLAY, '2.0.0', tarballs['overlay-2.0.0']!);
    const before = await read('.shardmind/state.json');
    const result = await update({ dryRun: true });
    if (result.kind !== 'shards') throw new Error(`expected shards, got ${result.kind}`);
    expect(outcomes(result.runs)).toEqual([[BASE, 'done'], [OVERLAY, 'done']]);
    expect(await read('.shardmind/state.json')).toBe(before);
    expect(await read('research/Papers.md')).toBe('# Papers\n\nOn physics.\n');
  });
});

describe('update --json across shards (#407)', () => {
  async function json(argv: string[]): Promise<{ code: number; doc: Record<string, any> }> {
    vi.spyOn(process, 'cwd').mockReturnValue(vault);
    let out = '';
    const code = await runUpdateJson(argv, undefined, (chunk) => {
      out += chunk;
    });
    vi.mocked(process.cwd).mockRestore();
    return { code, doc: JSON.parse(out) as Record<string, any> };
  }

  it("answers the base's result at the top, and every shard's in shards", async () => {
    serve(BASE, '0.2.0', tarballs['base-0.2.0']!);
    serve(OVERLAY, '2.0.0', tarballs['overlay-2.0.0']!);
    const { code, doc } = await json(['--yes', '--json']);
    expect(code).toBe(0);
    expect(doc['ok']).toBe(true);
    const result = doc['result'];
    expect(result.shards.map((s: { shard: string }) => s.shard)).toEqual([BASE, OVERLAY]);
    const { shards, ...top } = result;
    expect(top).toEqual(shards[0].result);
    expect(shards[1].result.files.map((f: { path: string }) => f.path)).toContain('research/Papers.md');
  });

  it("a failure answers that shard's error, prefixed, with every entry in error.details, and exits 1", async () => {
    serve(BASE, '0.2.0', tarballs['base-0.2.0']!);
    serve(OVERLAY, '2.0.0', tarballs['overlay-2.0.0-claims']!);
    const { code, doc } = await json(['--yes', '--json']);
    expect(code).toBe(1);
    expect(doc['ok']).toBe(false);
    expect(doc['error'].code).toBe('UPDATE_PATH_OWNED');
    expect(doc['error'].message).toMatch(/^acme\/research: /);
    const shards = doc['error'].details.shards;
    expect(shards[0]).toMatchObject({ shard: BASE, result: { counts: expect.any(Object) } });
    expect(shards[1]).toMatchObject({ shard: OVERLAY, error: { code: 'UPDATE_PATH_OWNED' } });
  });

  it('`update <shard> --json` answers that shard', async () => {
    serve(OVERLAY, '2.0.0', tarballs['overlay-2.0.0']!);
    const { code, doc } = await json([OVERLAY, '--yes', '--json']);
    expect(code).toBe(0);
    expect(doc['result'].shards.map((s: { shard: string }) => s.shard)).toEqual([OVERLAY]);
  });
});

describe('update across shards: naming and state (#407)', () => {
  it('`update <base>` updates the base alone', async () => {
    serve(BASE, '0.2.0', tarballs['base-0.2.0']!);
    serve(OVERLAY, '2.0.0', tarballs['overlay-2.0.0']!);
    const result = await update({ shard: BASE });
    if (result.kind !== 'shards') throw new Error(`expected shards, got ${result.kind}`);
    expect(outcomes(result.runs)).toEqual([[BASE, 'done']]);
    expect(await versions()).toEqual([[BASE, '0.2.0'], [OVERLAY, '1.0.0']]);
  });

  it('an overlay name that is not <namespace>/<name> is STATE_CORRUPT, before any network call', async () => {
    const raw = await state();
    raw.shards[1]!.shard = 'not-a-name';
    await fsp.writeFile(path.join(vault, '.shardmind', 'state.json'), JSON.stringify(raw, null, 2));
    const before = stub.requestedPaths().length;
    await expect(update()).rejects.toMatchObject({ code: 'STATE_CORRUPT', message: expect.stringContaining('not-a-name') });
    expect(stub.requestedPaths().length).toBe(before);
  });

  it("reads an overlay's values file written with CRLF line endings", async () => {
    await fsp.writeFile(path.join(vault, 'shard-values.acme.research.yaml'), 'topic: optics\r\n');
    serve(OVERLAY, '2.0.0', tarballs['overlay-2.0.0']!);
    const result = await update({ shard: OVERLAY });
    if (result.kind !== 'shards') throw new Error(`expected shards, got ${result.kind}`);
    expect(outcomes(result.runs)).toEqual([[OVERLAY, 'done']]);
    expect(await read('research/Papers.md')).toBe('# Papers\n\nOn optics, v2.\n');
  });
});

describe('update on a vault with one shard (#407)', () => {
  it('naming its shard is a bare update, answered as before (no shards list)', async () => {
    // A vault of the base alone.
    const solo = path.join(os.tmpdir(), `shardmind-composed-flow-solo-${crypto.randomUUID()}`);
    await fsp.mkdir(solo, { recursive: true });
    try {
      await runInstallFlow(
        {
          valuesFile: undefined, yes: true, defaults: true, dryRun: false, skipHooks: false, interactive: false, engineVersion: undefined,
          shardRef: `github:${BASE}`, force: false, destination: await resolveInstallDestination(solo, `github:${BASE}`, '.'),
        },
        io(),
      );
      serve(BASE, '0.2.0', tarballs['base-0.2.0']!);
      const run = (shard?: string) =>
        runUpdateFlow(
          { vaultRoot: solo, shard, yes: true, dryRun: true, json: false, release: undefined, includePrerelease: false, adoptPreexisting: false, skipHooks: false, engineVersion: undefined },
          io(),
        );
      expect((await run(BASE)).kind).toBe('done');
      expect((await run()).kind).toBe('done');
      await expect(run(OVERLAY)).rejects.toMatchObject({ code: 'UPDATE_SHARD_UNKNOWN' });
    } finally {
      await fsp.rm(solo, { recursive: true, force: true });
    }
  });
});
