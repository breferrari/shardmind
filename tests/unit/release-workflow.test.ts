/**
 * release.yml's shape (#108): check → github-release → publish-npm in
 * strict order, the published tarball is the one `check` packed, and the
 * publish always names a dist-tag. A run against a real tag would release,
 * so the order is pinned here instead.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Job {
  needs?: string | string[];
  outputs?: Record<string, string>;
  steps: Step[];
}

const workflow = parse(fs.readFileSync(path.join(REPO, '.github/workflows/release.yml'), 'utf-8')) as {
  on: { push: { tags: string[] } };
  jobs: Record<string, Job>;
};
const needs = (job: Job): string[] => (job.needs === undefined ? [] : [job.needs].flat());
const runs = (job: Job): string => job.steps.map((s) => s.run ?? '').join('\n');

describe('release.yml (#108)', () => {
  const { check, 'github-release': githubRelease, 'publish-npm': publishNpm } = workflow.jobs;

  it('runs on version tags, as three jobs', () => {
    expect(workflow.on.push.tags).toEqual(['v*']);
    expect(Object.keys(workflow.jobs).sort()).toEqual(['check', 'github-release', 'publish-npm']);
  });

  it('orders the jobs check → github-release → publish-npm', () => {
    expect(needs(check!)).toEqual([]);
    expect(needs(githubRelease!)).toEqual(['check']);
    expect(needs(publishNpm!)).toContain('github-release');
  });

  it('checks the tag against package.json before the tests, and packs what it tested', () => {
    const script = runs(check!);
    expect(script.indexOf('release-meta.mjs')).toBeGreaterThan(-1);
    expect(script.indexOf('release-meta.mjs')).toBeLessThan(script.indexOf('npm test'));
    expect(script).toMatch(/npm pack/);
    expect(check!.steps.some((s) => s.uses?.startsWith('actions/upload-artifact@'))).toBe(true);
  });

  it("bases a stable release's notes on the previous stable tag, a prerelease's on any tag", () => {
    const script = runs(githubRelease!);
    expect(script).toMatch(/git describe --tags --abbrev=0 .*\$\{GITHUB_REF_NAME\}\^/);
    // Prerelease tags are skipped for a stable release, by the check job's verdict.
    expect(script).toMatch(/--exclude=v\*-\*/);
    expect(JSON.stringify(githubRelease!.steps)).toContain('needs.check.outputs.prerelease');
  });

  it('marks a prerelease as such and never makes it latest', () => {
    const release = githubRelease!.steps.find((s) => s.uses?.startsWith('softprops/action-gh-release@'));
    expect(String(release?.with?.['prerelease'])).toMatch(/needs\.check\.outputs\.prerelease/);
    expect(String(release?.with?.['make_latest'])).toMatch(/needs\.check\.outputs\.prerelease == 'true' && 'false'/);
  });

  it('publishes the packed tarball, not a rebuild, under the computed dist-tag', () => {
    const download = publishNpm!.steps.find((s) => s.uses?.startsWith('actions/download-artifact@'));
    const upload = check!.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'));
    expect(download?.with?.['name']).toBe(upload?.with?.['name']);
    const script = runs(publishNpm!);
    expect(script).not.toMatch(/npm (ci|run build|install|pack)/);
    const publish = publishNpm!.steps.find((s) => s.run?.includes('npm publish'));
    expect(publish?.run).toMatch(/--provenance/);
    expect(publish?.run).toMatch(/--tag "\$DIST_TAG"/);
    expect(JSON.stringify(publish)).toContain('needs.check.outputs.dist_tag');
    expect(JSON.stringify(publish)).toContain('needs.check.outputs.tarball');
  });
});
