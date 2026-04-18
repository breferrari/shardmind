import type { ResolvedShard } from '../runtime/types.js';
import { ShardMindError } from '../runtime/types.js';

const REGISTRY_INDEX_URL =
  'https://raw.githubusercontent.com/shardmind/registry/main/index.json';

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

export async function resolve(shardRef: string): Promise<ResolvedShard> {
  const parsed = parseRef(shardRef);

  let version: string;
  let source: string;
  let repoOwner: string;
  let repoName: string;

  if (parsed.direct) {
    repoOwner = parsed.namespace;
    repoName = parsed.name;
    source = `github:${repoOwner}/${repoName}`;
    version = parsed.version ?? (await fetchLatestRelease(repoOwner, repoName));
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

  const tarballUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/tarball/v${version}`;
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

async function fetchLatestRelease(namespace: string, name: string): Promise<string> {
  const url = `https://api.github.com/repos/${namespace}/${name}/releases/latest`;
  const response = await safeFetch(url, githubHeaders());

  if (response.status === 403 && isRateLimited(response)) {
    throw rateLimitError();
  }

  if (response.status === 404) {
    throw new ShardMindError(
      `No releases found for ${namespace}/${name}`,
      'VERSION_NOT_FOUND',
      'Specify a version explicitly with @version, or publish a GitHub release.',
    );
  }

  if (!response.ok) {
    throw new ShardMindError(
      `Could not fetch latest release for ${namespace}/${name}: HTTP ${response.status}`,
      'REGISTRY_NETWORK',
      'GitHub API returned an unexpected status.',
    );
  }

  let data: { tag_name?: string };
  try {
    data = (await response.json()) as { tag_name?: string };
  } catch (err) {
    throw new ShardMindError(
      'Malformed response from GitHub releases API',
      'REGISTRY_NETWORK',
      err instanceof Error ? err.message : String(err),
    );
  }

  const tag = data.tag_name;
  if (typeof tag !== 'string' || tag.length === 0) {
    throw new ShardMindError(
      `Latest release for ${namespace}/${name} has no tag name`,
      'REGISTRY_NETWORK',
      'GitHub returned a release without tag_name.',
    );
  }

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
