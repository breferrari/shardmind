import { createRequire } from 'node:module';
import { installStdinCancellation } from './core/cancellation.js';
import { applyNoColor } from './core/color-env.js';
import { dropTrailingBlankWrites, isJsonRun, markNonInteractive } from './core/json-run.js';
import { exitQuietlyWhenStdoutCloses } from './core/stdout-closed.js';

// NO_COLOR turns colour off unless FORCE_COLOR is set (#37). chalk, which Ink
// colours through, reads the environment once when it is first imported, so
// this runs before Pastel loads Ink: Pastel and cli-options are imported
// dynamically below, never statically above this line.
applyNoColor(process.env);

// A reader that closes stdout early (`shardmind --json | head -1`) ends the run
// quietly with 141 once it has finished, not with a bug report (#252).
// Installed before anything can write.
exitQuietlyWhenStdoutCloses(process);

// A --json run writes in a terminal exactly what it writes piped (#198; see
// core/json-run.ts), so this too runs before anything loads Ink. stdin is
// left alone: the stdin SIGINT bridge reads a non-TTY stdin directly, which
// on a real terminal would stop a backgrounded run (SIGTTIN).
// The document keeps its single trailing newline: Ink's unmount would add
// another (#231). Both are workarounds for a mounted Ink app; running these
// commands headless, as `validate --json` runs below, would retire them.
const jsonRun = isJsonRun(process.argv.slice(2));
if (jsonRun) {
  markNonInteractive(process.stdout);
  dropTrailingBlankWrites(process.stdout);
}

// A throw that escapes every command (a command module that fails to load, a
// rejection nobody awaited) is printed as plain text, since Ink may not be
// mounted, and exits 1 (#225). The SIGINT path is not touched: Ctrl+C still
// exits 130.
const { installCrashHandlers } = await import('./core/bug-report.js');
const { resolveEngineVersion } = await import('./commands/hooks/cli-version.js');
const crash = {
  // Read when needed (cached after the first read), not on every launch.
  get version() {
    return resolveEngineVersion();
  },
  write: (text: string) => void process.stderr.write(text),
  writeJson: undefined as ((error: unknown) => void) | undefined,
  // Exit once stdout and stderr drain: a pipe write can still be queued
  // (Windows, macOS). The code is set first, so an exit elsewhere in the
  // meantime still fails.
  exit: (code: number) => {
    process.exitCode = code;
    process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
  },
};
const reportCrash = installCrashHandlers(process, crash);

// A --json caller reads stdout, so a crash in a --json run also answers there
// with one failure document (#198), unless the run already wrote its document.
// Loaded once the handlers are in place: if it cannot load, the plain-text
// report on stderr still stands.
if (jsonRun) {
  const json = await import('./core/json-output.js').catch(() => undefined);
  if (json) {
    crash.writeJson = (error) => {
      if (!json.jsonEmitted()) json.emitJson(json.jsonFailure(json.jsonCommandOf(process.argv.slice(2)), error));
    };
  }
}

try {
  // `<command> --json` for the commands listed here runs before Pastel loads
  // Ink: a mounted Ink app writes terminal control codes around the document
  // even when it renders nothing (#198), and the JSON must be one clean
  // document (#34). Each runner takes the arguments after the command and
  // returns the exit code. `--help` still goes to Pastel.
  const HEADLESS_JSON: Record<string, () => Promise<(argv: readonly string[], engineVersion: string | undefined) => Promise<number>>> = {
    validate: async () => (await import('./core/validate-shard.js')).runValidateJson,
  };
  const [subcommand, ...subArgs] = process.argv.slice(2);
  const headless = subcommand === undefined ? undefined : HEADLESS_JSON[subcommand];
  if (headless && subArgs.includes('--json') && !subArgs.some((a) => a === '-h' || a === '--help')) {
    const run = await headless();
    process.exitCode = await run(subArgs, crash.version);
    // A pipe write can still be queued (Windows, macOS): exiting before it
    // drains would cut the document short.
    await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
    process.exit();
  }

  const { default: Pastel } = await import('pastel');
  const { enablePositionalOptions, pastelCommander } = await import('./cli-options.js');

  // Windows doesn't deliver parent→child SIGINT via child_process.kill() — Node
  // emulates SIGINT/SIGTERM as TerminateProcess, which skips every registered
  // handler. When the CLI is invoked non-interactively (stdin is a pipe), we
  // listen for the ETX byte (0x03, the ASCII form of Ctrl+C) on stdin and
  // `process.emit('SIGINT')` to trigger `useSigintRollback`. Wrapper scripts
  // and test harnesses get one cross-platform way to cancel cleanly. In a
  // terminal, Ink's prompts hold raw mode, where Ctrl+C is that same byte
  // rather than a signal; the bridge observes it there too (#155).
  installStdinCancellation();

  // Read the version from package.json at runtime so `npm version <bump>` is
  // the single source of truth. Hardcoding here drifted silently between
  // 0.1.0 and 0.1.1 (caught only by the e2e --version test that pins runtime
  // output against `pkg.version`). dist/cli.js sits at `dist/`, so
  // `../package.json` resolves to the package root in both dev and published
  // layouts.
  const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

  // An option written after a subcommand belongs to it, not to the root
  // command; Pastel never enables this on the Commander program it builds
  // (#147). See source/cli-options.ts. If a Pastel or Commander layout ever
  // defeats the patch, run without it (with a warning) rather than refuse
  // every command.
  try {
    enablePositionalOptions(pastelCommander());
  } catch (err) {
    // Options keep Commander's default scoping. Say so on stderr, so a broken
    // layout shows up in a bug report instead of as flags that do nothing.
    process.emitWarning(
      `subcommand option scoping is off (${err instanceof Error ? err.message : String(err)}); see #147`,
      { code: 'SHARDMIND_OPTION_SCOPE' },
    );
  }

  const app = new Pastel({
    importMeta: import.meta,
    name: 'shardmind',
    version: pkg.version,
    description: 'Package manager for Obsidian vault templates',
  });

  await app.run();
} catch (err) {
  reportCrash(err);
}
