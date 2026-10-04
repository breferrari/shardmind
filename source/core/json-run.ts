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

type Write = (chunk: string | Uint8Array, ...rest: unknown[]) => boolean;

/**
 * Keeps a `--json` document's single trailing newline (#231). At unmount Ink
 * in non-interactive mode writes its last frame plus `'\n'`; under --json the
 * frame is empty, so a lone `'\n'` followed the document. Once a write has
 * carried content, a later write of exactly `'\n'` is dropped (its callback
 * still fires, since Ink waits on it before exiting). Nothing else is touched.
 */
export function dropTrailingBlankWrites(stream: Pick<NodeJS.WritableStream, 'write'>): void {
  const write = stream.write.bind(stream) as Write;
  let wroteContent = false;
  const filtered: Write = (chunk, ...rest) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    if (wroteContent && text === '\n') {
      const callback = rest.find((r): r is () => void => typeof r === 'function');
      callback?.();
      return true;
    }
    if (text.trim() !== '') wroteContent = true;
    return write(chunk, ...rest);
  };
  // `write` is overloaded; the filter forwards every overload's arguments as is.
  stream.write = filtered as NodeJS.WritableStream['write'];
}
