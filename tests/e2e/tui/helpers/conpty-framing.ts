/**
 * The bytes Windows ConPTY adds around a child's output, as a fixed
 * allow-list (#174). A POSIX PTY passes a child's bytes through; ConPTY
 * renders them and re-emits them inside its own framing. A byte-identity test
 * strips exactly this framing, at the places ConPTY puts it, and nothing
 * else: any other escape byte stays and fails the test, including a ConPTY
 * sequence missing from this list, so a new one shows up as a change here,
 * never as a silent pass.
 *
 * Source: captured on Windows 11 through node-pty 1.1.0's ConPTY backend,
 * for children that write nothing, one word, one JSON document and 30
 * lines. Documented in ARCHITECTURE §19.7.
 */

/** First, always: win32-input-mode on (?9001h), focus reporting on (?1004h). */
export const CONPTY_STARTUP = '\x1b[?9001h\x1b[?1004h';

/** Before the child's first output: hide the cursor, clear, reset colours, home. */
export const CONPTY_FIRST_FRAME = '\x1b[?25l\x1b[2J\x1b[m\x1b[H';

/**
 * Once, after the first frame it paints: the window title set to the child's
 * executable, then the cursor shown again. With a single write this is at
 * the end; with output spread over frames it follows the first frame.
 */
export function conptyTitle(childPath: string): string {
  return `\x1b]0;${childPath}\x07\x1b[?25h`;
}

/**
 * What ConPTY puts where a line longer than the terminal breaks, once the
 * output has scrolled: a line break, then a move to the last column of the
 * row above the bottom, after which it prints that column's character again.
 * Exact for one terminal size, so a cursor move that is not this wrap still
 * fails a test.
 */
export function conptyWrap(rows: number, cols: number): string {
  return `\x1b[${rows - 1};${cols}H`;
}

/**
 * `text` with each of ConPTY's line wraps for a `rows`x`cols` terminal undone:
 * the break, the move and the repeated character go. A wrap whose next
 * character does not repeat the one before the break is left as it is.
 */
export function stripConptyWraps(text: string, rows: number, cols: number): string {
  const marker = `\r\n${conptyWrap(rows, cols)}`;
  let out = '';
  let from = 0;
  for (let at = text.indexOf(marker); at !== -1; at = text.indexOf(marker, from)) {
    const before = text[at - 1];
    const after = text[at + marker.length];
    if (before !== undefined && before === after) {
      out += text.slice(from, at);
      from = at + marker.length + 1;
    } else {
      out += text.slice(from, at + marker.length);
      from = at + marker.length;
    }
  }
  return out + text.slice(from);
}

/**
 * `raw` without ConPTY's framing. A stream that does not start with the
 * startup sequence is returned as it is (it was not framed by ConPTY).
 */
export function stripConptyFraming(raw: string, childPath: string): string {
  if (!raw.startsWith(CONPTY_STARTUP)) return raw;
  let rest = raw.slice(CONPTY_STARTUP.length);
  if (rest.startsWith(CONPTY_FIRST_FRAME)) rest = rest.slice(CONPTY_FIRST_FRAME.length);
  const title = conptyTitle(childPath);
  const at = rest.indexOf(title);
  if (at !== -1) rest = rest.slice(0, at) + rest.slice(at + title.length);
  return rest;
}
