/**
 * Layer 1 self-update notifier flow tests (#113).
 *
 * Each top-level command mounts `useSelfUpdateCheck`, which fires a
 * background fetch against npm and renders `<SelfUpdateBanner>` once
 * the answer arrives. These tests cover both the rendering path
 * (banner shows above the command's UI) and the four suppression
 * paths (--no-update-check flag, SHARDMIND_NO_UPDATE_CHECK env, CI
 * env, non-TTY stdout).
 *
 * Since #285 a command never calls npm: it reads the 24h cache, shows
 * the banner from a fresh entry, and starts a detached refresh child
 * when the entry is stale or missing. So the banner tests seed the
 * cache (deterministic, no race with the command's exit), and the
 * refresh tests wait for the child's own cache write.
 *
 * The harness inverts default suppression: `setupFlowSuite` sets
 * `SHARDMIND_NO_UPDATE_CHECK=1` so existing flow files don't race a
 * live npm fetch. This file's tests delete that var per-test and
 * point the hook at a local HTTP stub via
 * `SHARDMIND_SELF_UPDATE_REGISTRY_URL`. The cache dir is also redirected
 * to a per-test tmpdir so the developer's real `~/.cache/shardmind`
 * stays untouched.
 *
 * Spec citation: ROADMAP §0.1.x Foundation #113;
 * docs/IMPLEMENTATION.md §4.19 (Self-update check).
 */

import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { cleanup } from 'ink-testing-library';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

import {
  setupFlowSuite,
  mountStatus,
  mountInstall,
  SHARD_SLUG,
  SHARD_REF,
  DEFAULT_VALUES,
} from './helpers.js';
import { waitFor, tick } from '../helpers.js';
import { CACHE_FILENAME, REFRESH_MARKER_FILENAME } from '../../../source/core/self-update-check.js';
import { createInstalledVault, type Vault } from '../../e2e/helpers/vault.js';

// Read the package's actual version once. This is what the bundled
// `dist/commands/<name>.js` reads at runtime via createRequire — the
// test mounts the SOURCE component directly, but the helper resolves
// `../../../package.json` from the test file (tests/component/flows/),
// which is the same package.json the production code reads. Keeping
// the test version in sync with package.json ensures the banner's
// "you have X.Y.Z" mirrors what users actually see.
const pkg = createRequire(import.meta.url)('../../../package.json') as {
  version: string;
};
const CURRENT_VERSION = pkg.version;
const NEWER_VERSION = '99.0.0'; // semver-greater than any plausible CLI version

// ───── Local npm-registry stub ─────────────────────────────────────

interface NpmStub {
  url: string;
  /** Requests served so far: only a refresh child ever calls npm (#285). */
  hits(): number;
  setVersion(v: string): void;
  setStatus(s: number): void;
  /** Hold each answer this long, so a refresh child stays alive. */
  setDelay(ms: number): void;
  reset(): void;
  close(): Promise<void>;
}

