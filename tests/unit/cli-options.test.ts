/**
 * #147: an option declared on the root command silently shadowed the
 * same-named option on a subcommand — `adopt --verbose` reached adopt as
 * `false`. These tests run real Pastel over a fixture command tree
 * (`tests/fixtures/cli-options/commands/`) whose components record the
 * options they receive, with Commander's positional options enabled the way
 * `source/cli.ts` enables them.
 */

import path from 'node:path';
import { Console } from 'node:console';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import Pastel from 'pastel';
import { enablePositionalOptions, pastelCommander } from '../../source/cli-options.js';
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
  beforeAll(() => {
    enablePositionalOptions(pastelCommander());
  });

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

  it('is idempotent: a second call does not wrap parse again', async () => {
    const proto = (pastelCommander().prototype as { parse: unknown; parseAsync: unknown });
    const [parse, parseAsync] = [proto.parse, proto.parseAsync];
    enablePositionalOptions(pastelCommander());
    expect(proto.parse).toBe(parse);
    expect(proto.parseAsync).toBe(parseAsync);
    const seen = await run('adopt', '--verbose');
    expect(seen.options['verbose']).toBe(true);
  });
});

// Error paths and parseAsync, on a program built from Pastel's own Commander
// the way Pastel builds it. Pastel itself exits the process on a parse error,
// so these use exitOverride instead of `run`.
describe('the patched Commander, directly', () => {
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
    const Command = pastelCommander() as unknown as new () => Prog;
    const errors: string[] = [];
    let adopt: Record<string, unknown> | undefined;
    const root = new Command()
      .exitOverride()
      .configureOutput({ writeErr: (s) => errors.push(s), writeOut: () => {} })
      .option('--verbose')
      .option('--no-update-check');
    root.command('adopt').exitOverride().option('--verbose').option('--dry-run')
      .action((opts) => { adopt = opts; });
    return { root, errors, adopt: () => adopt };
  }

  beforeAll(() => {
    enablePositionalOptions(pastelCommander());
  });

  it('refuses a root flag written before a subcommand, saying where it belongs', () => {
    const p = program();
    expect(() => p.root.parse(['--verbose', 'adopt', '--dry-run'], { from: 'user' })).toThrow();
    expect(p.errors.join('')).toContain("'--verbose' is an option of");
    expect(p.errors.join('')).toContain('adopt --verbose');
    expect(p.adopt()).toBeUndefined();
  });

  it('refuses a negated root flag before a subcommand too', () => {
    const p = program();
    expect(() => p.root.parse(['--no-update-check', 'adopt'], { from: 'user' })).toThrow();
    expect(p.errors.join('')).toContain("'--no-update-check'");
  });

  it('gives an unknown flag after a subcommand Commander\'s own error', () => {
    const p = program();
    expect(() => p.root.parse(['adopt', '--bogus'], { from: 'user' })).toThrow();
    expect(p.errors.join('')).toContain("unknown option '--bogus'");
  });

  it('applies to parseAsync as well as parse', async () => {
    const p = program();
    await p.root.parseAsync(['adopt', '--verbose'], { from: 'user' });
    expect(p.adopt()?.['verbose']).toBe(true);
  });
});

describe('enablePositionalOptions guard', () => {
  it('refuses a Command class without enablePositionalOptions, so an upgrade fails loudly', () => {
    class NotCommander {
      parse(): void {}
    }
    expect(() => enablePositionalOptions(NotCommander)).toThrow(/enablePositionalOptions/);
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
