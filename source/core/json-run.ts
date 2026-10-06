/**
 * Which runs are `--json` runs (#198, #302). Spec: docs/IMPLEMENTATION.md
 * §4.23, §4.29.
 *
 * `source/cli.ts` answers a `--json` run of these commands headless, before
 * anything loads Ink, so the run writes in a terminal exactly what it writes
 * piped, and a crash in it answers on stdout. Imports nothing, so `cli.ts` can
 * load it statically.
 */

// Subcommands with a `--json`, each answered headless (#302). Install has none.
const JSON_SUBCOMMANDS = ['update', 'adopt', 'validate'] as const;

/**
 * A command a `--json` run is answered by: a subcommand, or the status
 * command (the root). cli.ts keys its runners on it, so a command here
 * without a runner is a type error.
 */
export type JsonRunCommand = (typeof JSON_SUBCOMMANDS)[number] | 'status';

function isJsonSubcommand(arg: string): arg is (typeof JSON_SUBCOMMANDS)[number] {
  return (JSON_SUBCOMMANDS as readonly string[]).includes(arg);
}

/** The arguments before any `--`. */
function beforeTerminator(argv: readonly string[]): readonly string[] {
  const end = argv.indexOf('--');
  return end === -1 ? argv : argv.slice(0, end);
}

/**
 * A `--json` run's command and the arguments its runner takes, or undefined
 * for a run that is not one. A `--json` run has `--json` before any `--`, no
 * help or version flag (Pastel answers those), and as its subcommand (the
 * first argument before any `--` that is not an option) update, adopt,
 * validate, or none (the status command). Every root option is a boolean
 * flag, so no option value is read as the subcommand. `--json=true` is not a
 * form Commander accepts for a boolean flag.
 *
 * The runner's arguments are `argv` with the subcommand removed, so a root
 * option before it (`--verbose adopt`) is passed on, as Pastel passes it on
 * (#147).
 */
export function jsonRunOf(argv: readonly string[]): { command: JsonRunCommand; rest: readonly string[] } | undefined {
  const args = beforeTerminator(argv);
  if (!args.includes('--json')) return undefined;
  if (args.some((arg) => arg === '-h' || arg === '--help' || arg === '-v' || arg === '--version')) return undefined;
  const at = args.findIndex((arg) => !arg.startsWith('-'));
  if (at === -1) return { command: 'status', rest: argv };
  const subcommand = args[at]!;
  if (!isJsonSubcommand(subcommand)) return undefined;
  return { command: subcommand, rest: [...argv.slice(0, at), ...argv.slice(at + 1)] };
}
