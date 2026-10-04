/**
 * Where a vendored kit's upstream comes from (#280): npm for versions, the
 * upstream git repository for the vendored source at a commit. Everything
 * goes through `UpstreamSource`, so tests run on fixture upstreams on disk.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { x as extract } from 'tar';

export interface UpstreamSource {
  /** npm's `dist-tags.latest` for the package. */
  latestVersion(pkg: string): Promise<string>;
  /** npm's dist for one version: its tarball and integrity. */
  versionInfo(pkg: string, version: string): Promise<{ url: string; integrity: string }>;
  /** The commit a tag points at (an annotated tag is followed to its commit). */
  commitForTag(repository: string, tag: string): Promise<string>;
  /** A folder holding the repository at `commit`; `cleanup` removes it. */
  checkout(repository: string, commit: string): Promise<{ root: string; cleanup: () => Promise<void> }>;
}

/** `https://github.com/<owner>/<repo>` → `<owner>/<repo>`. */
function githubSlug(repository: string): string {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(repository);
  if (!m) throw new Error(`Not a GitHub repository URL: ${repository}`);
  return m[1]!;
}

async function getJson(url: string): Promise<unknown> {
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'shardmind-vendor' };
  if (url.startsWith('https://api.github.com/') && process.env['GITHUB_TOKEN']) {
    headers['authorization'] = `Bearer ${process.env['GITHUB_TOKEN']}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${res.statusText}`);
  return res.json();
}

/** The real upstream: the npm registry and GitHub. */
export const networkSource: UpstreamSource = {
  async latestVersion(pkg) {
    const meta = (await getJson(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}`)) as {
      'dist-tags'?: { latest?: string };
    };
    const latest = meta['dist-tags']?.latest;
    if (!latest) throw new Error(`${pkg}: npm reports no latest version`);
    return latest;
  },
  async versionInfo(pkg, version) {
    const meta = (await getJson(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}/${version}`)) as {
      dist?: { tarball?: string; integrity?: string };
    };
    if (!meta.dist?.tarball || !meta.dist.integrity) throw new Error(`${pkg}@${version}: no dist on npm`);
    return { url: meta.dist.tarball, integrity: meta.dist.integrity };
  },
  async commitForTag(repository, tag) {
    const slug = githubSlug(repository);
    let ref = (await getJson(`https://api.github.com/repos/${slug}/git/ref/tags/${encodeURIComponent(tag)}`)) as {
      object: { type: string; sha: string };
    };
    // An annotated tag points at a tag object; follow it to the commit.
    for (let i = 0; i < 5 && ref.object.type === 'tag'; i++) {
      ref = (await getJson(`https://api.github.com/repos/${slug}/git/tags/${ref.object.sha}`)) as typeof ref;
    }
    if (ref.object.type !== 'commit') throw new Error(`${repository} tag ${tag} does not point at a commit`);
    return ref.object.sha;
  },
  async checkout(repository, commit) {
    const slug = githubSlug(repository);
    const res = await fetch(`https://codeload.github.com/${slug}/tar.gz/${commit}`);
    if (!res.ok || !res.body) throw new Error(`${repository} at ${commit}: ${res.status} ${res.statusText}`);
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'shardmind-vendor-'));
    // The archive's single top folder is `<repo>-<commit>/`.
    await pipeline(Readable.fromWeb(res.body as never), extract({ cwd: root, strip: 1 }));
    return { root, cleanup: () => fsp.rm(root, { recursive: true, force: true }) };
  },
};
