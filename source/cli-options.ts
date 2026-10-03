/**
 * Option scope for the CLI (#147): an option written after a subcommand name
 * belongs to that subcommand.
 *
 * Commander binds program-level options anywhere on the line by default, so
 * every option the root (status) command declares — `--verbose`,
 * `--no-update-check` — silently shadowed the same-named option on `adopt`,
 * `update` and `install`, which then saw their schema default. Commander's
 * documented switch is `enablePositionalOptions()` on the program, but Pastel
 * builds the program inside `run()` and never calls it, nor exposes it.
 *
 * So the engine patches `Command.prototype.parse` on Pastel's own Commander
 * (resolved from Pastel's location, since Pastel ships a nested copy) to
 * enable positional options on the root command before it parses. A flag a
 * subcommand does not declare is then Commander's `unknown option` error
 * instead of being swallowed, and a root option written before a subcommand
 * (`shardmind --verbose adopt`) is refused with where it belongs, since the
 * root command never runs when a subcommand does and the flag would do
 * nothing.
 *
 * Remove this module once Pastel enables positional options itself, or
 * exposes the program so the caller can.
 *
 * Spec: docs/ARCHITECTURE.md §10.1 (Option scope).
 */

import { createRequire } from 'node:module';

interface OptionLike {
  long?: string;
  attributeName(): string;
}

interface CommandLike {
  parse(...args: unknown[]): unknown;
  parseAsync(...args: unknown[]): unknown;
  enablePositionalOptions(positional?: boolean): unknown;
  hook(event: 'preSubcommand', listener: (thisCommand: CommandLike, sub: CommandLike) => void): unknown;
  getOptionValueSource(key: string): string | undefined;
  error(message: string, details?: { code?: string; exitCode?: number }): never;
  name(): string;
  options: readonly OptionLike[];
  parent?: unknown;
}

type CommandCtor = { prototype: object };

const PATCHED = Symbol.for('shardmind.positionalOptions');
const HOOKED = Symbol.for('shardmind.rootOptionGuard');

/**
 * Refuse a root option given on the command line before a subcommand: the
 * root command does not run when a subcommand does, so the flag would
 * silently do nothing — #147 in the other position.
 */
function refuseRootOptionsBeforeSubcommand(root: CommandLike, sub: CommandLike): void {
  for (const option of root.options) {
    if (root.getOptionValueSource(option.attributeName()) !== 'cli') continue;
    const flag = option.long ?? option.attributeName();
    root.error(
      `error: '${flag}' is an option of '${root.name()}' itself, not of '${sub.name()}'. To pass it to ${sub.name()}, write it after the subcommand: ${root.name()} ${sub.name()} ${flag}`,
      { code: 'shardmind.rootOptionBeforeSubcommand', exitCode: 1 },
    );
  }
}

/**
 * The `Command` class Pastel constructs its program from. Resolved through
 * Pastel's own location: Pastel depends on a different Commander major than
 * anything hoisted to the top level, and only its copy matters here.
 */
export function pastelCommander(): CommandCtor {
  const fromHere = createRequire(import.meta.url);
  const fromPastel = createRequire(fromHere.resolve('pastel'));
  return (fromPastel('commander') as { Command: CommandCtor }).Command;
}

/**
 * Make every root `Command` of this class parse with positional options.
 * Idempotent. Throws when the class has no `enablePositionalOptions`, so a
 * Pastel or Commander upgrade that drops it fails the test suite instead of
 * silently bringing #147 back.
 */
export function enablePositionalOptions(Command: CommandCtor): void {
  const proto = Command.prototype as Partial<CommandLike> & { [PATCHED]?: true };
  if (typeof proto.enablePositionalOptions !== 'function') {
    throw new Error('Commander has no enablePositionalOptions(); the #147 option-scope fix needs it.');
  }
  if (proto[PATCHED]) return;
  // Pastel calls `parse`; `parseAsync` is covered too so a Pastel switch to
  // it does not silently bring #147 back.
  for (const method of ['parse', 'parseAsync'] as const) {
    const original = proto[method];
    if (typeof original !== 'function') continue;
    proto[method] = function patched(this: CommandLike & { [HOOKED]?: true }, ...args: unknown[]) {
      // Only the program (no parent) decides where its options may appear.
      if (!this.parent) {
        this.enablePositionalOptions();
        if (!this[HOOKED]) {
          this.hook('preSubcommand', refuseRootOptionsBeforeSubcommand);
          this[HOOKED] = true;
        }
      }
      return original.apply(this, args);
    };
  }
  proto[PATCHED] = true;
}
