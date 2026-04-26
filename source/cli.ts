import { createRequire } from 'node:module';
import Pastel from 'pastel';
import { installStdinCancellation } from './core/cancellation.js';

// Windows doesn't deliver parent→child SIGINT via child_process.kill() — Node
// emulates SIGINT/SIGTERM as TerminateProcess, which skips every registered
// handler. When the CLI is invoked non-interactively (stdin is a pipe), we
// listen for the ETX byte (0x03, the ASCII form of Ctrl+C) on stdin and
// `process.emit('SIGINT')` to trigger `useSigintRollback`. Wrapper scripts
// and test harnesses get one cross-platform way to cancel cleanly; TTY
// users keep the native Ctrl+C handling on both platforms.
installStdinCancellation();

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