async function createNpmStub(): Promise<NpmStub> {
  let version = NEWER_VERSION;
  let status = 200;
  let delay = 0;
  let hits = 0;
  const server = http.createServer(async (_req, res) => {
    hits++;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    if (status === 200) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version }));
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/shardmind/latest`,
    hits: () => hits,
    setDelay: (ms) => {
      delay = ms;
    },
    setVersion: (v) => {
      version = v;
    },
    setStatus: (s) => {
      status = s;
    },
    reset: () => {
      version = NEWER_VERSION;
      status = 200;
      delay = 0;
      hits = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

// ───── Per-suite fixtures ──────────────────────────────────────────

describe('self-update notifier — Layer 1 flow tests (#113)', () => {
  const getCtx = setupFlowSuite({
    shards: {
      [SHARD_SLUG]: {
        versions: {} as Record<string, string>,
        latest: '0.1.0',
      },
    },
  });

  let npmStub: NpmStub;
  let cacheDirParent: string;
  // Capture every env we touch so we can deterministically restore.
  // Per-test mutations call enableBanner/disableBanner; the afterEach
  // pop restores the suite-default state set by setupFlowSuite.
  const TOUCHED_ENV = [
    'SHARDMIND_NO_UPDATE_CHECK',
    'SHARDMIND_SELF_UPDATE_FORCE_TTY',
    'SHARDMIND_SELF_UPDATE_REGISTRY_URL',
    'SHARDMIND_SELF_UPDATE_CACHE_DIR',
    'SHARDMIND_SELF_UPDATE_FETCH_TIMEOUT_MS',
    'CI',
  ] as const;
  let envSnapshot: Partial<Record<(typeof TOUCHED_ENV)[number], string | undefined>>;

  beforeAll(async () => {
    npmStub = await createNpmStub();
    cacheDirParent = await fsp.mkdtemp(
      path.join(os.tmpdir(), `shardmind-self-update-flow-${crypto.randomUUID()}-`),
    );
  }, 30_000);

  afterAll(async () => {
    await npmStub.close();
    await fsp.rm(cacheDirParent, { recursive: true, force: true });
  });

  afterEach(() => {
    cleanup();
    npmStub.reset();
    // Restore env snapshot if it was captured this test.
    if (envSnapshot) {
      for (const key of TOUCHED_ENV) {
        const original = envSnapshot[key];
        if (original === undefined) delete process.env[key];
        else process.env[key] = original;
      }
      envSnapshot = {};
    }
  });

  function snapshotEnv(): void {
    envSnapshot = {};
    for (const key of TOUCHED_ENV) {
      envSnapshot[key] = process.env[key];
    }
  }

  /** Configure env so the banner WILL render: clears every suppressor + points at the local stub. */
  function enableBanner(): string {
    snapshotEnv();
    delete process.env['SHARDMIND_NO_UPDATE_CHECK'];
    delete process.env['CI'];
    process.env['SHARDMIND_SELF_UPDATE_FORCE_TTY'] = '1';
    process.env['SHARDMIND_SELF_UPDATE_REGISTRY_URL'] = npmStub.url;
    // The local stub answers in single-digit ms, but under heavy parallel CPU
    // load the event loop can starve past the production 3s fetch timeout
    // before the response is processed — aborting the fetch so the banner
    // never renders and the banner-wait below times out. Give the fetch a wide
    // budget here (above the 30s banner waitFor below, under the 60s test
    // timeout); production keeps the 3s default. (Fixes the flaky scenario 7.)
    process.env['SHARDMIND_SELF_UPDATE_FETCH_TIMEOUT_MS'] = '45000';
    // Per-test cache dir keeps the dev's real ~/.cache/shardmind clean
    // and avoids one test's cache hit suppressing the next test's fetch.
    const cacheDir = path.join(cacheDirParent, crypto.randomUUID());
    process.env['SHARDMIND_SELF_UPDATE_CACHE_DIR'] = cacheDir;
    return cacheDir;
  }

  /** A fresh cache entry, as a refresh child would have written it. */
  async function seedCache(cacheDir: string, latest: string): Promise<void> {
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(
      path.join(cacheDir, CACHE_FILENAME),
      JSON.stringify({ schema_version: 1, checked_at: new Date().toISOString(), latest_version: latest }),
    );
  }

  /** Wait until `predicate` holds, polling; the refresh child is another process. */
  async function until(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
      await tick(50);
    }
  }

  /** The refresh child has ended: its marker is gone (it removes it on every path). */
  const refreshDone = (cacheDir: string) => !fs.existsSync(path.join(cacheDir, REFRESH_MARKER_FILENAME));

  // ───── 1. --no-update-check flag suppresses the banner (status command) ─────

  it('1. --no-update-check flag suppresses the banner on status', async () => {
    const cacheDir = enableBanner();
    // Even with FORCE_TTY + a working stub, the flag must dominate.
    const { stub, fixtures } = getCtx();
    stub.setVersion(SHARD_SLUG, '0.1.0', fixtures.byVersion['0.1.0']!);
    stub.setLatest(SHARD_SLUG, '0.1.0');
    let vault: Vault | null = null;
    try {
      vault = await createInstalledVault({
        stub,
        shardRef: SHARD_REF,
        values: DEFAULT_VALUES,
        prefix: 's113-1-flag',
      });
      const r = mountStatus({
        vaultRoot: vault.root,
        options: { updateCheck: false },
      });
      // Wait long enough that an unblocked banner would have rendered
      // (the hook fires `setTimeout(0)` then awaits the fetch — local
      // stub responds in single-digit ms).
      await waitFor(
        r.lastFrame,
        (f) => /shardmind\/minimal/.test(f) && /managed file/.test(f),
        15_000,
      );
      await tick(150);
      const frame = r.lastFrame() ?? '';
      expect(frame).not.toContain(`shardmind ${NEWER_VERSION}`);
      expect(frame).not.toContain('npm install -g shardmind@latest');
      // Suppressed: no refresh child, so no marker, no cache and no npm call (#285).
      expect(fs.existsSync(cacheDir)).toBe(false);
      expect(npmStub.hits()).toBe(0);
    } finally {
      if (vault) await vault.cleanup();
    }
  }, 60_000);

  // ───── 2. SHARDMIND_NO_UPDATE_CHECK env suppresses ─────

  it('2. SHARDMIND_NO_UPDATE_CHECK env suppresses the banner on status', async () => {
    const cacheDir = enableBanner();
    process.env['SHARDMIND_NO_UPDATE_CHECK'] = '1';
    const { stub, fixtures } = getCtx();
    stub.setVersion(SHARD_SLUG, '0.1.0', fixtures.byVersion['0.1.0']!);
    stub.setLatest(SHARD_SLUG, '0.1.0');
    let vault: Vault | null = null;
    try {
      vault = await createInstalledVault({
        stub,
        shardRef: SHARD_REF,
        values: DEFAULT_VALUES,
        prefix: 's113-2-noenv',
      });
      const r = mountStatus({ vaultRoot: vault.root });
      await waitFor(
        r.lastFrame,
        (f) => /shardmind\/minimal/.test(f) && /managed file/.test(f),
        15_000,
      );
      await tick(150);
      const frame = r.lastFrame() ?? '';
      expect(frame).not.toContain(`shardmind ${NEWER_VERSION}`);
      expect(fs.existsSync(cacheDir)).toBe(false);
      expect(npmStub.hits()).toBe(0);
    } finally {
      if (vault) await vault.cleanup();
    }
  }, 60_000);

  // ───── 3. CI env suppresses ─────

  it('3. CI env suppresses the banner on status', async () => {
    const cacheDir = enableBanner();
    process.env['CI'] = '1';
    const { stub, fixtures } = getCtx();
    stub.setVersion(SHARD_SLUG, '0.1.0', fixtures.byVersion['0.1.0']!);
    stub.setLatest(SHARD_SLUG, '0.1.0');
    let vault: Vault | null = null;
    try {
      vault = await createInstalledVault({
        stub,
        shardRef: SHARD_REF,
        values: DEFAULT_VALUES,
        prefix: 's113-3-ci',
      });
      const r = mountStatus({ vaultRoot: vault.root });
      await waitFor(
        r.lastFrame,
        (f) => /shardmind\/minimal/.test(f) && /managed file/.test(f),
        15_000,
      );
      await tick(150);
      const frame = r.lastFrame() ?? '';
      expect(frame).not.toContain(`shardmind ${NEWER_VERSION}`);
      expect(fs.existsSync(cacheDir)).toBe(false);
      expect(npmStub.hits()).toBe(0);
    } finally {
      if (vault) await vault.cleanup();
    }
  }, 60_000);

  // ───── 4. Banner renders above status from a fresh cache ─────

  it('4. banner renders above StatusView from a fresh cache, with no npm call', async () => {
    const cacheDir = enableBanner();
    await seedCache(cacheDir, NEWER_VERSION);
    const { stub, fixtures } = getCtx();
    stub.setVersion(SHARD_SLUG, '0.1.0', fixtures.byVersion['0.1.0']!);
    stub.setLatest(SHARD_SLUG, '0.1.0');
    let vault: Vault | null = null;
    try {
      vault = await createInstalledVault({
        stub,
        shardRef: SHARD_REF,
        values: DEFAULT_VALUES,
        prefix: 's113-4-render-status',
      });
      const r = mountStatus({ vaultRoot: vault.root });
      // Status holds its exit for the local cache read (#285), so the
      // banner always lands before the command ends: no race with npm.
      const frame = await waitFor(
        r.lastFrame,
        (f) =>
          f.includes(`shardmind ${NEWER_VERSION}`) &&
          f.includes('npm install -g shardmind@latest') &&
          /shardmind\/minimal/.test(f),
        30_000,
      );
      // Banner is above the status header (StatusView's first line is
      // the namespace/name + version badge). String-position check
      // pins the layout decision the index.tsx Box wrapper enforces.
      expect(frame.indexOf(`shardmind ${NEWER_VERSION}`)).toBeLessThan(
        frame.indexOf('shardmind/minimal'),
      );
      expect(frame).toContain(`(you have ${CURRENT_VERSION})`);
      // A fresh cache needs no refresh: no child, no npm call.
      expect(npmStub.hits()).toBe(0);
      expect(fs.existsSync(path.join(cacheDir, REFRESH_MARKER_FILENAME))).toBe(false);
    } finally {
      if (vault) await vault.cleanup();
    }
  }, 60_000);

  // ───── 5. Banner renders above install's wizard ─────

  it('5. banner renders above InstallWizard header from a fresh cache', async () => {
    const cacheDir = enableBanner();
    await seedCache(cacheDir, NEWER_VERSION);
    const { stub, fixtures } = getCtx();
    stub.setVersion(SHARD_SLUG, '0.1.0', fixtures.byVersion['0.1.0']!);
    const vault = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'shardmind-self-update-install-'),
    );
    try {
      const r = mountInstall({
        shardRef: SHARD_REF,
        vaultRoot: vault,
      });
      // The banner appears once the cache is read; the wizard header once
      // the install pipeline has resolved, downloaded and parsed the shard.
      // The install waits for input, so both coexist in a frame.
      const frame = await waitFor(
        r.lastFrame,
        (f) =>
          f.includes(`shardmind ${NEWER_VERSION}`) &&
          /4 questions to answer/.test(f),
        30_000,
      );
      // CommandFrame renders selfUpdateBanner before its other children,
      // so the banner appears above the wizard header.
      expect(frame.indexOf(`shardmind ${NEWER_VERSION}`)).toBeLessThan(
        frame.indexOf('4 questions to answer'),
      );
    } finally {
      await fsp.rm(vault, { recursive: true, force: true });
    }
  }, 60_000);

  // ───── 6. Banner suppressed when current === latest ─────

  it('6. banner suppressed when the cache says current === latest', async () => {
    const cacheDir = enableBanner();
    await seedCache(cacheDir, CURRENT_VERSION);
    const { stub, fixtures } = getCtx();
    stub.setVersion(SHARD_SLUG, '0.1.0', fixtures.byVersion['0.1.0']!);
    stub.setLatest(SHARD_SLUG, '0.1.0');
    let vault: Vault | null = null;
    try {
      vault = await createInstalledVault({
        stub,
        shardRef: SHARD_REF,
        values: DEFAULT_VALUES,
        prefix: 's113-6-equal',
      });
      const r = mountStatus({ vaultRoot: vault.root });
      const frame = await waitFor(
        r.lastFrame,
        (f) => /shardmind\/minimal/.test(f) && /managed file/.test(f),
        15_000,
      );
      // semver.lt(current, current) is false: no banner, and no refresh.
      expect(frame).not.toContain(`shardmind ${CURRENT_VERSION} available`);
      expect(frame).not.toContain('npm install -g shardmind@latest');
      expect(npmStub.hits()).toBe(0);
    } finally {
      if (vault) await vault.cleanup();
    }
  }, 60_000);

  // ───── 7. First frame is banner-less (zero observable latency) ─────

  it('7. first rendered frame never contains the banner — the cache read is async', async () => {
    const cacheDir = enableBanner();
    await seedCache(cacheDir, NEWER_VERSION);
    const { stub, fixtures } = getCtx();
    stub.setVersion(SHARD_SLUG, '0.1.0', fixtures.byVersion['0.1.0']!);
    stub.setLatest(SHARD_SLUG, '0.1.0');
    let vault: Vault | null = null;
    try {
      vault = await createInstalledVault({
        stub,
        shardRef: SHARD_REF,
        values: DEFAULT_VALUES,
        prefix: 's113-7-async',
      });
      const r = mountStatus({ vaultRoot: vault.root });
      // Sample the very first synchronous frame. The banner can't be
      // here because `useEffect` fires after the first commit and the
      // hook additionally defers the cache read by `setTimeout(0)`.
      const firstFrame = r.lastFrame() ?? '';
      expect(firstFrame).not.toContain(`shardmind ${NEWER_VERSION}`);
      expect(firstFrame).not.toContain('npm install -g shardmind@latest');
      // Then the banner arrives in a later frame.
      await waitFor(
        r.lastFrame,
        (f) => f.includes(`shardmind ${NEWER_VERSION}`),
        30_000,
      );
    } finally {
      if (vault) await vault.cleanup();
    }
  }, 60_000);

  // ───── 8. Stale cache: a detached child refreshes it for the next run ─────

  it('8. a stale cache starts one refresh child that writes the cache; the next run shows the banner', async () => {
    const cacheDir = enableBanner();
    // Keep the child alive past both mounts, so the second finds its marker.
    npmStub.setDelay(1_500);
    const { stub, fixtures } = getCtx();
    stub.setVersion(SHARD_SLUG, '0.1.0', fixtures.byVersion['0.1.0']!);
    stub.setLatest(SHARD_SLUG, '0.1.0');
    let vault: Vault | null = null;
    try {
      vault = await createInstalledVault({
        stub,
        shardRef: SHARD_REF,
        values: DEFAULT_VALUES,
        prefix: 's113-8-refresh',
      });
      // This run finds no cache: no banner, and it ends without waiting for npm.
      const first = mountStatus({ vaultRoot: vault.root });
      const firstFrame = await waitFor(
        first.lastFrame,
        (f) => /shardmind\/minimal/.test(f) && /managed file/.test(f),
        15_000,
      );
      expect(firstFrame).not.toContain(`shardmind ${NEWER_VERSION}`);
      await until(() => fs.existsSync(path.join(cacheDir, REFRESH_MARKER_FILENAME)), 5_000, 'the refresh marker');
      cleanup();

      // A second run while the child is live starts no second child.
      const second = mountStatus({ vaultRoot: vault.root });
      await waitFor(second.lastFrame, (f) => /shardmind\/minimal/.test(f), 15_000);
      cleanup();

      // The child writes the cache and removes its marker, inside its 4.5 s cap.
      await until(() => refreshDone(cacheDir), 10_000, 'the refresh child to end');
      expect(npmStub.hits()).toBe(1);
      const cached = JSON.parse(await fsp.readFile(path.join(cacheDir, CACHE_FILENAME), 'utf-8')) as {
        latest_version: string;
      };
      expect(cached.latest_version).toBe(NEWER_VERSION);

      // The next run reads it and shows the banner, with no npm call of its own.
      const third = mountStatus({ vaultRoot: vault.root });
      await waitFor(
        third.lastFrame,
        (f) => f.includes(`shardmind ${NEWER_VERSION}`) && /shardmind\/minimal/.test(f),
        15_000,
      );
      expect(npmStub.hits()).toBe(1);
    } finally {
      await until(() => refreshDone(cacheDir), 10_000, 'the refresh child to end').catch(() => {});
      if (vault) await vault.cleanup();
    }
  }, 60_000);

  // ───── 9. Banner suppressed when npm stub returns 5xx (offline-ish) ─────

  it('9. npm offline (5xx): the refresh writes nothing and no banner ever renders', async () => {
    const cacheDir = enableBanner();
    npmStub.setStatus(503);
    const { stub, fixtures } = getCtx();
    stub.setVersion(SHARD_SLUG, '0.1.0', fixtures.byVersion['0.1.0']!);
    stub.setLatest(SHARD_SLUG, '0.1.0');
    let vault: Vault | null = null;
    try {
      vault = await createInstalledVault({
        stub,
        shardRef: SHARD_REF,
        values: DEFAULT_VALUES,
        prefix: 's113-8-503',
      });
      const r = mountStatus({ vaultRoot: vault.root });
      const frame = await waitFor(
        r.lastFrame,
        (f) => /shardmind\/minimal/.test(f) && /managed file/.test(f),
        15_000,
      );
      expect(frame).not.toContain(`shardmind ${NEWER_VERSION}`);
      // The child asked npm, got a 503, wrote no cache and removed its marker.
      await until(() => npmStub.hits() === 1 && refreshDone(cacheDir), 10_000, 'the refresh child to end');
      expect(fs.existsSync(path.join(cacheDir, CACHE_FILENAME))).toBe(false);
    } finally {
      await until(() => refreshDone(cacheDir), 10_000, 'the refresh child to end').catch(() => {});
      if (vault) await vault.cleanup();
    }
  }, 60_000);
});
