/**
 * Local HTTP server that emulates the three GitHub REST endpoints the
 * CLI consumes:
 *
 *   GET  /repos/:owner/:repo/releases/latest → `{ tag_name: "v<latest>" }`
 *   HEAD /repos/:owner/:repo/tarball/v<ver>  → 200 OK (verifyTag preflight)
 *   GET  /repos/:owner/:repo/tarball/v<ver>  → streams the fixture tarball
 *
 * The production registry (`source/core/registry.ts`) reads its base URL
 * from `SHARDMIND_GITHUB_API_BASE`, which the E2E runner points at the
 * address returned here. No real network traffic leaves the machine.
 *
 * Binds to 127.0.0.1:0 so the OS picks a free port; tests read `url`
 * back to construct the env-var value. `setLatest` allows the suite to
 * bump the "latest release" mid-session (drives the update-available
 * status scenario without restarting the server).
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
  /** Current "latest" tag, without the `v` prefix. */
  latest: string;
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
const TARBALL_RE = /^\/repos\/([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)\/tarball\/v(.+)$/i;
const LATEST_RE = /^\/repos\/([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)\/releases\/latest$/i;

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
      const latestMatch = LATEST_RE.exec(pathname);
      if (latestMatch) {
        const [, owner, repo] = latestMatch;
        const spec = shards.get(`${owner!.toLowerCase()}/${repo!.toLowerCase()}`);
        if (!spec) return sendJson(res, 404, { message: 'Not Found' });
        return sendJson(res, 200, { tag_name: `v${spec.latest}` });
      }

      const tarballMatch = TARBALL_RE.exec(pathname);
      if (tarballMatch) {
        const [, owner, repo, version] = tarballMatch;
        const spec = shards.get(`${owner!.toLowerCase()}/${repo!.toLowerCase()}`);
        if (!spec) return sendJson(res, 404, { message: 'Not Found' });
        const tarPath = spec.versions[version!];
        if (!tarPath) return sendJson(res, 404, { message: `Tag v${version} not found` });
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

