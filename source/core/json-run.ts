/**
 * `--json` in a terminal (#198). Spec: docs/IMPLEMENTATION.md §4.23.
 *
 * A mounted Ink app in a TTY writes synchronized-output and cursor codes
 * around its frame even when it renders nothing, so a `--json` document came
 * out wrapped in them. Ink decides from `stdout.isTTY` and Pastel passes no
 * render options, so `source/cli.ts` marks stdout non-interactive for a
 * `--json` run before anything loads Ink, and the run writes exactly what it
 * writes piped. stdin is left alone (the machines refuse prompts under
 * `--json` themselves). Imports nothing, so `cli.ts` can load it statically.
 */

// Commands with a `--json`. Install has none. `validate --json` never mounts
// Ink (#34), so marking stdout changes nothing there; it is listed so a crash
// outside its runner still answers on stdout (cli.ts).
const JSON_COMMANDS = new Set(['update', 'adopt', 'validate']);

/**
 * True for a `--json` run of update, adopt, validate or the status command (no
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
 * Makes `stream` (process.stdout) report that it is not a terminal, so Ink
 * renders non-interactively. Only Ink's interactive decision and the
 * self-update banner (already off under --json) read `stdout.isTTY`.
 */
export function markNonInteractive(stream: { isTTY?: boolean }): void {
  Object.defineProperty(stream, 'isTTY', { value: false, configurable: true, writable: true });
}
