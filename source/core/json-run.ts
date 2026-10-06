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
const JSON_COMMANDS = new Set(['update', 'adopt', 'validate']);

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
 * True for a `--json` run of update, adopt, validate or the status command (no
 * subcommand): `--json` before any `--`, and no help or version flag, which
 * Pastel answers (#302). (`--json=true` is not a form Commander accepts for a
 * boolean flag.)
 */
export function isJsonRun(argv: readonly string[]): boolean {
  const args = beforeTerminator(argv);
  if (!args.includes('--json')) return false;
  if (args.some((arg) => arg === '-h' || arg === '--help' || arg === '-v' || arg === '--version')) return false;
  const subcommand = subcommandOf(argv);
  return subcommand === undefined || JSON_COMMANDS.has(subcommand);
}
