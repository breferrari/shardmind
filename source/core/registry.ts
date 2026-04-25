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
  /**
   * Set when the input used `github:owner/repo#<ref>` syntax. Mutually
   * exclusive with `version` — the regex below ensures a single ref can
   * only carry a tag pin OR a commit-ref pin, never both.
   */
  ref: string | null;
}

/**
 * Shard reference syntax:
 *   - `namespace/name` — registry index, latest stable.
 *   - `namespace/name@version` — registry index, exact version.
 *   - `github:namespace/name` — direct GitHub, latest stable.
 *   - `github:namespace/name@version` — direct GitHub, exact tag.
 *   - `github:namespace/name#<ref>` — direct GitHub, branch / tag / SHA.
 *
 * The `(?:@…|#…)?` alternation makes `@version` and `#ref` mutually
 * exclusive at parse time. `[^#\s]+` for versions blocks `@v#ref`;
 * `[^@\s]+` for refs blocks `#ref@v` and refs with embedded whitespace.
 * Owner / repo stay strictly lowercase + hyphens (existing constraint).
 */
const SHARD_REF_RE =
  /^(github:)?([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)(?:@([^#\s]+)|#([^@\s]+))?$/;

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

  if (parsed.ref !== null) {
    // Direct-mode ref install. Already enforced by `parseRef`; the
    // `direct` invariant is asserted here so a regex regression that
    // accepts `o/r#main` without `github:` would surface as a typed
    // error instead of a misrouted commit-API call.
    if (!parsed.direct) {
      throw new ShardMindError(
        `Internal: ref install reached resolve() without direct mode: '${shardRef}'`,
        'REGISTRY_INVALID_REF',
        'This is a bug. Please report — parseRef should have rejected this earlier.',
      );
    }
    return resolveRefInstall(parsed.namespace, parsed.name, parsed.ref);
  }

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
  await verifyTarball(tarballUrl, repoOwner, repoName, version, 'tag');

  return {
    namespace: parsed.namespace,
    name: parsed.name,
    version,
    source,
    tarballUrl,
  };
}

/**
 * Resolve `github:owner/repo#<ref>` to a `ResolvedShard` whose tarball
 * URL points at the resolved commit SHA. Two API calls:
 *
 *   1. `GET /repos/:o/:r/commits/<ref>` — get the 40-char SHA.
 *   2. `HEAD /repos/:o/:r/tarball/<sha>` — verify the tarball is fetchable.
 *
 * SHA pinning is what makes ref installs reproducible: a retry mid-
 * download (e.g. transient network) hits the same commit even if the
 * branch HEAD moved between calls. `state.resolvedSha` records the SHA
 * so a future `update` can detect commit movement on the tracked ref.
 */
async function resolveRefInstall(
  namespace: string,
  name: string,
  ref: string,
): Promise<ResolvedShard> {
  const sha = await resolveCommit(namespace, name, ref);
  const tarballUrl = `${GITHUB_API_BASE}/repos/${namespace}/${name}/tarball/${sha}`;
  await verifyTarball(tarballUrl, namespace, name, sha, 'ref', ref);

  return {
    namespace,
    name,
    // Short SHA prefix matches `git log --oneline` convention. State-
    // build sites use `manifest.version` for `state.version`, so this
    // value never lands in state.json.
    version: sha.slice(0, 7),
    source: `github:${namespace}/${name}`,
    tarballUrl,
    ref: { name: ref, commit: sha },
  };
}

function parseRef(shardRef: string): ParsedRef {
  const match = SHARD_REF_RE.exec(shardRef.trim());
  if (!match) {
    throw new ShardMindError(
      `Invalid shard reference: '${shardRef}'`,
      'REGISTRY_INVALID_REF',
      'Expected "namespace/name", "namespace/name@version", "github:namespace/name[@version]", or "github:namespace/name#<ref>".',
    );
  }
  const [, directPrefix, namespace, name, version, ref] = match;
  const direct = Boolean(directPrefix);
  if (ref !== undefined && !direct) {
    // Registry-mode entries don't have ref pinning — the index doesn't
    // record per-branch metadata. Ref installs require the explicit
    // github: prefix so the user is signing up for the direct flow with
    // its different update semantics (re-resolves HEAD on every update).
    throw new ShardMindError(
      `Ref syntax requires the github: prefix: '${shardRef}'`,
      'REGISTRY_INVALID_REF',
      'Use "github:namespace/name#<ref>" to install from a branch, tag, or commit SHA. Registry-mode refs are not supported.',
    );
  }
  return {
    direct,
    namespace: namespace!,
    name: name!,
    version: version ?? null,
    ref: ref ?? null,
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
  // an otherwise-resolvable list. Empty / whitespace-only `tag_name` strings
  // are also dropped because they would produce a useless `tarball/v` URL
  // downstream and make the eventual error confusing.
  const releases = data.filter((entry): entry is ReleaseEntry => {
    if (!entry || typeof entry !== 'object') return false;
    const e = entry as { tag_name?: unknown; prerelease?: unknown };
    return (
      typeof e.tag_name === 'string' &&
      e.tag_name.trim().length > 0 &&
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

/**
 * Resolve a GitHub ref (branch / tag / commit-SHA prefix) to a 40-char
 * commit SHA via `/repos/:o/:r/commits/{ref}`. The endpoint accepts any
 * ref form GitHub recognizes; the encoded path covers refs with `/`
 * separators (`feature/foo`).
 *
 * 404 → `REF_NOT_FOUND`. 422 → `REF_NOT_FOUND` with an "ambiguous SHA"
 * hint (GitHub's documented response for SHA prefixes that match
 * multiple commits). 403 + zero rate-limit-remaining → REGISTRY_RATE_LIMITED.
 * Any other non-OK / network failure / malformed body → REGISTRY_NETWORK.
 */
async function resolveCommit(
  namespace: string,
  name: string,
  ref: string,
  signal?: AbortSignal,
): Promise<string> {
  const url = `${GITHUB_API_BASE}/repos/${namespace}/${name}/commits/${encodeURIComponent(ref)}`;
  const response = await safeFetch(url, { ...githubHeaders(), signal });

  if (response.status === 403 && isRateLimited(response)) {
    throw rateLimitError();
  }

  if (response.status === 404) {
    throw new ShardMindError(
      `Ref '${ref}' not found in ${namespace}/${name}`,
      'REF_NOT_FOUND',
      `No branch, tag, or commit named '${ref}' on github.com/${namespace}/${name}. Check the spelling, or pick a different ref.`,
    );
  }

  if (response.status === 422) {
    // GitHub returns 422 for an ambiguous SHA prefix (matches more than
    // one commit). The user has to disambiguate — extending the prefix
    // is the obvious remedy.
    throw new ShardMindError(
      `Ref '${ref}' is ambiguous in ${namespace}/${name}`,
      'REF_NOT_FOUND',
      'A short SHA prefix matched more than one commit. Re-run with a longer prefix or the full 40-char SHA.',
    );
  }

  if (!response.ok) {
    throw new ShardMindError(
      `Could not resolve ref '${ref}' for ${namespace}/${name}: HTTP ${response.status}`,
      'REGISTRY_NETWORK',
      'GitHub API returned an unexpected status.',
    );
  }

  let data: { sha?: unknown };
  try {
    data = (await response.json()) as { sha?: unknown };
  } catch (err) {
    throw new ShardMindError(
      `Malformed response from GitHub commits API for ref '${ref}'`,
      'REGISTRY_NETWORK',
      err instanceof Error ? err.message : String(err),
    );
  }

  const sha = data.sha;
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/i.test(sha)) {
    throw new ShardMindError(
      `Commit response for ref '${ref}' did not include a valid SHA`,
      'REGISTRY_NETWORK',
      'GitHub returned an unexpected commit shape.',
    );
  }

  return sha.toLowerCase();
}

/**
 * HEAD-verify a tarball URL is fetchable before the caller invests in a
 * full download. The `mode` discriminant shapes the error message and
 * code: tag installs throw `VERSION_NOT_FOUND` on 404 (the tag exists in
 * `/releases` but the tarball couldn't be fetched — usually transient
 * GitHub state); ref installs throw `REF_NOT_FOUND` (the SHA was
 * resolved but the tarball is gone, e.g. a force-push that orphaned the
 * commit between the two API calls).
 *
 * 200 OK and 302 (GitHub redirects tarball URLs to codeload.github.com)
 * both pass.
 */
async function verifyTarball(
  tarballUrl: string,
  namespace: string,
  name: string,
  versionOrSha: string,
  mode: 'tag' | 'ref',
  refLabel?: string,
): Promise<void> {
  const response = await safeFetch(tarballUrl, { ...githubHeaders(), method: 'HEAD' });

  if (response.ok || response.status === 302) return;

  if (response.status === 403 && isRateLimited(response)) {
    throw rateLimitError();
  }

  if (response.status === 404) {
    if (mode === 'tag') {
      throw new ShardMindError(
        `Version ${versionOrSha} not found for ${namespace}/${name}`,
        'VERSION_NOT_FOUND',
        `Tag v${versionOrSha} does not exist on github.com/${namespace}/${name}.`,
      );
    }
    throw new ShardMindError(
      `Tarball for ref '${refLabel ?? versionOrSha}' not found in ${namespace}/${name}`,
      'REF_NOT_FOUND',
      `The commit ${versionOrSha.slice(0, 7)} resolved from '${refLabel ?? versionOrSha}' has no fetchable tarball — usually a force-push that orphaned the commit. Retry, or pick a different ref.`,
    );
  }

  const subject = mode === 'tag' ? `tag v${versionOrSha}` : `tarball for ${versionOrSha.slice(0, 7)}`;
  throw new ShardMindError(
    `Could not verify ${subject} for ${namespace}/${name}: HTTP ${response.status}`,
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
