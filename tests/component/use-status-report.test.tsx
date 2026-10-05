/**
 * `useStatusReport`'s exit (#285): status exits once its phase is terminal,
 * unless `holdExit` holds it, which the status command sets until the
 * self-update cache read is done, so a cached banner always renders.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { useEffect } from 'react';
import { Text } from 'ink';
import { render, cleanup } from 'ink-testing-library';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { useStatusReport } from '../../source/commands/hooks/use-status-report.js';
import { tick, waitFor } from './helpers.js';

const dirs: string[] = [];
afterEach(async () => {
  cleanup();
  for (const d of dirs.splice(0)) await fsp.rm(d, { recursive: true, force: true });
});

/** Renders the phase; `onUnmount` fires when Ink's exit tears the tree down. */
function Probe({ vaultRoot, holdExit, onUnmount }: { vaultRoot: string; holdExit: boolean; onUnmount: () => void }) {
  const { phase } = useStatusReport({ vaultRoot, verbose: false, skipUpdateCheck: true, holdExit });
  useEffect(() => onUnmount, [onUnmount]);
  return <Text>{phase.kind}</Text>;
}

describe('useStatusReport exit (#285)', () => {
  it('holds the exit while holdExit is set, and exits once it is released', async () => {
    // No .shardmind/ here: the report settles at once on `not-in-vault`.
    const vaultRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'status-hold-'));
    dirs.push(vaultRoot);
    let exited = false;
    const onUnmount = () => {
      exited = true;
    };
    const r = render(<Probe vaultRoot={vaultRoot} holdExit={true} onUnmount={onUnmount} />);
    await waitFor(r.lastFrame, (f) => f.includes('not-in-vault'), 10_000);
    await tick(300); // well past the 50 ms exit deferral
    expect(exited).toBe(false);

    r.rerender(<Probe vaultRoot={vaultRoot} holdExit={false} onUnmount={onUnmount} />);
    const start = Date.now();
    while (!exited && Date.now() - start < 5_000) await tick(20);
    expect(exited).toBe(true);
  }, 20_000);

  it('exits on a terminal phase when nothing holds it', async () => {
    const vaultRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'status-hold-'));
    dirs.push(vaultRoot);
    let exited = false;
    const onUnmount = () => {
      exited = true;
    };
    render(<Probe vaultRoot={vaultRoot} holdExit={false} onUnmount={onUnmount} />);
    const start = Date.now();
    while (!exited && Date.now() - start < 5_000) await tick(20);
    expect(exited).toBe(true);
  }, 20_000);
});
