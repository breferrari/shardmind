import type { ResolvedShard } from '../runtime/types.js';
import { ShardMindError } from '../runtime/types.js';

/**
 * Base URL for the GitHub REST API. Defaults to the public endpoint; the
 * `SHARDMIND_GITHUB_API_BASE` environment variable overrides it. Read once
 * at module load because hot-swapping API endpoints mid-process would mean
 * install and update could reach different hosts on the same run, which
 * no downstream consumer is prepared to reason about.
 *
 * Used by `fetchLatestRelease`, `resolve` (tarball URL construction), and
 * indirectly by `verifyTag` (which consumes `resolve`'s tarball URL). The
 * E2E suite sets this to the local GitHub-stub address so no test hits
 * the real internet; future work (#34 validate, #39 alternate registries,
 * GHE support) also consumes it.
 *
 * Surrounding whitespace is trimmed and trailing slashes are stripped —
 * env values copied from docs or a CI secret store frequently pick up
 * leading newlines or a stray trailing `/`, and `safeFetch`'s error path
 * calls `new URL(url).host`, which throws on garbage input and turns a
 * network error into a confusing second exception.
 */
const GITHUB_API_BASE = (process.env['SHARDMIND_GITHUB_API_BASE'] ?? 'https://api.github.com')
  .trim()
  .replace(/\/+$/, '');

/**
 * URL for the shared shard registry index. Overridable via
 * `SHARDMIND_REGISTRY_INDEX_URL` — same rationale as `GITHUB_API_BASE`.
 * Non-direct `namespace/name` refs go through this file. Whitespace is
 * trimmed for the same reason as above.
 */
const REGISTRY_INDEX_URL = (
  process.env['SHARDMIND_REGISTRY_INDEX_URL'] ??
  'https://raw.githubusercontent.com/shardmind/registry/main/index.json'
).trim();

// Provisional index.json shape. Not yet ratified in IMPLEMENTATION.md §4.1 —
// the registry repo is created at Milestone 6 and the format will be finalized
// then. See #29 for the open questions and the "what to do" checklist.
interface RegistryEntry {
  repo: string;
  latest: string;
  versions: string[];
}

interface RegistryIndex {
  shards: Record<string, RegistryEntry>;
}

interface ParsedRef {
  direct: boolean;
  namespace: string;
  name: string;
  version: string | null;
}

