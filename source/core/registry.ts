import { z } from 'zod';
import { describeZodIssues } from './zod-issues.js';
import type { ResolvedShard } from '../runtime/types.js';
import { ShardMindError } from '../runtime/types.js';

/**
 * Base URL for the GitHub REST API. Defaults to the public endpoint; the
 * `SHARDMIND_GITHUB_API_BASE` environment variable overrides it.
 *
 * Read at call time (not module load) so in-process tests can mutate
 * `process.env` in `beforeAll` AFTER this module has already been pulled
 * in by the static-import graph. Production code paths set the env once
 * before invoking the CLI, so call-time vs load-time read is observably
 * identical there; the testability win is real.
 *
 * Used by `fetchLatestRelease`, `resolve` (tarball URL construction), and
 * indirectly by `verifyTarball` (which consumes `resolve`'s tarball URL).
 * The E2E suite sets this to the local GitHub-stub address via spawned
 * subprocess env; the in-process Layer 1 flow tests set it directly on
 * `process.env`. Future work (#34 validate, #39 alternate registries,
 * GHE support) also consumes it.
 *
 * Surrounding whitespace is trimmed and trailing slashes are stripped —
 * env values copied from docs or a CI secret store frequently pick up
 * leading newlines or a stray trailing `/`, and `safeFetch`'s error path
 * calls `new URL(url).host`, which throws on garbage input and turns a
 * network error into a confusing second exception.
 */
function getGitHubApiBase(): string {
  return (process.env['SHARDMIND_GITHUB_API_BASE'] ?? 'https://api.github.com')
    .trim()
    .replace(/\/+$/, '');
}

/**
 * URL for the shared shard registry index. Overridable via
 * `SHARDMIND_REGISTRY_INDEX_URL` — same call-time-read rationale as
 * `getGitHubApiBase`. Non-direct `namespace/name` refs go through this
 * file. Whitespace is trimmed for the same reason.
 */
function getRegistryIndexUrl(): string {
  return (
    process.env['SHARDMIND_REGISTRY_INDEX_URL'] ??
    'https://raw.githubusercontent.com/shardmind/registry/main/index.json'
  ).trim();
}

/** The registry index format this engine reads (IMPLEMENTATION §4.1, #29). */
const REGISTRY_SCHEMA_VERSION = 1;

/**
 * The index: its format version and the shards map. Entries are checked one
 * at a time, when asked for, so one bad entry cannot break every shard.
 * Unknown fields are ignored: a new optional field does not bump the version.
 */
const RegistryIndexSchema = z.object({
  schema_version: z.number().int().positive(),
  shards: z.record(z.string(), z.unknown()),
});
type RegistryIndex = z.infer<typeof RegistryIndexSchema>;

/** Only the format version: read before the shape, which a newer format may not share. */
const IndexVersionProbe = z.object({ schema_version: z.number().int() });

/**
 * One shard's entry: the GitHub repo that serves it. Its versions are that
 * repo's releases, so a new release never needs a registry change. Unknown
 * fields are ignored (room for, say, a later optional yanked list).
 */
const RegistryEntrySchema = z.object({
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'must be "owner/name"'),
});

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

/** The commands that take a shard ref from the user, named in the bare-ref hint. */
export type RefCommand = 'install' | 'adopt' | 'validate';

/**
 * The hint for a bare `owner/repo` the registry cannot resolve (#200): the
 * exact command that takes the same shard straight from GitHub. There is no
 * fallback to it: a bare ref never resolves through GitHub without the
 * prefix, so a later registry entry can never change what it meant.
 */
function directCommandHint(command: RefCommand, parsed: ParsedRef): string {
  const version = parsed.version === null ? '' : `@${parsed.version}`;
  return `Run shardmind ${command} github:${parsed.namespace}/${parsed.name}${version} to take it straight from GitHub.`;
}

