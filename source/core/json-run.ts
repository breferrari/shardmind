/**
 * `--json` in a terminal (#198). Spec: docs/IMPLEMENTATION.md §4.23.
 *
 * A mounted Ink app in a TTY writes synchronized-output and cursor codes
 * around its frame even when it renders nothing, so a `--json` document came
 * out wrapped in them, and Ink offers prompts when `stdin.isTTY`, which
 * under --json renders nothing and waits forever. `source/cli.ts` marks
 * stdout and stdin non-interactive for a `--json` run before anything loads
 * Ink, so the run behaves exactly as it does piped. Imports nothing, so
 * `cli.ts` can load it statically.
 */

// Commands whose `--json` runs through the Ink app. `validate --json` never
// mounts Ink (#34), and install has no `--json`.
const JSON_COMMANDS = new Set(['update', 'adopt']);

/**
 * True for a `--json` run of update, adopt or the status command (no
 * subcommand): `--json` before any `--`, and no help flag. (`--json=true` is
 * not a form Commander accepts for a boolean flag.)
 */
export function isJsonRun(argv: readonly string[]): boolean {
  const end = argv.indexOf('--');
  const args = end === -1 ? argv : argv.slice(0, end);
  if (!args.includes('--json')) return false;
  if (args.some((arg) => arg === '-h' || arg === '--help')) return false;
  const subcommand = args.find((arg) => !arg.startsWith('-'));
  return subcommand === undefined || JSON_COMMANDS.has(subcommand);
}

/**
 * Makes `stream` report that it is not a terminal. Called on stdout (Ink then
 * writes no cursor codes) and stdin (Ink then offers no prompt, so a command
 * that needs answers refuses as it does piped). stderr is never touched.
 */
export function markNonInteractive(stream: { isTTY?: boolean }): void {
  Object.defineProperty(stream, 'isTTY', { value: false, configurable: true, writable: true });
}
