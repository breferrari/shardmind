/**
 * Local HTTP server that emulates the GitHub REST endpoints the CLI
 * consumes:
 *
 *   GET  /repos/:owner/:repo/releases?per_page=N → `[{ tag_name, prerelease }, …]`
 *   HEAD /repos/:owner/:repo/tarball/v<ver>      → 200 OK (verifyTarball preflight)
 *   GET  /repos/:owner/:repo/tarball/v<ver>      → streams the fixture tarball
 *
 * The production registry (`source/core/registry.ts`) reads its base URL
 * from `SHARDMIND_GITHUB_API_BASE`, which the E2E runner points at the
 * address returned here. No real network traffic leaves the machine.
 *
 * Binds to 127.0.0.1:0 so the OS picks a free port; tests read `url`
 * back to construct the env-var value. `setLatest` mirrors the prior
 * v0.1 behavior — it sets the single non-prerelease entry returned from
 * the `/releases` listing, which is what most tests want. Tests that
 * need richer release lists (prerelease mixes, beta-only repos) override
 * `releases` directly via `ShardSpec.releases`.
 *
 * Anything the CLI asks for that isn't registered is returned as a
 * structured 404. This is louder than silently 200-ing empty bodies —
 * misrouted test traffic surfaces as an obvious failure.
 */

import http from 'node:http';
import { AddressInfo } from 'node:net';
import fs from 'node:fs';
import { createReadStream } from 'node:fs';

export interface ShardSpec {
  /** Version → absolute path to the fixture tarball. */
  versions: Record<string, string>;
  /**
   * Current "latest stable" tag, without the `v` prefix. Used to derive
   * the single non-prerelease entry the `/releases` listing serves when
   * `releases` isn't provided. Mutable via `setLatest`; the older bumping
   * pattern (used by every existing scenario) still works unchanged.
   */
  latest: string;
  /**
   * Explicit `/releases` listing. When provided, replaces the
   * single-stable derivation from `latest`. Each entry shapes after the
   * subset of GitHub's release object the engine reads (`tag_name`,
   * `prerelease`). Order matches what the production API returns —
   * sorted by `created_at` DESC, newest first.
   *
   * Use for prerelease mixes, beta-only repos, malformed-entries
   * scenarios, etc. `setLatest` is a no-op when `releases` is set.
   */
  releases?: ReleaseListEntry[];
  /**
   * Ref-name → 40-char hex SHA. Backs the `/commits/<ref>` endpoint.
   * The same SHA also gates the `/tarball/<sha>` endpoint via
   * `shaTarballs`, so a test can pin a ref to a tarball deterministically.
   */
  refs?: Record<string, string>;
  /**
   * 40-char hex SHA → absolute path to the fixture tarball. Used by the
   * ref-install path: `resolve()` resolves a ref to a SHA, then HEADs
   * `/tarball/<sha>` (no `v` prefix). The download path streams the
   * fixture bytes the same way `versions` does for tag installs.
   */
  shaTarballs?: Record<string, string>;
}

export interface ReleaseListEntry {
  tag_name: string;
  prerelease: boolean;
}

export interface GitHubStubOptions {
  shards: Record<string, ShardSpec>;
  /**
   * Artificial latency injected into the tarball GET response (milliseconds).
   * Defaults to 0. SIGINT-rollback tests bump this so the download phase is
   * long enough for the parent to inject a signal mid-flight — without it,
   * local-stub installs complete in ~200 ms and every signalled scenario
   * collapses into "install completed before SIGINT arrived".
   */
  tarballDelayMs?: number;
}

export interface GitHubStub {
  /** Base URL to pass as `SHARDMIND_GITHUB_API_BASE`. */
  url: string;
  /** Atomically change the "latest" for a shard. Takes effect on next request. */
  setLatest: (slug: string, version: string) => void;
  /**
   * Atomically point a ref at a SHA (and the SHA at a fixture tarball).
   * Used by ref-install + branch-bump update scenarios. Both endpoints
   * (`/commits/<ref>` and `/tarball/<sha>`) start serving the new
   * mapping on the next request.
   */
  setRef: (slug: string, ref: string, sha: string, tarballPath: string) => void;
  /** Configure tarball GET latency. Takes effect on next request. */
  setTarballDelay: (ms: number) => void;
  /** Shut down the server. Always call in `afterEach` / `afterAll`. */
  close: () => Promise<void>;
}