export async function resolve(
  shardRef: string,
  options: { includePrerelease?: boolean; command?: RefCommand } = {},
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

  // A bare ref resolves exactly as `github:<repo>` with the same suffix: the
  // registry only names the repo (#29). Versions come from its releases.
  let repoOwner = parsed.namespace;
  let repoName = parsed.name;

  if (!parsed.direct) {
    const direct = directCommandHint(options.command ?? 'install', parsed);
    const index = await fetchRegistryIndex(direct);
    const key = `${parsed.namespace}/${parsed.name}`;
    const listed = index.shards[key];

    if (listed === undefined) {
      throw new ShardMindError(`Shard '${key}' not found in the registry`, 'SHARD_NOT_FOUND', `Check the spelling. ${direct}`);
    }
    const checked = RegistryEntrySchema.safeParse(listed);
    if (!checked.success) {
      throw new ShardMindError(
        `The registry entry for '${key}' is invalid: ${describeZodIssues(checked.error)}`,
        'REGISTRY_NETWORK',
        direct,
      );
    }

    // The entry schema guarantees exactly one `/` with a name on each side.
    const slash = checked.data.repo.indexOf('/');
    repoOwner = checked.data.repo.slice(0, slash);
    repoName = checked.data.repo.slice(slash + 1);
  }

  const source = `github:${repoOwner}/${repoName}`;
  const version =
    parsed.version ??
    (await fetchLatestRelease(repoOwner, repoName, {
      includePrerelease: options.includePrerelease ?? false,
    }));

  const tarballUrl = `${getGitHubApiBase()}/repos/${repoOwner}/${repoName}/tarball/v${version}`;
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
  const tarballUrl = `${getGitHubApiBase()}/repos/${namespace}/${name}/tarball/${sha}`;
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

/**
 * The `<name>` of `<namespace>/<name>` as the ref is written, for every ref
 * form: install's default folder (#333). `REGISTRY_INVALID_REF` otherwise.
 */
export function shardNameOf(shardRef: string): string {
  return parseRef(shardRef).name;
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
  // Normalize the version like `fetchLatestRelease` does: strip a single
  // leading `v` so `@v1.2.3`, `--release v1.2.3`, and `@1.2.3` all build
  // the same `tarball/v1.2.3` URL. Without the strip, the tarball URL
  // ends up `tarball/vv1.2.3` and HEAD-404s with a confusing
  // VERSION_NOT_FOUND.
  const normalizedVersion =
    version !== undefined && version.startsWith('v') ? version.slice(1) : version;
  return {
    direct,
    namespace: namespace!,
    name: name!,
    version: normalizedVersion ?? null,
    ref: ref ?? null,
  };
}

/**
 * The registry index. Every failure is `REGISTRY_NETWORK` with `directHint`,
 * the command that takes the shard straight from GitHub, and the reason in
 * the message.
 */
async function fetchRegistryIndex(directHint: string): Promise<RegistryIndex> {
  const fail = (reason: string): ShardMindError => new ShardMindError(reason, 'REGISTRY_NETWORK', directHint);
  const why = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  const response = await safeFetch(getRegistryIndexUrl(), undefined, directHint);
  if (!response.ok) throw fail(`Could not fetch the shard registry index: HTTP ${response.status}`);

  let body: string;
  try {
    body = await response.text();
  } catch (err) {
    throw fail(`Could not read the shard registry index: ${why(err)}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (err) {
    throw fail(`The shard registry index is corrupt: ${why(err)}`);
  }

  // A newer format first, and this check must stay before the shape check:
  // a newer format's other fields may not be this format's at all.
  const probe = IndexVersionProbe.safeParse(json);
  if (probe.success && probe.data.schema_version > REGISTRY_SCHEMA_VERSION) {
    throw new ShardMindError(
      `The shard registry index is version ${probe.data.schema_version}; this shardmind reads version ${REGISTRY_SCHEMA_VERSION}`,
      'REGISTRY_INDEX_UNSUPPORTED',
      `Update shardmind: npm install -g shardmind@latest. Or: ${directHint}`,
    );
  }

  const index = RegistryIndexSchema.safeParse(json);
  if (!index.success) throw fail(`The shard registry index is corrupt: ${describeZodIssues(index.error)}`);
  return index.data;
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
  const url = `${getGitHubApiBase()}/repos/${namespace}/${name}/releases?per_page=${RELEASES_PAGE_SIZE}`;
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
  const url = `${getGitHubApiBase()}/repos/${namespace}/${name}/commits/${encodeURIComponent(ref)}`;
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

/** `fetch`, with a network failure as `REGISTRY_NETWORK`; its hint is `hint`, or the failure's own message. */
async function safeFetch(url: string, init?: RequestInit, hint?: string): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    throw new ShardMindError(
      `Could not reach ${new URL(url).host}`,
      'REGISTRY_NETWORK',
      hint ?? (err instanceof Error ? err.message : String(err)),
    );
  }
}
