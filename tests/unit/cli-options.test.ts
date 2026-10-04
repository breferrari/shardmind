/**
 * #147: an option declared on the root command silently shadowed the
 * same-named option on a subcommand — `adopt --verbose` reached adopt as
 * `false`. These tests run the cli-kit (vendored Pastel, #277) over a
 * fixture command tree (`tests/fixtures/cli-options/commands/`) whose
 * components record the options they receive, with Commander's positional
 * options as the cli-kit's program builder enables them.
 */

import path from 'node:path';
import { Console } from 'node:console';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import Pastel, { createProgram } from '../../source/cli-kit/index.js';
import { waitFor } from '../component/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ENTRY = pathToFileURL(path.resolve(__dirname, '../fixtures/cli-options/cli.js')).href;

type Seen = { command: string; options: Record<string, unknown> };
declare global {
  // eslint-disable-next-line no-var
  var __cliOptionsSink: ((command: string, options: Record<string, unknown>) => void) | undefined;
}

/** Run the fixture CLI with `args` and return what the dispatched command received. */
async function run(...args: string[]): Promise<Seen> {
  let seen: Seen | undefined;
  globalThis.__cliOptionsSink = (command, options) => {
    seen ??= { command, options };
  };
  const app = new Pastel({ importMeta: { url: FIXTURE_ENTRY } as ImportMeta, name: 'fixture' });
  await app.run(['node', 'fixture', ...args]);
  await waitFor(() => (seen ? 'seen' : ''), (f) => f === 'seen');
  if (!seen) throw new Error(`no command rendered for: ${args.join(' ')}`);
  return seen;
}

// Pastel renders through Ink, whose console patching constructs a
// `console.Console`; vitest's console wrapper does not carry one.
beforeAll(() => {
  if (!('Console' in console)) Object.assign(console, { Console });
});

afterEach(() => {
  globalThis.__cliOptionsSink = undefined;
});

describe('Commander positional options under Pastel (#147)', () => {
  it('adopt --verbose reaches adopt', async () => {
    const seen = await run('adopt', '--verbose');
    expect(seen.command).toBe('adopt');
    expect(seen.options['verbose']).toBe(true);
  });

  it('adopt --no-update-check reaches adopt', async () => {
    const seen = await run('adopt', '--no-update-check');
    expect(seen.options['updateCheck']).toBe(false);
  });

  it('--no-update-check reaches the root (status)', async () => {
    const seen = await run('--no-update-check');
    expect(seen.command).toBe('index');
    expect(seen.options['updateCheck']).toBe(false);
  });

  it('--verbose with no subcommand reaches the root (status)', async () => {
    const seen = await run('--verbose');
    expect(seen.command).toBe('index');
    expect(seen.options['verbose']).toBe(true);
  });
});

