#!/usr/bin/env node
/**
 * Version metadata for release.yml (#108).
 *
 *   node scripts/release/release-meta.mjs <tag>
 *
 * Checks that <tag> is `v<package.json version>` and prints the version,
 * whether it is a prerelease, and its npm dist-tag. Under GitHub Actions it
 * also writes them to $GITHUB_OUTPUT as `version`, `prerelease` and
 * `dist_tag`. Exits 1, naming the problem, when the tag and the version
 * disagree.
 */

import fs from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

/**
 * The release metadata for `tag` against package.json's `version`.
 *
 * The dist-tag is `latest` for a stable version. For a prerelease it is the
 * first prerelease identifier when that is alphabetic (`beta.1` → `beta`,
 * `rc.2` → `rc`, `alpha` → `alpha`, as `0.1.0-alpha.1` was published), and
 * `next` otherwise (`1.0.0-0`). A prerelease never gets `latest`: npm 10
 * would have put it there, and npm 11 refuses a prerelease without `--tag`.
 *
 * @param {string} tag The pushed tag, e.g. `v0.2.0-beta.1`.
 * @param {string} version package.json's `version`.
 * @returns {{ version: string, prerelease: boolean, distTag: string }}
 */
export function releaseMeta(tag, version) {
  if (!tag.startsWith('v')) {
    throw new Error(`The tag "${tag}" must be v<version>, as \`npm version\` writes it.`);
  }

  if (tag.slice(1) !== version) {
    throw new Error(`The tag "${tag}" does not match package.json's version "${version}".`);
  }

  const parsed = semver.parse(version);
  if (!parsed) {
    throw new Error(`"${version}" is not a semver version.`);
  }

  if (parsed.prerelease.length === 0) {
    return { version, prerelease: false, distTag: 'latest' };
  }

  const [first] = parsed.prerelease;
  const distTag = typeof first === 'string' && /^[a-z]+$/i.test(first) ? first.toLowerCase() : 'next';
  return { version, prerelease: true, distTag };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  try {
    const tag = process.argv[2] ?? '';
    const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const meta = releaseMeta(tag, version);
    console.log(`version=${meta.version} prerelease=${meta.prerelease} dist_tag=${meta.distTag}`);
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `version=${meta.version}\nprerelease=${meta.prerelease}\ndist_tag=${meta.distTag}\n`,
      );
    }
  } catch (error) {
    console.error(`release-meta: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
