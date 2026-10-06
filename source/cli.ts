import { createRequire } from 'node:module';
import { installStdinCancellation } from './core/cancellation.js';
import { applyNoColor } from './core/color-env.js';
import { jsonRunOf } from './core/json-run.js';
import type { JsonCommand } from './core/json-output.js';
import { exitQuietlyWhenStdoutCloses } from './core/stdout-closed.js';

// NO_COLOR turns colour off unless FORCE_COLOR is set (#37). chalk, which Ink
// colours through, reads the environment once when it is first imported, so
// this runs before the cli-kit loads Ink: the cli-kit is imported
// dynamically below, never statically above this line.
applyNoColor(process.env);

// A reader that closes stdout early (`shardmind --json | head -1`) ends the run
// quietly with 141 once it has finished, not with a bug report (#252).
// Installed before anything can write.
exitQuietlyWhenStdoutCloses(process);

// A --json run never loads Ink: its command answers headless below, so it
// writes in a terminal exactly what it writes piped (#198, #302).
const jsonArgs = jsonRunOf(process.argv.slice(2));

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
if (jsonArgs) {
  const { command } = jsonArgs;
  const json = await import('./core/json-output.js').catch(() => undefined);
  if (json) {
    crash.writeJson = (error) => {
      if (!json.jsonEmitted()) json.emitJson(json.jsonFailure(command, error));
    };
  }
}

try {
  // Windows doesn't deliver parent→child SIGINT via child_process.kill() — Node
  // emulates SIGINT/SIGTERM as TerminateProcess, which skips every registered
  // handler. When the CLI is invoked non-interactively (stdin is a pipe), we
  // listen for the ETX byte (0x03, the ASCII form of Ctrl+C) on stdin and
  // `process.emit('SIGINT')` to trigger `useSigintRollback`, or a headless
  // `--json` run's own handler, which removes its download (#57, #302). Wrapper scripts
  // and test harnesses get one cross-platform way to cancel cleanly. In a
  // terminal, Ink's prompts hold raw mode, where Ctrl+C is that same byte
  // rather than a signal; the bridge observes it there too (#155).
  installStdinCancellation();

  // `<command> --json` for the commands listed here runs before Pastel loads
  // Ink: a mounted Ink app writes terminal control codes around the document
  // even when it renders nothing (#198), and the JSON must be one clean
  // document (#34). Each runner takes the arguments without the subcommand
  // (a root option before it is passed on, #147) and returns the exit code.
  // `--help` and `--version` still go to Pastel.
  // The status command (the root, no subcommand), adopt and update run headless too (#302).
  const HEADLESS_JSON: Record<JsonCommand, () => Promise<(argv: readonly string[], engineVersion: string | undefined) => Promise<number>>> = {
    validate: async () => (await import('./core/validate-shard.js')).runValidateJson,
    status: async () => (await import('./commands/headless/status.js')).runStatusJson,
    adopt: async () => (await import('./commands/headless/adopt.js')).runAdoptJson,
    update: async () => (await import('./commands/headless/update.js')).runUpdateJson,
  };
  if (jsonArgs) {
    if (jsonArgs.misplaced !== undefined) {
      // Pastel refuses an option of the subcommand written before it; a
      // --json caller gets that refusal as a document.
      const [{ emitJson, jsonFailure }, { ShardMindError }] = await Promise.all([
        import('./core/json-output.js'),
        import('./runtime/types.js'),
      ]);
      emitJson(
        jsonFailure(
          jsonArgs.command,
          new ShardMindError(
            `error: unknown option '${jsonArgs.misplaced}'`,
            'ARGS_INVALID',
            `Before a command, shardmind takes only --verbose, --json and --no-update-check. Write a command's own options after it, or run \`shardmind ${jsonArgs.command} --help\` for the ones it takes.`,
          ),
        ),
      );
      process.exitCode = 1;
    } else {
      const run = await HEADLESS_JSON[jsonArgs.command]();
      process.exitCode = await run(jsonArgs.rest, crash.version);
    }
    // A pipe write can still be queued (Windows, macOS): exiting before it
    // drains would cut the document short.
    await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
    process.exit();
  }

  const { default: Pastel } = await import('./cli-kit/index.js');

  // Read the version from package.json at runtime so `npm version <bump>` is
  // the single source of truth. Hardcoding here drifted silently between
  // 0.1.0 and 0.1.1 (caught only by the e2e --version test that pins runtime
  // output against `pkg.version`). dist/cli.js sits at `dist/`, so
  // `../package.json` resolves to the package root in both dev and published
  // layouts.
  const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

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
