/**
 * A bug that no command's error view catches (#225).
 *
 * The crashes are made real: a copy of `dist/` whose root command module is
 * replaced. The copy sits in a temp dir with a link to the repo's
 * `node_modules`, so its imports resolve as the real build's do.
 *
 * - A module that throws when Pastel loads it escapes every command: the
 *   top-level handler in `cli.ts` prints it as plain text to stderr, and a
 *   `--json` run also writes it as a failure document to stdout.
 * - A command that throws while it renders reaches the CrashBoundary in
 *   `commands/_app.tsx`, which shows it through the error view.
 *
 * Both exit 1, with the report link, instead of a bare trace (or Ink's own
 * overview and exit 0).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createBrokenDist, type BrokenDist } from './helpers/broken-dist.js';
import { FAKE_TTY_IMPORT } from '../helpers/fake-tty.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

let dist: BrokenDist;
let version: string;

beforeAll(async () => {
  dist = await createBrokenDist();
  version = (JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as { version: string }).version;
}, 120_000);

afterAll(async () => {
  await dist?.cleanup();
});

function runCli(args: string[], opts: { tty?: boolean } = {}) {
  return spawnSync(process.execPath, [...(opts.tty ? ['--import', FAKE_TTY_IMPORT] : []), dist.cli, ...args], {
    cwd: dist.root,
    env: { ...process.env, CI: '1', NO_COLOR: '1', SHARDMIND_NO_UPDATE_CHECK: '1' },
    encoding: 'utf-8',
    timeout: 60_000,
  });
}

/** Replace the root command's module in the copy, and run `shardmind` with no arguments. */
async function runWithRootCommand(source: string) {
  await dist.setRootCommand(source);
  return runCli([]);
}

describe('a bug no error view catches (#225)', () => {
  it('prints a throw that escapes every command with the report link and the stack, and exits 1', async () => {
    const result = await runWithRootCommand("throw new TypeError('boom from a broken command module');\n");
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('boom from a broken command module');
    expect(result.stderr).toContain('This is a bug in shardmind. Please report it:');
    expect(result.stderr).toContain(`https://github.com/breferrari/shardmind/issues/new?body=shardmind+${version}`);
    expect(result.stderr).toMatch(/TypeError: boom from a broken command module\s+at /);
    expect(result.stderr).not.toContain('\u001b');
  }, 60_000);

  it('shows a throw while a command renders through the error view, and exits 1, not 0', async () => {
    const result = await runWithRootCommand(
      "export default function Index() { throw new TypeError('boom while rendering'); }\n",
    );
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain('boom while rendering');
    expect(result.stdout).toContain('This is a bug in shardmind. Please report it:');
    expect(result.stdout).toContain(`issues/new?body=shardmind+${version}`);
  }, 60_000);

  // Update's --json still renders through Ink until it runs headless (#302).
  it('writes a throw while a --json command renders as one failure document with the stack', async () => {
    await dist.setCommand(
      'update',
      [
        "import zod from 'zod';",
        "export const options = zod.object({ json: zod.boolean().default(false), dryRun: zod.boolean().default(false) });",
        "export default function Update() { throw new TypeError('boom while rendering json'); }",
        '',
      ].join('\n'),
    );
    const result = runCli(['update', '--dry-run', '--json']);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    const doc = JSON.parse(result.stdout) as { ok: boolean; command: string; error: { code: null; stack: string } };
    expect(doc).toMatchObject({ ok: false, command: 'update', error: { code: null } });
    expect(doc.error.stack).toContain('boom while rendering json');
  }, 60_000);

  // status --json runs headless (#302): a throw its runner does not catch
  // still answers on stdout.
  it('writes a throw from the headless status runner as one failure document with the stack', async () => {
    await dist.setChunk('status', "export async function runStatusJson() { throw new TypeError('boom in the status runner'); }\n");
    const result = runCli(['--json']);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    const doc = JSON.parse(result.stdout) as { ok: boolean; command: string; error: { code: null; stack: string } };
    expect(doc).toMatchObject({ ok: false, command: 'status', error: { code: null } });
    expect(doc.error.stack).toContain('boom in the status runner');
  }, 60_000);

  // A --json caller reads stdout: a crash outside every command still answers
  // there with one failure document, the same piped and in a terminal. The
  // plain-text report stays on stderr for a human.
  it.each([
    // status --json and adopt --json load their headless runners, not the root command (#302).
    ['status --json', ['--json'], 'status', () => dist.setChunk('status', "throw new TypeError('boom from a broken module under json');\n")],
    ['update --dry-run --json', ['update', '--dry-run', '--json'], 'update', () => dist.setRootCommand("throw new TypeError('boom from a broken module under json');\n")],
    ['adopt --dry-run --json', ['adopt', 'github:acme/demo', '--dry-run', '--json'], 'adopt', () => dist.setChunk('adopt', "throw new TypeError('boom from a broken module under json');\n")],
  ] as const)('writes a throw that escapes every command in %s as one failure document on stdout', async (_name, args, command, breakIt) => {
    await breakIt();
    const piped = runCli(args);
    const terminal = runCli(args, { tty: true });
    expect(piped.status, piped.stderr).toBe(1);
    const doc = JSON.parse(piped.stdout) as { ok: boolean; command: string; error: { code: null; stack: string } };
    expect(doc).toMatchObject({ ok: false, command, error: { code: null } });
    expect(doc.error.stack).toMatch(/TypeError: boom from a broken module under json\s+at /);
    expect(piped.stdout.endsWith('}\n')).toBe(true);
    expect(piped.stderr).toContain('This is a bug in shardmind. Please report it:');
    expect(terminal.status).toBe(1);
    expect(terminal.stdout).not.toContain('\u001b');
    expect(terminal.stdout).toBe(piped.stdout);
  }, 60_000);

  // validate --json runs headless and its runner catches its own errors; a
  // crash before the runner (its module failing to load) still answers.
  it('writes a crash outside the validate --json runner as one failure document on stdout', async () => {
    await dist.setChunk('validate-shard', "throw new TypeError('boom loading validate');\n");
    const piped = runCli(['validate', '--json']);
    const terminal = runCli(['validate', '--json'], { tty: true });
    expect(piped.status, piped.stderr).toBe(1);
    const doc = JSON.parse(piped.stdout) as { ok: boolean; command: string; error: { code: null; stack: string } };
    expect(doc).toMatchObject({ ok: false, command: 'validate', error: { code: null } });
    expect(doc.error.stack).toContain('boom loading validate');
    expect(terminal.status).toBe(1);
    expect(terminal.stdout).not.toContain('\u001b');
    expect(terminal.stdout).toBe(piped.stdout);
  }, 60_000);

  it('does not write a second document after a run already wrote one', async () => {
    const jsonOutput = await dist.chunk('json-output');
    await dist.setChunk(
      'status',
      [
        `import { emitJson, jsonSuccess } from './${jsonOutput}';`,
        'export async function runStatusJson() {',
        "  emitJson(jsonSuccess('status', { early: true }));",
        "  throw new TypeError('boom after the document');",
        '}',
        '',
      ].join('\n'),
    );
    const result = runCli(['--json']);
    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, result: { early: true } });
    expect(result.stderr).toContain('boom after the document');
  }, 60_000);

  it('keeps stdout empty for a crash in a run without --json', async () => {
    await dist.setRootCommand("throw new TypeError('boom without json');\n");
    const result = runCli(['update', '--dry-run']);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('boom without json');
  }, 60_000);
});
