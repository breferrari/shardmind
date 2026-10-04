/**
 * External tool requirements (#138): each declared tool is read through a
 * probe the test passes in, so nothing here spawns a process.
 */

import { describe, it, expect } from 'vitest';
import {
  checkExternalTools,
  checkExternalToolsForRun,
  summarizeExternalTools,
  type ProbeOutcome,
  type ToolProbe,
} from '../../source/core/external-tools.js';
import { ShardManifestSchema } from '../../source/core/manifest.js';
import { ShardMindError } from '../../source/runtime/types.js';
import type { ShardManifest } from '../../source/runtime/types.js';

function manifestWith(tools: Record<string, unknown>): ShardManifest {
  return ShardManifestSchema.parse({ apiVersion: 'v1', name: 'demo', namespace: 'acme', version: '1.0.0', external_tools: tools }) as ShardManifest;
}

const qmd = { package: '@tobilu/qmd', version: '>=2.5.0', command: 'qmd' };

/** A probe that answers per command and records every call. */
function probeOf(answers: Record<string, ProbeOutcome>): ToolProbe & { calls: Array<[string, readonly string[]]> } {
  const calls: Array<[string, readonly string[]]> = [];
  const probe = async (command: string, args: readonly string[]): Promise<ProbeOutcome> => {
    calls.push([command, args]);
    return answers[command] ?? { kind: 'not-found' };
  };
  return Object.assign(probe, { calls });
}

describe('checkExternalTools', () => {
  it('is met when the version printed satisfies the range, read from surrounding text', async () => {
    const probe = probeOf({ qmd: { kind: 'output', stdout: 'qmd 2.5.3 (build abc123)\n' } });
    expect(await checkExternalTools(manifestWith({ qmd }), {}, probe)).toEqual([{ name: 'qmd', status: 'met', version: '2.5.3' }]);
    expect(probe.calls).toEqual([['qmd', ['--version']]]);
  });

  it('runs the declared args', async () => {
    const probe = probeOf({ qmd: { kind: 'output', stdout: '2.5.3' } });
    await checkExternalTools(manifestWith({ qmd: { ...qmd, args: ['version', '--short'] } }), {}, probe);
    expect(probe.calls).toEqual([['qmd', ['version', '--short']]]);
  });

  it('counts a prerelease above the floor as met', async () => {
    const probe = probeOf({ qmd: { kind: 'output', stdout: 'v2.6.0-beta.1' } });
    expect((await checkExternalTools(manifestWith({ qmd }), {}, probe))[0]).toMatchObject({ status: 'met', version: '2.6.0-beta.1' });
  });

  it('is unmet when the version is below the range, with an install hint inside the range', async () => {
    const probe = probeOf({ qmd: { kind: 'output', stdout: 'qmd 2.0.1' } });
    expect(await checkExternalTools(manifestWith({ qmd }), {}, probe)).toEqual([
      { name: 'qmd', status: 'unmet', reason: 'found 2.0.1, needs >=2.5.0', hint: 'npm i -g @tobilu/qmd@">=2.5.0"', optional: false },
    ]);
  });

  it('keeps an upper bound in the hint', async () => {
    const probe = probeOf({ qmd: { kind: 'output', stdout: '3.1.0' } });
    const [result] = await checkExternalTools(manifestWith({ qmd: { ...qmd, version: '>=2.5.0 <3.0.0' } }), {}, probe);
    expect(result).toMatchObject({ status: 'unmet', hint: 'npm i -g @tobilu/qmd@">=2.5.0 <3.0.0"' });
  });

  it.each([
    ['not found on PATH', { kind: 'not-found' } as ProbeOutcome, 'not found on PATH'],
    ['a timeout', { kind: 'failed', reason: 'timed out after 5s' } as ProbeOutcome, 'timed out after 5s'],
    ['a non-zero exit', { kind: 'failed', reason: 'exited 3' } as ProbeOutcome, 'exited 3'],
    ['output with no version', { kind: 'output', stdout: 'usage: qmd [options]' } as ProbeOutcome, 'printed no version'],
    ['empty output', { kind: 'output', stdout: '' } as ProbeOutcome, 'printed no version'],
  ])('is unmet, never met, on %s', async (_name, outcome, reason) => {
    const [result] = await checkExternalTools(manifestWith({ qmd }), {}, probeOf({ qmd: outcome }));
    expect(result).toMatchObject({ name: 'qmd', status: 'unmet', reason });
  });

  it('skips a tool whose when value is false, without running it', async () => {
    const probe = probeOf({});
    const results = await checkExternalTools(manifestWith({ qmd: { ...qmd, when: 'qmd_enabled' } }), { qmd_enabled: false }, probe);
    expect(results).toEqual([{ name: 'qmd', status: 'skipped' }]);
    expect(probe.calls).toEqual([]);
  });

  it.each([
    ['true', { qmd_enabled: true }],
    ['missing', {}],
    ['not a boolean', { qmd_enabled: 'no' }],
  ])('checks a tool whose when value is %s', async (_name, values) => {
    const probe = probeOf({ qmd: { kind: 'output', stdout: '2.5.3' } });
    const [result] = await checkExternalTools(manifestWith({ qmd: { ...qmd, when: 'qmd_enabled' } }), values, probe);
    expect(result).toMatchObject({ status: 'met' });
  });

  it('checks every tool in declaration order', async () => {
    const probe = probeOf({ qmd: { kind: 'output', stdout: '2.5.3' }, rg: { kind: 'not-found' } });
    const rg = { package: 'ripgrep', version: '>=13', command: 'rg', optional: true };
    const results = await checkExternalTools(manifestWith({ qmd, rg }), {}, probe);
    expect(results.map((r) => [r.name, r.status])).toEqual([['qmd', 'met'], ['rg', 'unmet']]);
  });
});

