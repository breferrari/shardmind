/**
 * External tool requirements (#138): each declared tool is read through a
 * probe the test passes in, so nothing here spawns a process.
 */

import { describe, it, expect } from 'vitest';
import {
  checkExternalTools,
  checkExternalToolsForRun,
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

  it.each([
    ['a year before the version', 'qmd (c) 2024 Acme, version 2.5.3', '2.5.3'],
    ['a major-only word before the version', 'Built on Node.js 22 - qmd v2.0.1', '2.0.1'],
    ['a date before the version', 'released 2024-01-02, qmd 2.5.3', '2.5.3'],
  ])('reads the first full version, not %s', async (_name, stdout, version) => {
    const probe = probeOf({ qmd: { kind: 'output', stdout } });
    const [result] = await checkExternalTools(manifestWith({ qmd: { ...qmd, version: '>=1.0.0' } }), {}, probe);
    expect(result).toMatchObject({ status: 'met', version });
  });

  it('falls back to a short version when no full one is printed', async () => {
    const probe = probeOf({ qmd: { kind: 'output', stdout: 'qmd 3' } });
    expect((await checkExternalTools(manifestWith({ qmd }), {}, probe))[0]).toMatchObject({ status: 'met', version: '3.0.0' });
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
  it('never runs a probe on a dry run, and says so', async () => {
    const probe = probeOf({});
    expect(await checkExternalToolsForRun({ manifest: manifestWith({ qmd }), values: {}, dryRun: true, probe })).toEqual([
      'external tools not checked (dry run)',
    ]);
    expect(probe.calls).toEqual([]);
  });

  it('checks nothing and says nothing for a shard that declares no tools', async () => {
    const probe = probeOf({});
    const manifest = ShardManifestSchema.parse({ apiVersion: 'v1', name: 'demo', namespace: 'acme', version: '1.0.0' }) as ShardManifest;
    expect(await checkExternalToolsForRun({ manifest, values: {}, dryRun: false, probe })).toEqual([]);
    expect(await checkExternalToolsForRun({ manifest, values: {}, dryRun: true, probe })).toEqual([]);
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
    expect(error.message).toContain('rg: not found on PATH (optional)');
    expect(error.hint).toContain('npm i -g @tobilu/qmd@">=2.5.0"');
    expect(error.hint).toContain('npm i -g ripgrep@">=13"');
  });

  it('returns one summary line per unmet optional tool, and none for met or skipped ones', async () => {
    const probe = probeOf({ qmd: { kind: 'not-found' }, rg: { kind: 'output', stdout: 'ripgrep 14.0.0' } });
    const lines = await checkExternalToolsForRun({
      manifest: manifestWith({
        qmd: { ...qmd, optional: true },
        rg: { package: 'ripgrep', version: '>=13', command: 'rg' },
        fd: { package: 'fd-find', version: '>=8', command: 'fd', when: 'fd_enabled' },
      }),
      values: { fd_enabled: false },
      dryRun: false,
      probe,
    });
    expect(lines).toEqual(['qmd: not found on PATH. Install: npm i -g @tobilu/qmd@">=2.5.0"']);
  });

  it('runs the probes at once, keeping declaration order', async () => {
    let inFlight = 0;
    let most = 0;
    const slow: ToolProbe = async (command) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, command === 'a' ? 30 : 5));
      inFlight -= 1;
      return { kind: 'not-found' };
    };
    const tool = (command: string) => ({ package: command, version: '>=1', command, optional: true });
    const lines = await checkExternalToolsForRun({ manifest: manifestWith({ a: tool('a'), b: tool('b') }), values: {}, dryRun: false, probe: slow });
    expect(most).toBe(2);
    expect(lines.map((l) => l.split(':')[0])).toEqual(['a', 'b']);
  });
});
