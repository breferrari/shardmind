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

const app = new Pastel({
  importMeta: import.meta,
  name: 'shardmind',
  version: '0.1.0',
  description: 'Package manager for Obsidian vault templates',
});

await app.run();
