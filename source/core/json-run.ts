/**
 * `--json` in a terminal (#198). Spec: docs/IMPLEMENTATION.md §4.21.
 *
 * A mounted Ink app in a TTY writes synchronized-output and cursor codes
 * around its frame even when it renders nothing, so a `--json` document came
 * out wrapped in them. Ink decides from `stdout.isTTY` and Pastel passes no
 * render options, so `source/cli.ts` marks stdout non-interactive for a
 * `--json` run before anything loads Ink. The run then behaves exactly as it
 * does piped. Imports nothing, so `cli.ts` can load it statically.
 */

// Commands whose `--json` runs through the Ink app. `validate --json` never
// mounts Ink (#34), and install has no `--json`.
const JSON_COMMANDS = new Set(['update', 'adopt']);

/**
 * True for a `--json` run of update, adopt or the status command (no
 * subcommand): `--json` or `--json=true` before any `--`, and no help flag.
 */
export function isJsonRun(argv: readonly string[]): boolean {
  const end = argv.indexOf('--');
  const args = end === -1 ? argv : argv.slice(0, end);
  if (!args.some((arg) => arg === '--json' || arg === '--json=true')) return false;
  if (args.some((arg) => arg === '-h' || arg === '--help')) return false;
  const subcommand = args.find((arg) => !arg.startsWith('-'));
  return subcommand === undefined || JSON_COMMANDS.has(subcommand);
}

/** Makes `stream` (process.stdout) report that it is not a terminal. stdin and stderr are untouched. */
export function markStdoutNonInteractive(stream: { isTTY?: boolean }): void {
  Object.defineProperty(stream, 'isTTY', { value: false, configurable: true, writable: true });
}
