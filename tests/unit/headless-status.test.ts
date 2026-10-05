/**
 * `shardmind --json` runs headless (#302): parsed with the command's own
 * options, answered with one document, never through Ink.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runStatusJson } from '../../source/commands/headless/status.js';

let dir: string;
let cwd: string;

beforeEach(async () => {
  dir = path.join(os.tmpdir(), `shardmind-headless-status-${crypto.randomUUID()}`);
  await fsp.mkdir(dir, { recursive: true });
  cwd = process.cwd();
  process.chdir(dir);
});

afterEach(async () => {
  process.chdir(cwd);
  await fsp.rm(dir, { recursive: true, force: true });
});

async function run(argv: string[]) {
  let out = '';
  const code = await runStatusJson(argv, '0.0.0-test', (chunk) => {
    out += chunk;
  });
  return { code, doc: JSON.parse(out) as Record<string, unknown>, out };
}

describe('runStatusJson (#302)', () => {
  it('outside a vault answers ok with a null result and exits 0, as the Ink run did', async () => {
    const { code, doc, out } = await run(['--json']);
    expect(code).toBe(0);
    expect(doc).toMatchObject({ ok: true, command: 'status', result: { installed: false } });
    // One document, one trailing newline (#231).
    expect(out.endsWith('}\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });

  it('a flag the status command does not take is a failure document, exit 1', async () => {
    const { code, doc } = await run(['--json', '--nope']);
    expect(code).toBe(1);
    expect(doc).toMatchObject({ ok: false, command: 'status', error: { code: 'ARGS_INVALID', message: "error: unknown option '--nope'" } });
  });

  it('a state.json it cannot read is a failure document, exit 1', async () => {
    await fsp.mkdir(path.join(dir, '.shardmind'));
    await fsp.writeFile(path.join(dir, '.shardmind', 'state.json'), '{ not json');
    const { code, doc } = await run(['--json', '--verbose', '--no-update-check']);
    expect(code).toBe(1);
    expect(doc).toMatchObject({ ok: false, command: 'status' });
  });
});