// Widened to `[a-z0-9._-]` so the stub matches real GitHub's owner/repo
// URL space. ShardMind's own ref parser (`source/core/registry.ts:27`)
// is stricter and rejects `.`/`_` in slugs today, but a future loosening
// or a hand-written request via `SHARDMIND_GITHUB_API_BASE` must not be
// 404'd by the stub for cosmetic reasons. Matches the URL grammar GitHub
// documents for tarball downloads.
const TARBALL_TAG_RE = /^\/repos\/([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)\/tarball\/v(.+)$/i;
const TARBALL_SHA_RE =
  /^\/repos\/([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)\/tarball\/([a-f0-9]{40})$/i;
// Matches the listing endpoint regardless of `?per_page=N`. The engine
// requests `?per_page=100`; older transitional code paths or a future
// pagination patch must not be 404'd here.
const RELEASES_LIST_RE =
  /^\/repos\/([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)\/releases(?:\?[^/]*)?$/i;
// Mirrors the production `GET /repos/:o/:r/commits/:ref` endpoint. Refs
// can carry slashes (`feature/foo` URL-encodes to `feature%2Ffoo`); the
// regex captures everything after `/commits/` and the handler decodes.
const COMMITS_RE = /^\/repos\/([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)\/commits\/(.+)$/i;

export async function createGitHubStub(options: GitHubStubOptions): Promise<GitHubStub> {
  const shards = new Map<string, ShardSpec>();
  for (const [slug, spec] of Object.entries(options.shards)) {
    shards.set(slug.toLowerCase(), { ...spec });
  }
  let tarballDelayMs = options.tarballDelayMs ?? 0;
  // Outstanding tarball-delay timers. Tracked so `close()` can clear them
  // synchronously — otherwise a slow test firing SIGINT mid-download
  // leaves pending timers that keep the vitest worker alive past
  // `afterAll`, and the eventual callback tries to `res.write` a socket
  // the client has already destroyed.
  const pendingTimers = new Set<NodeJS.Timeout>();

  const server = http.createServer((req, res) => {
    const method = req.method ?? 'GET';
    const pathname = req.url ?? '/';

    try {
      const releasesMatch = RELEASES_LIST_RE.exec(pathname);
      if (releasesMatch) {
        const [, owner, repo] = releasesMatch;
        const spec = shards.get(`${owner!.toLowerCase()}/${repo!.toLowerCase()}`);
        if (!spec) return sendJson(res, 404, { message: 'Not Found' });
        // Honor explicit listing when set; fall back to a single stable
        // entry derived from `latest` so existing scenarios that only
        // call `setLatest` keep working.
        const list: ReleaseListEntry[] = spec.releases ?? [
          { tag_name: `v${spec.latest}`, prerelease: false },
        ];
        return sendJson(res, 200, list);
      }

      const commitsMatch = COMMITS_RE.exec(pathname);
      if (commitsMatch) {
        const [, owner, repo, encodedRef] = commitsMatch;
        const spec = shards.get(`${owner!.toLowerCase()}/${repo!.toLowerCase()}`);
        if (!spec) return sendJson(res, 404, { message: 'Not Found' });
        const ref = decodeURIComponent(encodedRef!);
        const sha = spec.refs?.[ref];
        if (!sha) return sendJson(res, 404, { message: `Ref '${ref}' not found` });
        return sendJson(res, 200, { sha });
      }

      // SHA-style tarball comes first: a 40-char hex looks like a "version"
      // to the v-prefixed regex, so order matters.
      const tarballShaMatch = TARBALL_SHA_RE.exec(pathname);
      const tarballTagMatch = tarballShaMatch ? null : TARBALL_TAG_RE.exec(pathname);
      const tarballMatch = tarballShaMatch ?? tarballTagMatch;
      if (tarballMatch) {
        const [, owner, repo, key] = tarballMatch;
        const spec = shards.get(`${owner!.toLowerCase()}/${repo!.toLowerCase()}`);
        if (!spec) return sendJson(res, 404, { message: 'Not Found' });
        const tarPath = tarballShaMatch
          ? spec.shaTarballs?.[key!.toLowerCase()]
          : spec.versions[key!];
        if (!tarPath) {
          const subject = tarballShaMatch ? `Commit ${key}` : `Tag v${key}`;
          return sendJson(res, 404, { message: `${subject} not found` });
        }
        if (method === 'HEAD') {
          res.writeHead(200, { 'content-type': 'application/gzip' });
          res.end();
          return;
        }
        // GET — stream the tarball bytes. Optionally delayed so SIGINT-
        // rollback tests can reliably inject a signal while the child is
        // still in the download phase.
        if (!fs.existsSync(tarPath)) {
          return sendJson(res, 500, { message: `Fixture missing on disk: ${tarPath}` });
        }
        const sendTarball = () => {
          // Client may have disconnected during the delay (test signalled
          // SIGINT, download tempdir torn down). Don't try to write
          // headers or data into a destroyed response.
          if (res.destroyed || res.writableEnded) return;
          res.writeHead(200, { 'content-type': 'application/gzip' });
          const stream = createReadStream(tarPath);
          stream.pipe(res);
          stream.on('error', () => {
            res.destroy();
          });
        };
        if (tarballDelayMs > 0) {
          const timer = setTimeout(() => {
            pendingTimers.delete(timer);
            sendTarball();
          }, tarballDelayMs);
          // `.unref()` so a forgotten client request doesn't keep the
          // worker alive past suite teardown.
          timer.unref();
          pendingTimers.add(timer);
          // Also clean up if the client disconnects mid-delay.
          res.once('close', () => {
            if (pendingTimers.delete(timer)) clearTimeout(timer);
          });
        } else {
          sendTarball();
        }
        return;
      }

      // Fallthrough: anything else is a misroute.
      sendJson(res, 404, { message: 'Not Found', path: pathname });
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
      } else {
        res.destroy();
      }
    }
  });

  // `unref()` prevents the server from keeping the process alive past a
  // forgotten close() — defensive against test hang-on-exit.
  server.unref();

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    setLatest: (slug, version) => {
      const spec = shards.get(slug.toLowerCase());
      if (!spec) throw new Error(`setLatest: unknown shard ${slug}`);
      spec.latest = version;
    },
    setRef: (slug, ref, sha, tarballPath) => {
      const spec = shards.get(slug.toLowerCase());
      if (!spec) throw new Error(`setRef: unknown shard ${slug}`);
      // Coerce both ref→sha and sha→tarball maps lazily so existing
      // shard specs that don't define refs at construction time keep
      // working.
      spec.refs = { ...(spec.refs ?? {}), [ref]: sha };
      spec.shaTarballs = { ...(spec.shaTarballs ?? {}), [sha.toLowerCase()]: tarballPath };
    },
    setTarballDelay: (ms) => {
      tarballDelayMs = Math.max(0, ms);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Drain any tarball-delay timers first so the close callback isn't
        // blocked on an in-flight delayed send.
        for (const t of pendingTimers) clearTimeout(t);
        pendingTimers.clear();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