const SHARD_REF_RE = /^(github:)?([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)(?:@(.+))?$/;

/**
 * Cheap read-only "what is the latest tag?" lookup for a `github:owner/repo`
 * source. Used by the update-check cache (see `core/update-check.ts`) so the
 * status command can tell a user whether their installed shard is behind
 * the latest release, without paying for `resolve()`'s tarball HEAD check
 * (which `update` still needs because it actually downloads the tarball).
 *
 * Rejects non-`github:` sources with `REGISTRY_INVALID_REF` — the registry
 * path goes through `resolve()`, which is the authority for that shape.
 *
 * Accepts an optional `AbortSignal` so callers with a wall-clock budget
 * (e.g. the status command's 4-second update-check budget) can cancel the
 * underlying HTTP request instead of letting a hanging TCP socket leak
 * past the timeout. Without this, `Promise.race` around the call would
 * resolve the caller but the `fetch` would keep the socket open.
 *
 * The `includePrerelease` option widens resolution from "newest non-
 * prerelease" (default — what status + the default update path want) to
 * "newest release of any kind". `update --include-prerelease` threads
 * this in; the status-cache path leaves it false because the cache is
 * defined as "latest stable" (see `core/update-check.ts`).
 *
 * @param source The `state.source` string recorded at install time
 *   (e.g. `"github:breferrari/obsidian-mind"`).
 * @param options.signal Optional abort signal forwarded to the HTTP client.
 * @param options.includePrerelease When true, prereleases are eligible.
 * @returns The normalized semver string (leading `v` stripped).
 * @throws `ShardMindError` with the same code set `fetchLatestRelease` emits
 *   (`REGISTRY_NETWORK`, `REGISTRY_RATE_LIMITED`, `NO_RELEASES_PUBLISHED`,
 *   `SHARD_NOT_FOUND`).
 */
export async function fetchLatestVersion(
  source: string,
  options: { signal?: AbortSignal; includePrerelease?: boolean } = {},
): Promise<string> {
  if (!source.startsWith('github:')) {
    throw new ShardMindError(
      `fetchLatestVersion only supports github: sources, got: '${source}'`,
      'REGISTRY_INVALID_REF',
      'Non-GitHub registries are not implemented yet.',
    );
  }

  const rest = source.slice('github:'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) {
    throw new ShardMindError(
      `Malformed github source: '${source}'`,
      'REGISTRY_INVALID_REF',
      'Expected "github:owner/repo".',
    );
  }

  const owner = rest.slice(0, slash);
  const repo = rest.slice(slash + 1);
  return fetchLatestRelease(owner, repo, {
    signal: options.signal,
    includePrerelease: options.includePrerelease ?? false,
  });
}

export async function resolve(
  shardRef: string,
  options: { includePrerelease?: boolean } = {},
): Promise<ResolvedShard> {
  const parsed = parseRef(shardRef);

  let version: string;
  let source: string;
  let repoOwner: string;
  let repoName: string;

  if (parsed.direct) {
    repoOwner = parsed.namespace;
    repoName = parsed.name;
    source = `github:${repoOwner}/${repoName}`;
    version =
      parsed.version ??
      (await fetchLatestRelease(repoOwner, repoName, {
        includePrerelease: options.includePrerelease ?? false,
      }));
  } else {
    const index = await fetchRegistryIndex();
    const key = `${parsed.namespace}/${parsed.name}`;
    const entry = index.shards[key];

    if (!entry) {
      throw new ShardMindError(
        `Shard '${key}' not found`,
        'SHARD_NOT_FOUND',
        'Check spelling or use github:owner/repo for direct install.',
      );
    }

    if (parsed.version && !entry.versions.includes(parsed.version)) {
      throw new ShardMindError(
        `Version ${parsed.version} not found for ${key}. Available: ${entry.versions.join(', ')}`,
        'VERSION_NOT_FOUND',
        'Pick an available version or omit @version for the latest.',
      );
    }

    const repoParts = entry.repo.split('/');
    if (repoParts.length !== 2 || !repoParts[0] || !repoParts[1]) {
      throw new ShardMindError(
        `Registry entry for '${key}' has invalid repo field: '${entry.repo}'`,
        'REGISTRY_NETWORK',
        'Expected "owner/name" format.',
      );
    }
    repoOwner = repoParts[0];
    repoName = repoParts[1];
    version = parsed.version ?? entry.latest;
    source = `github:${entry.repo}`;
  }

  const tarballUrl = `${GITHUB_API_BASE}/repos/${repoOwner}/${repoName}/tarball/v${version}`;
  await verifyTag(tarballUrl, repoOwner, repoName, version);

  return {
    namespace: parsed.namespace,
    name: parsed.name,
    version,
    source,
    tarballUrl,
  };
}

function parseRef(shardRef: string): ParsedRef {
  const match = SHARD_REF_RE.exec(shardRef.trim());
  if (!match) {
    throw new ShardMindError(
      `Invalid shard reference: '${shardRef}'`,
      'REGISTRY_INVALID_REF',
      'Expected "namespace/name", "namespace/name@version", or "github:namespace/name[@version]".',
    );
  }
  const [, directPrefix, namespace, name, version] = match;
  return {
    direct: Boolean(directPrefix),
    namespace: namespace!,
    name: name!,
    version: version ?? null,
  };
}

async function fetchRegistryIndex(): Promise<RegistryIndex> {
  const response = await safeFetch(REGISTRY_INDEX_URL);

  if (!response.ok) {
    throw new ShardMindError(
      `Could not fetch shard registry: HTTP ${response.status}`,
      'REGISTRY_NETWORK',
      'The registry index is unavailable. Try again later or use github:owner/repo for direct install.',
    );
  }

  let body: string;
  try {
    body = await response.text();
  } catch (err) {
    throw new ShardMindError(
      'Failed to read registry response',
      'REGISTRY_NETWORK',
      err instanceof Error ? err.message : String(err),
    );
  }

  try {
    const parsed = JSON.parse(body) as RegistryIndex;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !parsed.shards ||
      typeof parsed.shards !== 'object' ||
      Array.isArray(parsed.shards)
    ) {
      throw new Error('Missing or invalid "shards" field');
    }
    return parsed;
  } catch (err) {
    throw new ShardMindError(
      'Registry index is corrupt',
      'REGISTRY_NETWORK',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Page size for the `/releases` listing. 100 is GitHub's documented per-page
 * cap on the releases endpoint; bumping the cap is not possible. For repos
 * with more than 100 releases ahead of any stable, the first page may
 * legitimately contain only prereleases — pagination is documented as a
 * known limitation rather than implemented in v0.1, since the realistic
 * shape (≤30 releases per shard) makes it a non-issue today.
 */
const RELEASES_PAGE_SIZE = 100;

interface ReleaseEntry {
  tag_name: string;
  prerelease: boolean;
}

/**
 * Resolve "newest release matching policy" for a GitHub repo. Replaces the
 * v0.1 `/releases/latest` call (which 404s for repos that publish only
 * prereleases — see `ARCHITECTURE.md §10.7`) with a single-page list call
 * that filters in code.
 *
 * Default policy: `includePrerelease: false` returns the first non-
 * prerelease entry (the previous `/releases/latest` semantics). When
 * `includePrerelease: true`, the first entry of any kind is returned —
 * matches `update --include-prerelease`.
 *
 * Errors keep the existing code-set: `REGISTRY_RATE_LIMITED` for an
 * authenticated-rate exceedance, `SHARD_NOT_FOUND` when the repo itself
 * is missing (404 on `/releases` only fires for missing repos — empty
 * release lists return 200 with `[]`), `NO_RELEASES_PUBLISHED` when the
 * filter eliminates every entry, and `REGISTRY_NETWORK` for any other
 * upstream surprise. The `NO_RELEASES_PUBLISHED` hint differentiates
 * "repo has zero releases" from "repo has only prereleases" so the user
 * can choose between publishing a release and re-running with
 * `--include-prerelease`.
 */
async function fetchLatestRelease(
  namespace: string,
  name: string,
  opts: { signal?: AbortSignal; includePrerelease?: boolean } = {},
): Promise<string> {
  const url = `${GITHUB_API_BASE}/repos/${namespace}/${name}/releases?per_page=${RELEASES_PAGE_SIZE}`;
  const response = await safeFetch(url, { ...githubHeaders(), signal: opts.signal });

  if (response.status === 403 && isRateLimited(response)) {
    throw rateLimitError();
  }

  if (response.status === 404) {
    // `/releases` 404 means the repo itself doesn't exist or is private to
    // an unauthenticated client — distinct from "no releases yet" (200 with
    // empty array). SHARD_NOT_FOUND is the closest existing code; the hint
    // disambiguates direct mode from registry mode.
    throw new ShardMindError(
      `Repository ${namespace}/${name} not found`,
      'SHARD_NOT_FOUND',
      `github.com/${namespace}/${name} returned 404. Check spelling or set GITHUB_TOKEN if the repo is private.`,
    );
  }

  if (!response.ok) {
    throw new ShardMindError(
      `Could not fetch releases for ${namespace}/${name}: HTTP ${response.status}`,
      'REGISTRY_NETWORK',
      'GitHub API returned an unexpected status.',
    );
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (err) {
    throw new ShardMindError(
      'Malformed response from GitHub releases API',
      'REGISTRY_NETWORK',
      err instanceof Error ? err.message : String(err),
    );
  }

  if (!Array.isArray(data)) {
    throw new ShardMindError(
      `Releases response for ${namespace}/${name} is not an array`,
      'REGISTRY_NETWORK',
      'GitHub returned a non-array body where a list of releases was expected.',
    );
  }

  // Skip malformed entries silently — a single bad entry shouldn't take down
  // an otherwise-resolvable list. Empty `tag_name` strings are also dropped
  // because they would produce a useless `tarball/v` URL downstream.
  const releases = data.filter((entry): entry is ReleaseEntry => {
    if (!entry || typeof entry !== 'object') return false;
    const e = entry as { tag_name?: unknown; prerelease?: unknown };
    return (
      typeof e.tag_name === 'string' &&
      e.tag_name.length > 0 &&
      typeof e.prerelease === 'boolean'
    );
  });

  const includePrerelease = opts.includePrerelease ?? false;
  const eligible = includePrerelease ? releases : releases.filter((r) => !r.prerelease);

  if (eligible.length === 0) {
    const onlyPrereleasesExist = !includePrerelease && releases.some((r) => r.prerelease);
    const hint = onlyPrereleasesExist
      ? `${namespace}/${name} has only prerelease versions. Re-run with --include-prerelease to install one, or specify a stable version with @version once published.`
      : `Specify a version explicitly with @version, or publish a GitHub release for ${namespace}/${name}.`;
    throw new ShardMindError(
      `No releases found for ${namespace}/${name}`,
      'NO_RELEASES_PUBLISHED',
      hint,
    );
  }

  // GitHub's `/releases` returns entries sorted by `created_at` DESC by
  // default — first eligible entry is the newest. Same convention status
  // expects when reporting "latest available".
  const tag = eligible[0]!.tag_name;
  return tag.startsWith('v') ? tag.slice(1) : tag;
}

async function verifyTag(
  tarballUrl: string,
  namespace: string,
  name: string,
  version: string,
): Promise<void> {
  const response = await safeFetch(tarballUrl, { ...githubHeaders(), method: 'HEAD' });

  if (response.ok || response.status === 302) return;

  if (response.status === 403 && isRateLimited(response)) {
    throw rateLimitError();
  }

  if (response.status === 404) {
    throw new ShardMindError(
      `Version ${version} not found for ${namespace}/${name}`,
      'VERSION_NOT_FOUND',
      `Tag v${version} does not exist on github.com/${namespace}/${name}.`,
    );
  }

  throw new ShardMindError(
    `Could not verify tag v${version} for ${namespace}/${name}: HTTP ${response.status}`,
    'REGISTRY_NETWORK',
    'GitHub API returned an unexpected status.',
  );
}

function githubHeaders(): { headers: Record<string, string> } {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
  };
  const token = process.env['GITHUB_TOKEN'];
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return { headers };
}

function isRateLimited(response: Response): boolean {
  const remaining = response.headers.get('x-ratelimit-remaining');
  return remaining === '0';
}

function rateLimitError(): ShardMindError {
  return new ShardMindError(
    'GitHub API rate limit reached',
    'REGISTRY_RATE_LIMITED',
    'Set GITHUB_TOKEN for higher limits (5000 req/hr vs 60 unauthenticated).',
  );
}

async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    throw new ShardMindError(
      `Could not reach ${new URL(url).host}`,
      'REGISTRY_NETWORK',
      err instanceof Error ? err.message : String(err),
    );
  }
}
