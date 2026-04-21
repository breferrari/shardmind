/**
 * Component tests for HookSummarySection.
 *
 * HookSummarySection is the four-branch renderer shared by both
 * Summary.tsx (install) and UpdateSummary.tsx (update). Tests here
 * pin the absent / deferred / ran-success / ran-failure rendering
 * for BOTH stages, since that's the spot most at risk of drift
 * between the two call sites.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import React from 'react';
import HookSummarySection from '../../source/components/HookSummarySection.js';

afterEach(() => {
  cleanup();
});

describe('HookSummarySection', () => {
  it('renders nothing when hookOutput is null', () => {
    const { lastFrame } = render(
      <HookSummarySection stage="post-install" hookOutput={null} />,
    );
    // `null` render path — no text whatsoever.
    expect(lastFrame() ?? '').toBe('');
  });

  it('post-install: renders "skipped" note when deferred', () => {
    const { lastFrame } = render(
      <HookSummarySection stage="post-install" hookOutput={{ deferred: true }} />,
    );
    expect(lastFrame() ?? '').toContain('Post-install hook skipped (dry run).');
  });

  it('post-update: renders "skipped" note when deferred', () => {
    const { lastFrame } = render(
      <HookSummarySection stage="post-update" hookOutput={{ deferred: true }} />,
    );
    expect(lastFrame() ?? '').toContain('Post-update hook skipped (dry run).');
  });

  it('post-install: renders "completed" + stdout/stderr on clean exit', () => {
    const { lastFrame } = render(
      <HookSummarySection
        stage="post-install"
        hookOutput={{ stdout: 'clone ok', stderr: 'warning', exitCode: 0 }}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Post-install hook completed.');
    expect(frame).toContain('Hook stdout:');
    expect(frame).toContain('clone ok');
    expect(frame).toContain('Hook stderr:');
    expect(frame).toContain('warning');
  });

  it('post-update: renders "completed" + stdout/stderr on clean exit', () => {
    const { lastFrame } = render(
      <HookSummarySection
        stage="post-update"
        hookOutput={{ stdout: 'rebuilt index', stderr: '', exitCode: 0 }}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Post-update hook completed.');
    expect(frame).toContain('Hook stdout:');
    expect(frame).toContain('rebuilt index');
    // Empty stderr should NOT surface the stderr label block.
    expect(frame).not.toContain('Hook stderr:');
  });

  it('post-install: yellow warning on non-zero exit, explicit about install success', () => {
    const { lastFrame } = render(
      <HookSummarySection
        stage="post-install"
        hookOutput={{ stdout: 'partial', stderr: 'hook boom', exitCode: 2 }}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Post-install hook exited with code 2');
    // The "parent succeeded" copy is the user-facing Helm-semantics
    // signal — keep an assertion so a reword can't silently lose it.
    expect(frame).toContain("Install succeeded; the hook's work may be incomplete.");
    expect(frame).toContain('partial');
    expect(frame).toContain('hook boom');
  });

  it('post-update: yellow warning on non-zero exit, explicit about update success', () => {
    const { lastFrame } = render(
      <HookSummarySection
        stage="post-update"
        hookOutput={{ stdout: '', stderr: 'hook timed out after 30.0s', exitCode: 1 }}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Post-update hook exited with code 1');
    expect(frame).toContain("Update succeeded; the hook's work may be incomplete.");
    expect(frame).toContain('timed out after 30.0s');
  });

  it('omits stdout block when stdout is empty/whitespace-only', () => {
    const { lastFrame } = render(
      <HookSummarySection
        stage="post-install"
        hookOutput={{ stdout: '  \n  ', stderr: 'real output', exitCode: 0 }}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('Hook stdout:');
    expect(frame).toContain('Hook stderr:');
    expect(frame).toContain('real output');
  });

  it('defaults to exit-code 0 when exitCode is undefined', () => {
    // A `HookSummary` can legally omit `exitCode` (e.g., direct construction
    // in tests). The component's `exitCode ?? 0` fallback means an omitted
    // value renders as "completed", not as a warning — pin that behavior.
    const { lastFrame } = render(
      <HookSummarySection
        stage="post-install"
        hookOutput={{ stdout: 'ok', stderr: '' }}
      />,
    );
    expect(lastFrame() ?? '').toContain('Post-install hook completed.');
  });
});
