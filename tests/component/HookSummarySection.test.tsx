/**
 * Component tests for HookSummarySection.
 *
 * HookSummarySection renders a list of per-slot hook outcomes, shared by
 * Summary.tsx (install), UpdateSummary.tsx (update), and AdoptSummary.tsx.
 * Tests pin each branch (null / skipped / deferred / ran-success /
 * ran-failure / violation / deprecated) and the multi-outcome rendering
 * (bootstrap + personalize in one run), since that's the spot most at risk
 * of drift across the three call sites.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import React from 'react';
import HookSummarySection from '../../source/components/HookSummarySection.js';
import type { HookOutcome } from '../../source/core/hook-orchestrator.js';

afterEach(() => {
  cleanup();
});

const out = (o: HookOutcome[]) => render(<HookSummarySection outcomes={o} />);

describe('HookSummarySection', () => {
  it('renders nothing when there are no outcomes', () => {
    expect(out([]).lastFrame() ?? '').toBe('');
  });

  it('renders nothing for a null summary', () => {
    expect(out([{ slot: 'bootstrap', summary: null }]).lastFrame() ?? '').toBe('');
  });

  it('renders a dim skipped note for personalize under Invariant 2', () => {
    const frame = out([{ slot: 'personalize', summary: { skipped: 'values-are-defaults' } }]).lastFrame() ?? '';
    expect(frame).toContain('Personalize hook skipped (values are defaults).');
  });

  it('renders a dry-run skipped note for a deferred hook', () => {
    const frame = out([{ slot: 'bootstrap', summary: { deferred: true } }]).lastFrame() ?? '';
    expect(frame).toContain('Bootstrap hook skipped (dry run).');
  });

  it('renders "completed" + stdout/stderr on clean exit', () => {
    const frame = out([{ slot: 'bootstrap', summary: { stdout: 'clone ok', stderr: 'warning', exitCode: 0 } }]).lastFrame() ?? '';
    expect(frame).toContain('Bootstrap hook completed.');
    expect(frame).toContain('Hook stdout:');
    expect(frame).toContain('clone ok');
    expect(frame).toContain('Hook stderr:');
    expect(frame).toContain('warning');
  });

  it('omits the stderr block when stderr is empty', () => {
    const frame = out([{ slot: 'post-update', summary: { stdout: 'rebuilt index', stderr: '', exitCode: 0 } }]).lastFrame() ?? '';
    expect(frame).toContain('Post-update hook completed.');
    expect(frame).not.toContain('Hook stderr:');
  });

  it('renders a yellow warning on non-zero exit, explicit the operation succeeded', () => {
    const frame = out([{ slot: 'personalize', summary: { stdout: 'partial', stderr: 'hook boom', exitCode: 2 } }]).lastFrame() ?? '';
    expect(frame).toContain('Personalize hook exited with code 2');
    expect(frame).toContain("The operation succeeded; the hook's work may be incomplete.");
    expect(frame).toContain('partial');
    expect(frame).toContain('hook boom');
  });

  it('truncates a long crashed-hook stderr and points at the full log (#105)', () => {
    const stderr = Array.from({ length: 9 }, (_, i) => `trace line ${i}`).join('\n');
    const frame = out([
      {
        slot: 'bootstrap',
        summary: { stdout: '', stderr, exitCode: 1, logPath: '.shardmind/logs/bootstrap.log' },
      },
    ]).lastFrame() ?? '';
    // Crash header: clearly non-fatal + vault safe, still names the exit code.
    expect(frame).toContain('Bootstrap hook exited with code 1');
    expect(frame).toContain('Non-fatal; your vault is ready');
    // First HOOK_OUTPUT_VISIBLE_LINES lines shown; the tail is hidden.
    expect(frame).toContain('trace line 0');
    expect(frame).toContain('trace line 4');
    expect(frame).not.toContain('trace line 8');
    // Pointer to the full on-disk log.
    expect(frame).toContain('… 4 more lines');
    expect(frame).toContain('full log at .shardmind/logs/bootstrap.log');
  });

  it('truncates long output on a clean exit too, with the log pointer (#105)', () => {
    const stdout = Array.from({ length: 7 }, (_, i) => `out ${i}`).join('\n');
    const frame = out([
      {
        slot: 'post-update',
        summary: { stdout, stderr: '', exitCode: 0, logPath: '.shardmind/logs/post-update.log' },
      },
    ]).lastFrame() ?? '';
    expect(frame).toContain('Post-update hook completed.');
    expect(frame).toContain('out 0');
    expect(frame).not.toContain('out 6');
    expect(frame).toContain('… 2 more lines');
    expect(frame).toContain('full log at .shardmind/logs/post-update.log');
  });

  it('omits the "more lines" pointer for output within the visible cap (#105)', () => {
    const frame = out([
      { slot: 'bootstrap', summary: { stdout: 'a\nb\nc', stderr: '', exitCode: 0 } },
    ]).lastFrame() ?? '';
    expect(frame).toContain('a');
    expect(frame).not.toContain('more line');
  });

  it('shows the truncation count without a path when no log was written (#105)', () => {
    const stderr = Array.from({ length: 8 }, (_, i) => `e${i}`).join('\n');
    const frame = out([{ slot: 'bootstrap', summary: { stdout: '', stderr, exitCode: 1 } }]).lastFrame() ?? '';
    expect(frame).toContain('… 3 more lines');
    expect(frame).not.toContain('full log at');
  });

  it('shows the log pointer only when output actually truncates, not just because logPath is set (#105)', () => {
    // A crashed hook with SHORT output: a log may exist, but the on-screen
    // block fits — so no "more lines"/pointer noise.
    const frame = out([
      {
        slot: 'bootstrap',
        summary: { stdout: 'ok', stderr: 'boom', exitCode: 1, logPath: '.shardmind/logs/bootstrap.log' },
      },
    ]).lastFrame() ?? '';
    expect(frame).toContain('boom');
    expect(frame).not.toContain('more line');
    expect(frame).not.toContain('full log at');
  });

  it('renders only the crash header when a crashed hook produced no output (#105)', () => {
    const frame = out([
      { slot: 'bootstrap', summary: { stdout: '', stderr: '', exitCode: 1, logPath: '.shardmind/logs/bootstrap.log' } },
    ]).lastFrame() ?? '';
    expect(frame).toContain('Bootstrap hook exited with code 1');
    expect(frame).not.toContain('Hook stdout:');
    expect(frame).not.toContain('Hook stderr:');
    expect(frame).not.toContain('full log at');
  });

  it('renders a bootstrap managed-write boundary violation', () => {
    const frame = out([
      { slot: 'bootstrap', summary: { exitCode: 0, violation: { kind: 'managed-write', paths: ['Home.md', 'brain/North Star.md'] } } },
    ]).lastFrame() ?? '';
    expect(frame).toContain('Bootstrap hook modified or removed managed file(s): Home.md, brain/North Star.md');
    expect(frame).toContain('move managed-file edits to the personalize hook');
  });

  it('renders a personalize unmanaged-create boundary violation', () => {
    const frame = out([
      { slot: 'personalize', summary: { exitCode: 0, violation: { kind: 'unmanaged-create', paths: ['.cache/x.json'] } } },
    ]).lastFrame() ?? '';
    expect(frame).toContain('Personalize hook created unmanaged file(s): .cache/x.json');
    expect(frame).toContain('move artifact creation to the bootstrap hook');
  });

  it('renders a deprecation warning for a legacy post-install run', () => {
    const frame = out([{ slot: 'post-install', summary: { exitCode: 0, deprecated: true } }]).lastFrame() ?? '';
    expect(frame).toContain('Post-install hook completed.');
    expect(frame).toContain('The post-install hook is deprecated');
  });

  it('renders multiple outcomes in order (bootstrap then personalize)', () => {
    const frame = out([
      { slot: 'bootstrap', summary: { stdout: 'git init', stderr: '', exitCode: 0 } },
      { slot: 'personalize', summary: { stdout: 'wrote North Star', stderr: '', exitCode: 0 } },
    ]).lastFrame() ?? '';
    expect(frame).toContain('Bootstrap hook completed.');
    expect(frame).toContain('Personalize hook completed.');
    expect(frame.indexOf('Bootstrap hook')).toBeLessThan(frame.indexOf('Personalize hook'));
  });

  it('defaults to exit-code 0 (completed) when exitCode is undefined', () => {
    const frame = out([{ slot: 'bootstrap', summary: { stdout: 'ok', stderr: '' } }]).lastFrame() ?? '';
    expect(frame).toContain('Bootstrap hook completed.');
  });
});
