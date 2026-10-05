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

  it('marks a prerelease as such and never makes it latest', () => {
    const release = githubRelease!.steps.find((s) => s.uses?.startsWith('softprops/action-gh-release@'));
    expect(release?.with?.['prerelease']).toBe('${{ needs.check.outputs.prerelease }}');
    expect(String(release?.with?.['make_latest'])).toBe("${{ needs.check.outputs.prerelease == 'true' && 'false' || 'true' }}");
  });

  it('publishes the packed tarball, not a rebuild, under the computed dist-tag', () => {
    expect(publishNpm!.steps.some((s) => s.uses?.startsWith('actions/download-artifact@'))).toBe(true);
    const script = runs(publishNpm!);
    expect(script).not.toMatch(/npm (ci|run build|install)/);
    expect(script).toContain(
      'npm publish "shardmind-${{ needs.check.outputs.version }}.tgz" --provenance --access public --tag "${{ needs.check.outputs.dist_tag }}"',
    );
  });
});
