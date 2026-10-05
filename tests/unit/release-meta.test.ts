/**
 * The release pipeline's version metadata (#108): the tag must be
 * `v<package.json version>`, and the npm dist-tag follows the version, so a
 * prerelease never lands on `latest` (npm 10 put it there; npm 11 refuses
 * a prerelease without `--tag`).
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { releaseMeta } from '../../scripts/release/release-meta.mjs';

describe('releaseMeta', () => {
  it.each([
    ['v0.1.7', '0.1.7', false, 'latest'],
    ['v1.0.0', '1.0.0', false, 'latest'],
    ['v0.2.0-beta.1', '0.2.0-beta.1', true, 'beta'],
    ['v0.2.0-beta', '0.2.0-beta', true, 'beta'],
    ['v1.0.0-rc.2', '1.0.0-rc.2', true, 'rc'],
    ['v0.1.0-alpha.1', '0.1.0-alpha.1', true, 'alpha'],
    ['v1.0.0-0', '1.0.0-0', true, 'next'],
    ['v1.0.0-0.3.7', '1.0.0-0.3.7', true, 'next'],
    ['v1.0.0-x-y.1', '1.0.0-x-y.1', true, 'next'],
    ['v1.0.0+build.5', '1.0.0+build.5', false, 'latest'],
    ['v1.0.0-beta.1+build.5', '1.0.0-beta.1+build.5', true, 'beta'],
  ])('%s with package.json %s → prerelease %s, dist-tag %s', (tag, version, prerelease, distTag) => {
    expect(releaseMeta(tag, version)).toEqual({ version, prerelease, distTag });
  });

  it.each([
    ['v0.1.8', '0.1.7', /does not match/],
    ['0.1.7', '0.1.7', /must be v<version>/],
    ['v0.1', '0.1', /not a semver version/],
    ['vnope', 'nope', /not a semver version/],
    ['', '0.1.7', /must be v<version>/],
  ])('refuses tag %s with package.json %s', (tag, version, message) => {
    expect(() => releaseMeta(tag, version)).toThrow(message);
  });

  it('never resolves a version with a prerelease part to latest', () => {
    const identifier = fc.oneof(
      fc.stringMatching(/^[0-9A-Za-z-]{1,8}$/).filter((id) => !/^0\d/.test(id)),
      fc.nat({ max: 999 }).map(String),
    );
    fc.assert(
      fc.property(
        fc.tuple(fc.nat({ max: 50 }), fc.nat({ max: 50 }), fc.nat({ max: 50 })),
        fc.array(identifier, { minLength: 1, maxLength: 4 }),
        ([major, minor, patch], ids) => {
          const version = `${major}.${minor}.${patch}-${ids.join('.')}`;
          const meta = releaseMeta(`v${version}`, version);
          expect(meta.prerelease).toBe(true);
          expect(meta.distTag).not.toBe('latest');
          expect(meta.distTag).toMatch(/^[a-z][a-z-]*$/);
        },
      ),
    );
  });
});
