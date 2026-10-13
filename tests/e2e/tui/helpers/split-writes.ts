/**
 * A `node --import` preload for `spawnCliPty({ splitWrites: true })` (#394):
 * each stdout write that spans lines reaches the terminal in two pieces, up to
 * its first newline and then the rest, with a pause between. A Linux PTY can
 * hand one write to its reader a line block at a time; this makes that
 * delivery happen on every run and every OS, so a test that reads a line its
 * `waitForScreen` predicate did not check fails here, not once in a while on
 * CI.
 *
 * The 150 ms pause is several times `waitForScreen`'s default poll, so a
 * poll sees the first piece alone. It blocks the thread (`Atomics.wait`), so the order of
 * writes is kept and nothing is lost when the CLI exits right after.
 */
export const SPLIT_WRITES_IMPORT =
  'data:text/javascript,' +
  encodeURIComponent(
    'const pause = new Int32Array(new SharedArrayBuffer(4));' +
      'const write = process.stdout.write.bind(process.stdout);' +
      'process.stdout.write = (chunk, encoding, callback) => {' +
      "  const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();" +
      "  const cut = text.indexOf('\\n');" +
      '  if (cut < 0 || cut === text.length - 1) return write(chunk, encoding, callback);' +
      '  write(text.slice(0, cut + 1));' +
      '  Atomics.wait(pause, 0, 0, 150);' +
      '  return write(text.slice(cut + 1), encoding, callback);' +
      '};',
  );