// Error paths and parseAsync, on the program the cli-kit builds
// (createProgram). The cli-kit itself exits the process on a parse error,
// so these use exitOverride instead of `run`.
describe('the cli-kit program, directly', () => {
  interface Prog {
    exitOverride(): Prog;
    configureOutput(o: { writeErr: (s: string) => void; writeOut: (s: string) => void }): Prog;
    option(flag: string): Prog;
    command(name: string): Prog;
    action(fn: (opts: Record<string, unknown>) => void): Prog;
    parse(argv: string[], o: { from: 'user' }): Prog;
    parseAsync(argv: string[], o: { from: 'user' }): Promise<Prog>;
  }

  function program() {
    const errors: string[] = [];
    let adopt: Record<string, unknown> | undefined;
    const root = (createProgram() as unknown as Prog)
      .exitOverride()
      .configureOutput({ writeErr: (s) => errors.push(s), writeOut: () => {} })
      .option('--verbose')
      .option('--no-update-check');
    root.command('adopt').exitOverride().option('--verbose').option('--no-update-check').option('--dry-run')
      .action((opts) => { adopt = opts; });
    // A subcommand that takes neither root option, for the refusal path.
    root.command('bare').exitOverride().action(() => {});
    return { root, errors, adopt: () => adopt };
  }

  it('passes a root flag written before a subcommand on to it', () => {
    const p = program();
    p.root.parse(['--verbose', 'adopt', '--dry-run'], { from: 'user' });
    expect(p.adopt()).toMatchObject({ verbose: true, dryRun: true });
  });

  it('passes several root flags on, negated ones included', () => {
    const p = program();
    p.root.parse(['--no-update-check', '--verbose', 'adopt'], { from: 'user' });
    expect(p.adopt()).toMatchObject({ verbose: true, updateCheck: false });
  });

  it('refuses root flags the subcommand does not take, naming all of them', () => {
    const p = program();
    expect(() => p.root.parse(['--verbose', '--no-update-check', 'bare'], { from: 'user' })).toThrow();
    const err = p.errors.join('');
    expect(err).toContain("'--verbose', '--no-update-check' are options of");
    expect(err).toContain("'bare' does not take them");
  });

  it('treats a root-only flag after a subcommand as the subcommand\'s, so unknown', () => {
    const p = program();
    p.root.option('--root-only');
    expect(() => p.root.parse(['adopt', '--root-only'], { from: 'user' })).toThrow();
    // Positional mode: the subcommand parses it, and does not know it. Without
    // it, the root would take the flag and the refusal message would show.
    expect(p.errors.join('')).toContain("unknown option '--root-only'");
  });

  it('gives an unknown flag after a subcommand Commander\'s own error', () => {
    const p = program();
    expect(() => p.root.parse(['adopt', '--bogus'], { from: 'user' })).toThrow();
    expect(p.errors.join('')).toContain("unknown option '--bogus'");
  });

  it('applies to parseAsync as well as parse, forwarding included', async () => {
    const p = program();
    await p.root.parseAsync(['adopt', '--verbose'], { from: 'user' });
    expect(p.adopt()?.['verbose']).toBe(true);
    const q = program();
    await q.root.parseAsync(['--verbose', 'adopt'], { from: 'user' });
    expect(q.adopt()?.['verbose']).toBe(true);
  });
});

// Pastel maps a boolean option that defaults to `true` to a `--no-<name>` flag,
// which Commander stores under `<name>`. An option named `noUpdateCheck`
// defaulting to `false` instead became the flag `--no-update-check` stored
// under `updateCheck`, so it never reached the command (#147). The fixture
// above proves the mapping; this pins that every real command declares the
// option in that shape.
describe('update-check option shape on the real commands', () => {
  it.each(['index', 'install', 'update', 'adopt'])('%s declares updateCheck, defaulting to true', async (name) => {
    const mod = (await import(`../../source/commands/${name}.tsx`)) as {
      options: { shape: Record<string, unknown>; parse: (v: unknown) => Record<string, unknown> };
    };
    expect(Object.keys(mod.options.shape)).toContain('updateCheck');
    expect(Object.keys(mod.options.shape)).not.toContain('noUpdateCheck');
    expect(mod.options.parse({})['updateCheck']).toBe(true);
  });
});

// The cli-kit names a variadic option's value with plur's regular rule only
// (cli-kit/lib/plur.ts drops plur's irregular plurals), which is safe while
// no command declares one. Pastel makes an option variadic when its schema,
// unwrapped, is an array or a set.
describe('no real command declares a variadic option', () => {
  type Def = { type: string; innerType?: { _zod: { def: Def } } };
  const unwrap = (def: Def): Def => (def.innerType ? unwrap(def.innerType._zod.def) : def);

  it.each(['index', 'install', 'update', 'adopt', 'validate'])('%s', async (name) => {
    const mod = (await import(`../../source/commands/${name}.tsx`)) as {
      options?: { shape: Record<string, { _zod: { def: Def } }> };
    };
    const variadic = Object.entries(mod.options?.shape ?? {})
      .filter(([, schema]) => ['array', 'set'].includes(unwrap(schema._zod.def).type))
      .map(([key]) => key);
    expect(variadic).toEqual([]);
  });
});
