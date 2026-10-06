/**
 * Which runs are `--json` runs (#198, #302). Spec: docs/IMPLEMENTATION.md
 * §4.23, §4.29.
 *
 * `source/cli.ts` answers a `--json` run of these commands headless, before
 * anything loads Ink, so the run writes in a terminal exactly what it writes
 * piped, and a crash in it answers on stdout. Imports nothing, so `cli.ts` can
 * load it statically.
 */

// Commands with a `--json`, each answered headless (#302). Install has none.
// cli.ts keys its runners on `JsonRunCommand`, so the two lists cannot drift.
const JSON_COMMANDS: readonly string[] = ['update', 'adopt', 'validate'] satisfies readonly JsonRunCommand[];

/** A command a `--json` run is answered by: a subcommand, or the status command (the root). */
export type JsonRunCommand = 'update' | 'adopt' | 'validate' | 'status';

/** The arguments before any `--`. */
function beforeTerminator(argv: readonly string[]): readonly string[] {
  const end = argv.indexOf('--');
  return end === -1 ? argv : argv.slice(0, end);
}

/**
 * The run's subcommand: the first argument before any `--` that is not an
 * option, or undefined for the status command (the root). Every root option
 * is a boolean flag, so no option value is read as one (#302).
 */
export function subcommandOf(argv: readonly string[]): string | undefined {
  return beforeTerminator(argv).find((arg) => !arg.startsWith('-'));
}

/**
 * A `--json` run's command and the arguments its runner takes: `argv` with
 * the subcommand removed, so a root option before it (`--verbose adopt`) is
 * passed on, as Pastel passes it on (#147). Undefined for a run that is not
 * a `--json` run (`isJsonRun`).
 */
export function jsonRunOf(argv: readonly string[]): { command: JsonRunCommand; rest: readonly string[] } | undefined {
  const args = beforeTerminator(argv);
  if (!args.includes('--json')) return undefined;
  if (args.some((arg) => arg === '-h' || arg === '--help' || arg === '-v' || arg === '--version')) return undefined;
  const at = args.findIndex((arg) => !arg.startsWith('-'));
  if (at === -1) return { command: 'status', rest: argv };
  const subcommand = args[at]!;
  if (!JSON_COMMANDS.includes(subcommand)) return undefined;
  return { command: subcommand as JsonRunCommand, rest: [...argv.slice(0, at), ...argv.slice(at + 1)] };
}

/**
 * True for a `--json` run of update, adopt, validate or the status command (no
 * subcommand): `--json` before any `--`, and no help or version flag, which
 * Pastel answers (#302). (`--json=true` is not a form Commander accepts for a
 * boolean flag.)
 */
export function isJsonRun(argv: readonly string[]): boolean {
  return jsonRunOf(argv) !== undefined;
}
