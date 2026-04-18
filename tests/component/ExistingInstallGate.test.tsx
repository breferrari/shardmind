import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import React from 'react';
import ExistingInstallGate from '../../source/components/ExistingInstallGate.js';
import type { ShardState } from '../../source/runtime/types.js';
import { ENTER, ARROW_DOWN, tick, typeText, waitFor } from './helpers.js';

afterEach(() => {
  cleanup();
});

const state: ShardState = {
  schema_version: 1,
  shard: 'breferrari/test-minimal-shard',
  source: 'github:breferrari/test-minimal-shard',
  version: '0.1.0',
  tarball_sha256: 'abc123',
  installed_at: '2026-04-01T12:00:00Z',
  updated_at: '2026-04-01T12:00:00Z',
  values_hash: 'def456',
  modules: { core: 'included', qmd: 'included' },
  files: {},
};

async function mount(node: React.ReactElement) {
  const r = render(node);
  await tick(30);
  return r;
}

describe('ExistingInstallGate', () => {
  it('renders shard identity and gate choices', async () => {
    const { lastFrame } = await mount(
      <ExistingInstallGate state={state} onChoice={() => {}} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('already has a shard installed');
    expect(frame).toContain('breferrari/test-minimal-shard');
    expect(frame).toContain('0.1.0');
    expect(frame).toContain('Keep the existing install');
    expect(frame).toContain('Reinstall from scratch');
    expect(frame).toContain('Cancel');
  });

  it('choosing update fires onChoice("update") immediately', async () => {
    const onChoice = vi.fn();
    const { stdin } = await mount(
      <ExistingInstallGate state={state} onChoice={onChoice} />,
    );

    // First option (update) is the default highlight; Enter commits.
    stdin.write(ENTER);
    await waitFor(() => (onChoice.mock.calls.length > 0 ? 'ok' : ''), (f) => f === 'ok');

    expect(onChoice).toHaveBeenCalledWith('update');
  });

  it('empty submit on REINSTALL confirm shows validation error', async () => {
    const onChoice = vi.fn();
    const { stdin, lastFrame } = await mount(
      <ExistingInstallGate state={state} onChoice={onChoice} />,
    );

    stdin.write(ARROW_DOWN);
    await tick(30);
    stdin.write(ENTER);
    await waitFor(lastFrame, (f) => f.includes('Type REINSTALL to proceed'));

    await tick(50);
    stdin.write(ENTER);
    await waitFor(lastFrame, (f) => f.includes('Exact text required'));
    expect(onChoice).not.toHaveBeenCalled();
  });

  it('wrong text on REINSTALL confirm rejects submission', async () => {
    const onChoice = vi.fn();
    const { stdin, lastFrame } = await mount(
      <ExistingInstallGate state={state} onChoice={onChoice} />,
    );

    stdin.write(ARROW_DOWN);
    await tick(30);
    stdin.write(ENTER);
    await waitFor(lastFrame, (f) => f.includes('Type REINSTALL to proceed'));
    await tick(50);

    await typeText(stdin, 'reinstall');
    await waitFor(lastFrame, (f) => f.includes('reinstall'));
    stdin.write(ENTER);
    await waitFor(lastFrame, (f) => f.includes('Exact text required'));
    expect(onChoice).not.toHaveBeenCalled();
  });

  it('typing REINSTALL exactly fires onChoice("reinstall")', async () => {
    const onChoice = vi.fn();
    const { stdin, lastFrame } = await mount(
      <ExistingInstallGate state={state} onChoice={onChoice} />,
    );

    stdin.write(ARROW_DOWN);
    await tick(30);
    stdin.write(ENTER);
    await waitFor(lastFrame, (f) => f.includes('Type REINSTALL to proceed'));
    await tick(50);

    await typeText(stdin, 'REINSTALL');
    stdin.write(ENTER);
    await waitFor(() => (onChoice.mock.calls.length > 0 ? 'ok' : ''), (f) => f === 'ok');

    expect(onChoice).toHaveBeenCalledWith('reinstall');
  });
});
