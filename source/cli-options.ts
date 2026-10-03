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
 * enable positional options on the root command before it parses. Root
 * options then go before the subcommand, and a flag a subcommand does not
 * declare is Commander's `unknown option` error instead of being swallowed.
 *
 * Remove this module once Pastel enables positional options itself, or
 * exposes the program so the caller can.
 *
 * Spec: docs/ARCHITECTURE.md §10.1 (Option scope).
 */

import { createRequire } from 'node:module';

interface CommandLike {
  parse(...args: unknown[]): unknown;
  parseAsync(...args: unknown[]): unknown;
  enablePositionalOptions(positional?: boolean): unknown;
  parent?: unknown;
}

type CommandCtor = { prototype: object };

const PATCHED = Symbol.for('shardmind.positionalOptions');

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
    proto[method] = function patched(this: CommandLike, ...args: unknown[]) {
      // Only the program (no parent) decides where its options may appear.
      if (!this.parent) this.enablePositionalOptions();
      return original.apply(this, args);
    };
  }
  proto[PATCHED] = true;
}