describe('checkExternalToolsForRun', () => {
  it('never runs a probe on a dry run', async () => {
    const probe = probeOf({});
    expect(await checkExternalToolsForRun({ manifest: manifestWith({ qmd }), values: {}, dryRun: true, probe })).toEqual({ declared: true, checked: false, results: [] });
    expect(probe.calls).toEqual([]);
  });

  it('checks nothing for a shard that declares no tools', async () => {
    const probe = probeOf({});
    const manifest = ShardManifestSchema.parse({ apiVersion: 'v1', name: 'demo', namespace: 'acme', version: '1.0.0' }) as ShardManifest;
    expect(await checkExternalToolsForRun({ manifest, values: {}, dryRun: false, probe })).toEqual({ declared: false, checked: false, results: [] });
    expect(probe.calls).toEqual([]);
  });

  it('refuses with EXTERNAL_TOOL_UNMET naming every unmet tool, optional ones too', async () => {
    const probe = probeOf({ qmd: { kind: 'output', stdout: '2.0.1' }, rg: { kind: 'not-found' } });
    const rg = { package: 'ripgrep', version: '>=13', command: 'rg', optional: true };
    const run = checkExternalToolsForRun({ manifest: manifestWith({ qmd, rg }), values: {}, dryRun: false, probe });
    await expect(run).rejects.toBeInstanceOf(ShardMindError);
    const error = (await run.catch((e: unknown) => e)) as ShardMindError;
    expect(error.code).toBe('EXTERNAL_TOOL_UNMET');
    expect(error.message).toContain('qmd: found 2.0.1, needs >=2.5.0');
    expect(error.message).toContain('rg: not found on PATH');
    expect(error.hint).toContain('npm i -g @tobilu/qmd@">=2.5.0"');
    expect(error.hint).toContain('npm i -g ripgrep@">=13"');
  });

  it('returns the report when only optional tools are unmet', async () => {
    const probe = probeOf({ qmd: { kind: 'not-found' } });
    const report = await checkExternalToolsForRun({ manifest: manifestWith({ qmd: { ...qmd, optional: true } }), values: {}, dryRun: false, probe });
    expect(report).toMatchObject({ declared: true, checked: true, results: [{ name: 'qmd', status: 'unmet', optional: true }] });
  });
});

describe('summarizeExternalTools', () => {
  it('says a dry run did not check declared tools', () => {
    expect(summarizeExternalTools({ declared: true, checked: false, results: [] })).toEqual(['external tools not checked (dry run)']);
  });

  it('says nothing for a shard without tools', () => {
    expect(summarizeExternalTools({ declared: false, checked: false, results: [] })).toEqual([]);
  });

  it('lists each unmet optional tool with its hint, and nothing for met or skipped ones', () => {
    expect(
      summarizeExternalTools({
        declared: true,
        checked: true,
        results: [
          { name: 'qmd', status: 'unmet', reason: 'not found on PATH', hint: 'npm i -g @tobilu/qmd@">=2.5.0"', optional: true },
          { name: 'rg', status: 'met', version: '14.0.0' },
          { name: 'fd', status: 'skipped' },
        ],
      }),
    ).toEqual(['qmd: not found on PATH. Install: npm i -g @tobilu/qmd@">=2.5.0"']);
  });
});
