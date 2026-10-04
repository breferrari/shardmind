/**
 * A `node --import` preload that makes a child process believe stdout is a
 * terminal, before anything in it loads. chalk detects a TTY with
 * `tty.isatty(1)` and Ink reads `process.stdout.isTTY`, so both are patched.
 * Lets colour scenarios run on all three OSes; Layer 2 PTY tests skip Windows.
 */
export const FAKE_TTY_IMPORT =
  'data:text/javascript,' +
  encodeURIComponent(
    "import tty from 'node:tty';" +
      'const isatty = tty.isatty;' +
      'tty.isatty = (fd) => fd === 1 || isatty(fd);' +
      'process.stdout.isTTY = true;',
  );
