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
 * The harness inverts default suppression: `setupFlowSuite` sets
 * `SHARDMIND_NO_UPDATE_CHECK=1` so existing flow files don't race a
 * live npm fetch. This file's tests delete that var per-test and
 * point the hook at a local HTTP stub via
 * `SHARDMIND_SELF_UPDATE_REGISTRY_URL`. The cache dir is also redirected
 * to a per-test tmpdir so the developer's real `~/.cache/shardmind`
 * stays untouched.
 *
 * Spec citation: ROADMAP §0.1.x Foundation #113;
 * docs/IMPLEMENTATION.md §4.16 (Self-update check).
 */

import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { cleanup } from 'ink-testing-library';
import http from 'node:http';
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
  setVersion(v: string): void;
  setStatus(s: number): void;
  reset(): void;
  close(): Promise<void>;
}

async function createNpmStub(): Promise<NpmStub> {
  let version = NEWER_VERSION;
  let status = 200;
  const server = http.createServer((_req, res) => {
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
    setVersion: (v) => {
      version = v;
    },
    setStatus: (s) => {
      status = s;
    },
    reset: () => {
      version = NEWER_VERSION;
      status = 200;
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
    // Per-test cache dir keeps the dev's real ~/.cache/shardmind clean
    // and avoids one test's cache hit suppressing the next test's fetch.
    const cacheDir = path.join(cacheDirParent, crypto.randomUUID());
    process.env['SHARDMIND_SELF_UPDATE_CACHE_DIR'] = cacheDir;
    return cacheDir;
  }

  // ───── 1. --no-update-check flag suppresses the banner (status command) ─────

  it('1. --no-update-check flag suppresses the banner on status', async () => {
    enableBanner();
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
        options: { noUpdateCheck: true },
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
    } finally {
      if (vault) await vault.cleanup();
    }
  }, 60_000);

  // ───── 2. SHARDMIND_NO_UPDATE_CHECK env suppresses ─────

  it('2. SHARDMIND_NO_UPDATE_CHECK env suppresses the banner on status', async () => {
    enableBanner();
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
    } finally {
      if (vault) await vault.cleanup();
    }
  }, 60_000);

  // ───── 3. CI env suppresses ─────

  it('3. CI env suppresses the banner on status', async () => {
    enableBanner();
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
    } finally {
      if (vault) await vault.cleanup();
    }
  }, 60_000);

  // ───── 4. Banner renders above status when allowed ─────

  it('4. banner renders above StatusView when force-TTY + outdated', async () => {
    enableBanner();
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
      // Wait for the banner string to land. The status report rendering
      // and the self-update fetch race; both complete inside seconds.
      const frame = await waitFor(
        r.lastFrame,
        (f) =>
          f.includes(`shardmind ${NEWER_VERSION}`) &&
          f.includes('npm install -g shardmind@latest') &&
          /shardmind\/minimal/.test(f),
        15_000,
      );
      // Banner is above the status header (StatusView's first line is
      // the namespace/name + version badge). String-position check
      // pins the layout decision the index.tsx Box wrapper enforces.
      expect(frame.indexOf(`shardmind ${NEWER_VERSION}`)).toBeLessThan(
        frame.indexOf('shardmind/minimal'),
      );
      expect(frame).toContain(`(you have ${CURRENT_VERSION})`);
    } finally {
      if (vault) await vault.cleanup();
    }
  }, 60_000);

  // ───── 5. Banner renders above install's wizard ─────

  it('5. banner renders above InstallWizard header when force-TTY + outdated', async () => {
    enableBanner();
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
      // The banner appears as soon as the npm stub answers; the wizard
      // header appears once the install pipeline finishes resolving +
      // downloading + parsing the shard. Both must coexist in some
      // frame. Wait for the wizard header (slower path) — by then the
      // banner is guaranteed to have landed.
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

  it('6. banner suppressed when current === latest (npm stub returns same version)', async () => {
    enableBanner();
    npmStub.setVersion(CURRENT_VERSION);
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
      await waitFor(
        r.lastFrame,
        (f) => /shardmind\/minimal/.test(f) && /managed file/.test(f),
        15_000,
      );
      // Settle window: even if the stub answers fast, banner must
      // never render because semver.lt(current, current) is false.
      await tick(200);
      const frame = r.lastFrame() ?? '';
      expect(frame).not.toContain(`shardmind ${CURRENT_VERSION} available`);
      expect(frame).not.toContain('npm install -g shardmind@latest');
    } finally {
      if (vault) await vault.cleanup();
    }
  }, 60_000);

  // ───── 7. First frame is banner-less (zero observable latency) ─────

  it('7. first rendered frame never contains the banner — banner is async', async () => {
    enableBanner();
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
      // hook additionally defers the fetch by `setTimeout(0)`.
      const firstFrame = r.lastFrame() ?? '';
      expect(firstFrame).not.toContain(`shardmind ${NEWER_VERSION}`);
      expect(firstFrame).not.toContain('npm install -g shardmind@latest');
      // Then the banner should arrive in a later frame.
      await waitFor(
        r.lastFrame,
        (f) => f.includes(`shardmind ${NEWER_VERSION}`),
        15_000,
      );
    } finally {
      if (vault) await vault.cleanup();
    }
  }, 60_000);

  // ───── 8. Banner suppressed when npm stub returns 5xx (offline-ish) ─────

  it('8. banner suppressed when npm registry is offline (5xx response)', async () => {
    enableBanner();
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
      // Use status to give the self-update fetch time to attempt + fail
      // before the command exits. Capture the frame from waitFor's
      // return value rather than re-reading lastFrame() afterwards: the
      // status command calls `exit()` ~50ms after the ready render and
      // testing-library's buffer clears on exit (same caveat as
      // status-flow.test.tsx scenarios 24-25).
      const r = mountStatus({ vaultRoot: vault.root });
      const frame = await waitFor(
        r.lastFrame,
        (f) => /shardmind\/minimal/.test(f) && /managed file/.test(f),
        15_000,
      );
      // Banner must not appear when the npm registry returns 5xx.
      // checkSelfUpdate collapses 503 → null → no setState → banner stays null.
      expect(frame).not.toContain(`shardmind ${NEWER_VERSION}`);
      expect(frame).not.toContain('npm install -g shardmind@latest');
    } finally {
      if (vault) await vault.cleanup();
    }
  }, 60_000);
});
