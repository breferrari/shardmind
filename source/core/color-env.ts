/**
 * Honours NO_COLOR (#37), and keeps hook output to text (#204).
 * Spec: docs/IMPLEMENTATION.md §4.21.
 *
 * Ink colours every `<Text color>` and `dimColor` through chalk, and chalk 5
 * reads FORCE_COLOR but ignores NO_COLOR. chalk resolves its level once, when
 * it is first imported, so this must run on `process.env` before anything
 * loads Ink: `source/cli.ts` calls it first and imports Pastel afterwards.
 */
export function applyNoColor(env: NodeJS.ProcessEnv): void {
  // chalk turns a negative FORCE_COLOR into a negative level and throws at
  // import on Linux and macOS, so treat it as off.
  const force = env['FORCE_COLOR'];
  if (force !== undefined && Number.parseInt(force, 10) < 0) env['FORCE_COLOR'] = '0';
  // FORCE_COLOR is the explicit opt-in, so it wins whenever it is set, even
  // to an empty string, which chalk reads as level 1.
  if (env['FORCE_COLOR'] !== undefined) return;
  // no-color.org: any non-empty value disables colour; an empty one does not.
  if (env['NO_COLOR'] === undefined || env['NO_COLOR'] === '') return;
  env['FORCE_COLOR'] = '0';
}

const ESC = 0x1b;
const BEL = 0x07;
const TAB = 0x09;
const LF = 0x0a;
const BACKSLASH = 0x5c;
const CSI_8BIT = 0x9b;
const OSC_8BIT = 0x9d;
const ST_8BIT = 0x9c;
// DCS, SOS, PM, APC: string sequences ended by ST.
const STRING_INTRODUCERS = new Set([0x50, 0x58, 0x5e, 0x5f]); // P X ^ _
const STRING_INTRODUCERS_8BIT = new Set([0x90, 0x98, 0x9e, 0x9f]);
const SGR_PARAMETERS = /^[0-9;:]*$/;

const inRange = (c: number, lo: number, hi: number): boolean => c >= lo && c <= hi;

/**
 * Hook output as text (#204): keeps printable text, tabs, newlines and, when
 * `keepSgr`, colour (SGR). Removes every other terminal control sequence and
 * control character. A lone CR rewrites its line, as a terminal shows a
 * progress bar. Lines are handled one at a time, so no sequence, finished or
 * not, can reach past the end of its line.
 */
export function sanitizeHookText(text: string, keepSgr: boolean): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => sanitizeLine(line.slice(line.lastIndexOf('\r') + 1), keepSgr))
    .join('\n');
}

function sanitizeLine(s: string, keepSgr: boolean): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === ESC) {
      i = escape(s, i, keepSgr, (kept) => (out += kept));
    } else if (c === CSI_8BIT) {
      i = csi(s, i, i + 1, keepSgr, (kept) => (out += kept));
    } else if (c === OSC_8BIT) {
      i = stringSequence(s, i + 1, true);
    } else if (STRING_INTRODUCERS_8BIT.has(c)) {
      i = stringSequence(s, i + 1, false);
    } else if ((c < 0x20 && c !== TAB && c !== LF) || c === 0x7f || inRange(c, 0x80, 0x9f)) {
      i += 1; // C0 (except tab and newline), DEL, C1
    } else {
      out += s[i];
      i += 1;
    }
  }
  return out;
}

/** Handles a sequence starting with ESC at `start`; returns where scanning resumes. */
function escape(s: string, start: number, keepSgr: boolean, keep: (text: string) => void): number {
  const next = s.charCodeAt(start + 1);
  if (Number.isNaN(next)) return start + 1; // a lone ESC at the end
  if (next === 0x5b) return csi(s, start, start + 2, keepSgr, keep); // ESC [
  if (next === 0x5d) return stringSequence(s, start + 2, true); // ESC ]
  if (STRING_INTRODUCERS.has(next)) return stringSequence(s, start + 2, false);
  if (inRange(next, 0x20, 0x2f)) {
    // nF escape: intermediates, then a final byte. Unfinished: drop what is there.
    let j = start + 1;
    while (j < s.length && inRange(s.charCodeAt(j), 0x20, 0x2f)) j += 1;
    return j < s.length && inRange(s.charCodeAt(j), 0x30, 0x7e) ? j + 1 : j;
  }
  if (inRange(next, 0x30, 0x7e)) return start + 2; // two-byte escape: ESC 7, ESC c, …
  return start + 1; // a lone ESC before something that cannot follow it
}

/**
 * CSI from `start` (its introducer), parameters at `body`. Kept only when it
 * is SGR and `keepSgr`. An unfinished CSI drops its introducer and parameters.
 */
function csi(s: string, start: number, body: number, keepSgr: boolean, keep: (text: string) => void): number {
  let j = body;
  while (j < s.length && inRange(s.charCodeAt(j), 0x30, 0x3f)) j += 1;
  const parameters = s.slice(body, j);
  const intermediatesStart = j;
  while (j < s.length && inRange(s.charCodeAt(j), 0x20, 0x2f)) j += 1;
  if (j >= s.length || !inRange(s.charCodeAt(j), 0x40, 0x7e)) return j;
  const isSgr = s[j] === 'm' && j === intermediatesStart && SGR_PARAMETERS.test(parameters);
  if (isSgr && keepSgr) keep(s.slice(start, j + 1));
  return j + 1;
}

/**
 * OSC (`allowBel`) or DCS / SOS / PM / APC, payload at `body`, ended by ST
 * (`ESC \` or U+009C), or BEL for OSC. Removed whole when terminated. With no
 * terminator only the introducer goes, so the payload stays as inert text.
 */
function stringSequence(s: string, body: number, allowBel: boolean): number {
  for (let k = body; k < s.length; k += 1) {
    const c = s.charCodeAt(k);
    if (c === ST_8BIT || (allowBel && c === BEL)) return k + 1;
    if (c === ESC && s.charCodeAt(k + 1) === BACKSLASH) return k + 2;
  }
  return body;
}
