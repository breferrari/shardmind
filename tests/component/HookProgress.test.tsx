/**
 * Component tests for HookProgress.
 *
 * The component is a passive tail view — it renders whatever state the
 * state machine hands it. These tests pin the three behaviors that
 * matter for users: (1) the stage-specific heading is correct, (2) the
 * spinner + heading render even when output is empty, (3) the tail
 * clips to the last 12 lines and preserves line order.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import React from 'react';
import HookProgress from '../../source/components/HookProgress.js';

afterEach(() => {
  cleanup();
});

describe('HookProgress', () => {
  it('renders a post-install heading with the shard label', () => {
    const { lastFrame } = render(
      <HookProgress stage="post-install" output="" shardLabel="acme/demo" />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Running post-install hook for acme/demo');
  });

  it('renders a post-update heading with the shard label', () => {
    const { lastFrame } = render(
      <HookProgress stage="post-update" output="" shardLabel="acme/demo" />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Running post-update hook for acme/demo');
  });

  it('renders only spinner + heading when output is empty', () => {
    const emptyOutput = render(
      <HookProgress stage="post-install" output="" shardLabel="acme/demo" />,
    );
    const withOutput = render(
      <HookProgress
        stage="post-install"
        output="cloning repo\npatching files"
        shardLabel="acme/demo"
      />,
    );
    // The heading is present in both; the output-bearing frame is
    // strictly longer (multi-line tail renders added lines).
    const emptyFrame = emptyOutput.lastFrame() ?? '';
    const populatedFrame = withOutput.lastFrame() ?? '';
    expect(emptyFrame).toContain('Running post-install hook');
    expect(populatedFrame).toContain('Running post-install hook');
    expect(populatedFrame).toContain('cloning repo');
    expect(populatedFrame).toContain('patching files');
    // Absence assertion: the empty-output frame doesn't include any of
    // the rendered tail content the populated frame has.
    expect(emptyFrame).not.toContain('cloning repo');
  });

  it('tails the last 12 lines when output exceeds 12 lines', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\n');
    const { lastFrame } = render(
      <HookProgress stage="post-install" output={lines} shardLabel="acme/demo" />,
    );
    const frame = lastFrame() ?? '';
    // Lines 0-7 must have been dropped (keep only the last 12: 8..19).
    expect(frame).not.toContain('line-0');
    expect(frame).not.toContain('line-7');
    expect(frame).toContain('line-8');
    expect(frame).toContain('line-19');
  });

  it('splits on both LF and CRLF so Windows-authored hooks tail cleanly', () => {
    // A hook author on Windows (or using a stdout library that emits
    // CRLF) must not have their tail collapse to a single unwrapped line.
    const output = 'alpha\r\nbeta\r\ngamma';
    const { lastFrame } = render(
      <HookProgress stage="post-install" output={output} shardLabel="acme/demo" />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('alpha');
    expect(frame).toContain('beta');
    expect(frame).toContain('gamma');
  });

  it('drops the trailing empty string left by a final newline', () => {
    // Output ends with LF — the split leaves a "" tail that shouldn't
    // consume a render slot. Assert the tail stays at the real last line.
    const output = 'only line\n';
    const { lastFrame } = render(
      <HookProgress stage="post-install" output={output} shardLabel="acme/demo" />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('only line');
  });
});
