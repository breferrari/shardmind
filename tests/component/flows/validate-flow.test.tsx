/**
 * Layer 1 flow test for `shardmind validate` (#34): the command's own React
 * tree, mounted as Pastel mounts it, on a local shard directory.
 */

import React from 'react';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Validate from '../../../source/commands/validate.js';
import { waitFor } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MINIMAL_SHARD = path.resolve(__dirname, '../../../examples/minimal-shard');
const OPTIONS = { json: false, verbose: true, updateCheck: false };
/**
 * Every frame the view drew, whitespace collapsed: it exits once the result
 * paints, which blanks the last frame, and a long path wraps the line.
 */
const allFrames = (r: { frames: string[] }) => () => r.frames.join(' ').replace(/\s+/g, ' ');

describe('validate command — Layer 1 flow (#34)', () => {
  let root: string;
  const exitCode = process.exitCode;

  beforeEach(async () => {
    root = path.join(os.tmpdir(), `shardmind-validate-flow-${crypto.randomUUID()}`);
    await fs.cp(MINIMAL_SHARD, root, { recursive: true });
  });

  afterEach(async () => {
    cleanup();
    process.exitCode = exitCode;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('shows a clean summary for a clean shard', async () => {
    const r = render(<Validate args={[root]} options={OPTIONS} />);
    const frame = await waitFor(allFrames(r), (f) => /0 errors, 0 warnings/.test(f), 15_000);
    expect(frame).toContain('✓');
  });

  it('warns when a shard with a hook installs no .gitignore for its logs, and still passes (#201)', async () => {
    await fs.rm(path.join(root, '.gitignore'));
    const r = render(<Validate args={[root]} options={OPTIONS} />);
    const frame = await waitFor(allFrames(r), (f) => /0 errors, 1 warning/.test(f), 15_000);
    expect(frame).toMatch(/LINT_LOGS_NOT_GITIGNORED/);
    expect(frame).toMatch(/\.shardmind\/logs\//);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('lists a broken template with its code, hint and ERRORS link, and sets exit code 1', async () => {
    await fs.writeFile(path.join(root, 'brain', 'Broken.md.njk'), '{% if %}\n');
    const r = render(<Validate args={[root]} options={OPTIONS} />);
    const frame = await waitFor(allFrames(r), (f) => /1 error/.test(f), 15_000);
    expect(frame).toMatch(/brain\/Broken\.md/);
    expect(frame).toMatch(/docs\/ERRORS\.md#render_/);
    expect(process.exitCode).toBe(1);
  });

  it('says it could not check a target that is neither a shard nor a reference', async () => {
    const r = render(<Validate args={[path.join(root, 'no-such-dir')]} options={OPTIONS} />);
    const frame = await waitFor(allFrames(r), (f) => /Could not check the shard/.test(f), 15_000);
    expect(frame).toMatch(/Could not check/);
    expect(process.exitCode).toBe(1);
  });
});
