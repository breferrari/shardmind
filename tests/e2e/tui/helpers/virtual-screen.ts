/**
 * In-memory terminal emulator backing every Layer 2 PTY scenario.
 *
 * `@xterm/headless` consumes the raw byte stream a PTY child emits —
 * including ANSI cursor moves, color escapes, alt-screen switches —
 * and maintains the visible 80x24 cell grid. Tests then ask the screen
 * for either a specific line or a serialized whole-grid snapshot, both
 * of which read like what a human would see on their actual terminal.
 *
 * Why we need this rather than buffer-of-bytes scanning:
 *   - Ink moves the cursor and rewrites cells. A naive concat of every
 *     `pty.onData` chunk includes overdrawn frames, so a `screenContains`
 *     test would match transient text that's no longer on screen.
 *   - ANSI escape sequences (`\x1b[2J`, `\x1b[?25l`, etc.) are noise
 *     against a string-match assertion. The xterm parser folds them.
 *   - Alt-screen switches (DECSET 1049) are how Ink renders fullscreen
 *     UIs; the headless terminal handles the buffer flip natively, so
 *     scrollback and live UI don't bleed into each other in assertions.
 *
 * Spec citation: #111 Phase 2 Layer 2 helpers — see issue body
 * "Layer 2 — Real-PTY E2E (true terminal)".
 */

import { Terminal } from '@xterm/headless';

export interface VirtualScreenOptions {
  /** Default 80 — matches the issue body's chosen surface. */
  cols?: number;
  /** Default 24 — same. */
  rows?: number;
}

export interface VirtualScreen {
  /**
   * Feed raw bytes (or a UTF-8 string) the PTY emitted into the
   * terminal. xterm-headless processes writes on the next event-loop
   * tick — the returned Promise resolves once the bytes are reflected
   * in the buffer. PTY-driven scenarios rarely need to await it
   * (`waitForScreen` polls on a 50ms cadence), but synchronous-feeling
   * unit tests must.
   */
  feed: (chunk: string | Uint8Array) => Promise<void>;
  /**
   * Render the visible viewport as a newline-separated string with
   * trailing whitespace trimmed per row. The active buffer is what's
   * on screen right now — alt-screen flips are folded for us.
   */
  serialize: () => string;
  /**
   * Substring match against the serialized viewport. Folded as a
   * convenience so per-test predicates stay terse.
   */
  contains: (text: string) => boolean;
  /**
   * Substring match against the serialized viewport using a regex.
   * Useful for `(N of M)` counters and other patterned content.
   */
  matches: (re: RegExp) => boolean;
  /** Drop the terminal so its event listeners stop holding references. */
  dispose: () => void;
}

export function createVirtualScreen(opts: VirtualScreenOptions = {}): VirtualScreen {
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;
  // `allowProposedApi: true` is required for `Terminal.serialize()` —
  // marked proposed in 6.0.0 even though it's stable in practice. We
  // implement our own serialization below to avoid the dependency,
  // which keeps the API surface narrow if a future xterm release
  // gates more of the buffer behind the proposed flag.
  const term = new Terminal({ cols, rows, allowProposedApi: true });

  const feed = (chunk: string | Uint8Array): Promise<void> =>
    new Promise((resolve) => {
      // xterm.write() is fire-and-forget by default; the callback
      // form fires once the data is processed and reflected in the
      // buffer. node-pty hands us strings (utf-8 encoded by default);
      // keep the signature flexible in case a future caller switches
      // to a Buffer.
      term.write(chunk, () => resolve());
    });

  const serialize = (): string => {
    const buf = term.buffer.active;
    // Walk the visible viewport, not the full scrollback. `viewportY`
    // marks the topmost on-screen row; `rows` lines after that are
    // exactly what a user with this geometry would see right now.
    // Trailing whitespace per row goes — assertions key off content,
    // not padding.
    const lines: string[] = [];
    for (let y = 0; y < rows; y++) {
      const line = buf.getLine(buf.viewportY + y);
      if (!line) {
        lines.push('');
        continue;
      }
      lines.push(line.translateToString(true));
    }
    // Trim trailing empty lines so the snapshot is just the meaningful
    // content. A blank-line-padded grid breaks `contains` assertions on
    // tests that look for a specific bottom-of-screen string.
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  };

  const contains = (text: string): boolean => serialize().includes(text);
  const matches = (re: RegExp): boolean => re.test(serialize());

  const dispose = (): void => {
    // xterm-headless cleans up on dispose; calling twice is harmless.
    term.dispose();
  };

  return { feed, serialize, contains, matches, dispose };
}
