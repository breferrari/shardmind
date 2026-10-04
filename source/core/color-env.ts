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
const CAN = 0x18;
const SUB = 0x1a;
const BACKSLASH = 0x5c;
const CSI_8BIT = 0x9b;
const OSC_8BIT = 0x9d;
const ST_8BIT = 0x9c;
// DCS, SOS, PM, APC: string sequences ended by ST.
const STRING_INTRODUCERS = new Set([0x50, 0x58, 0x5e, 0x5f]); // P X ^ _
const STRING_INTRODUCERS_8BIT = new Set([0x90, 0x98, 0x9e, 0x9f]);
const SGR_PARAMETERS = /^[0-9;:]*$/;
const TAB_STOP = 8;
// Anything sanitizeHookLine would change: C0 controls but LF, DEL, C1.
const NEEDS_SANITIZING = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;
// For a path, LF needs escaping too.
const PATH_NEEDS_SANITIZING = /[\x00-\x1f\x7f-\x9f]/;

const inRange = (c: number, lo: number, hi: number): boolean => c >= lo && c <= hi;

const COMBINING = /\p{Mn}|\p{Me}/u;
// East Asian wide and fullwidth blocks, and the emoji planes, for tab stops.
// An approximation of string-width, which is not a dependency.
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
  [0x20000, 0x3fffd],
];

/** Terminal columns a code point takes: 0 for a combining mark, 2 for wide, else 1. */
function columns(codePoint: number): number {
  if (COMBINING.test(String.fromCodePoint(codePoint))) return 0;
  return WIDE.some(([lo, hi]) => inRange(codePoint, lo, hi)) ? 2 : 1;
}

/**
 * Hook output as text (#204): keeps printable text, newlines and, when
 * `keepSgr`, colour (SGR). Removes every other terminal control sequence and
 * control character, and expands tabs. A lone CR rewrites its line, as a
 * terminal shows a progress bar. Lines are handled one at a time, so no
 * sequence, finished or not, can reach past the end of its line.
 */
export function sanitizeHookText(text: string, keepSgr: boolean): string {
  if (!NEEDS_SANITIZING.test(text)) return text;
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => sanitizeHookLine(line, keepSgr))
    .join('\n');
}

/**
 * One line of hook output (no LF). Of its CR-separated segments, the last one
 * with visible text is shown, and a line with none is empty. With `keepSgr`,
 * the SGR before it is kept in front (a terminal keeps its pen state across a
 * CR), from the last full reset on, and the SGR after it behind, so a
 * trailing reset still closes the style.
 */
export function sanitizeHookLine(line: string, keepSgr: boolean): string {
  if (!NEEDS_SANITIZING.test(line)) return line;
  const segments = line.split('\r').map((segment) => scan(segment, keepSgr));
  const shown = segments.findLastIndex((segment) => segment.visible > 0);
  if (shown === -1) return '';
  if (!keepSgr) return segments[shown]!.text;
  const sgrOf = (from: number, to: number): string =>
    segments
      .slice(from, to)
      .map((segment) => segment.sgr)
      .join('');
  return sinceLastReset(sgrOf(0, shown)) + segments[shown]!.text + sgrOf(shown + 1, segments.length);
}

const FULL_RESETS = ['\x1b[0m', '\x1b[m'];

/** The SGR that still applies after `sgr`: whatever follows its last full reset. */
function sinceLastReset(sgr: string): string {
  const cut = Math.max(...FULL_RESETS.map((reset) => {
    const at = sgr.lastIndexOf(reset);
    return at === -1 ? 0 : at + reset.length;
  }));
  return sgr.slice(cut);
}

/**
 * A file name the hook created, as text (#204). No line rules: CR, LF and tab
 * show as `\r`, `\n` and `\t`, so a name can neither hide part of itself nor
 * forge a line. Control sequences, other controls and colour are removed.
 */
export function sanitizeHookPath(path: string): string {
  if (!PATH_NEEDS_SANITIZING.test(path)) return path;
  const escaped = path.replaceAll('\r', '\\r').replaceAll('\n', '\\n').replaceAll('\t', '\\t');
  return scan(escaped, false).text;
}

interface Scanned {
  /** The segment as shown: text, expanded tabs, and SGR when kept. */
  text: string;
  /** Only the SGR sequences, 7-bit, for carrying across a CR. */
  sgr: string;
  /** Columns of visible text. */
  visible: number;
}

function scan(s: string, keepSgr: boolean): Scanned {
  let text = '';
  let sgr = '';
  let visible = 0;
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    let step: Step;
    if (c === ESC) step = escape(s, i);
    else if (c === CSI_8BIT) step = csi(s, i + 1);
    else if (c === OSC_8BIT) step = stringSequence(s, i + 1, true);
    else if (STRING_INTRODUCERS_8BIT.has(c)) step = stringSequence(s, i + 1, false);
    else if (c === TAB) {
      const spaces = TAB_STOP - (visible % TAB_STOP);
      text += ' '.repeat(spaces);
      visible += spaces;
      i += 1;
      continue;
    } else if (c < 0x20 || c === 0x7f || inRange(c, 0x80, 0x9f)) step = { next: i + 1 }; // C0, DEL, C1
    else {
      const codePoint = s.codePointAt(i)!;
      const units = codePoint > 0xffff ? 2 : 1;
      text += s.slice(i, i + units);
      visible += columns(codePoint);
      i += units;
      continue;
    }
    if (step.sgr !== undefined) {
      sgr += step.sgr;
      if (keepSgr) text += step.sgr;
    }
    i = step.next;
  }
  return { text, sgr, visible };
}

/** Where scanning resumes, and the sequence as 7-bit SGR when it was one. */
interface Step {
  next: number;
  sgr?: string;
}

/** A sequence starting with ESC at `start`. */
function escape(s: string, start: number): Step {
  const next = s.charCodeAt(start + 1);
  if (Number.isNaN(next)) return { next: start + 1 }; // a lone ESC at the end
  if (next === 0x5b) return csi(s, start + 2); // ESC [
  if (next === 0x5d) return stringSequence(s, start + 2, true); // ESC ]
  if (STRING_INTRODUCERS.has(next)) return stringSequence(s, start + 2, false);
  if (inRange(next, 0x20, 0x2f)) {
    // nF escape: intermediates, then a final byte. Unfinished: drop what is there.
    let j = start + 1;
    while (j < s.length && inRange(s.charCodeAt(j), 0x20, 0x2f)) j += 1;
    return { next: j < s.length && inRange(s.charCodeAt(j), 0x30, 0x7e) ? j + 1 : j };
  }
  if (inRange(next, 0x30, 0x7e)) return { next: start + 2 }; // two-byte escape: ESC 7, ESC c, …
  return { next: start + 1 }; // a lone ESC before something that cannot follow it
}

/**
 * CSI with parameters at `body` (after `ESC [` or U+009B). An SGR is returned
 * in its 7-bit form. An unfinished CSI drops its introducer, parameters and
 * intermediates.
 */
function csi(s: string, body: number): Step {
  let j = body;
  while (j < s.length && inRange(s.charCodeAt(j), 0x30, 0x3f)) j += 1;
  const parameters = s.slice(body, j);
  const intermediatesStart = j;
  while (j < s.length && inRange(s.charCodeAt(j), 0x20, 0x2f)) j += 1;
  if (j >= s.length || !inRange(s.charCodeAt(j), 0x40, 0x7e)) return { next: j };
  const isSgr = s[j] === 'm' && j === intermediatesStart && SGR_PARAMETERS.test(parameters);
  return isSgr ? { next: j + 1, sgr: `\x1b[${parameters}m` } : { next: j + 1 };
}

/**
 * OSC (`allowBel`) or DCS / SOS / PM / APC, payload at `body`, ended by ST
 * (`ESC \` or U+009C), or BEL for OSC: removed whole. Aborted, as a terminal
 * aborts it, by an ESC that does not start ST (scanning resumes at that ESC)
 * or by CAN / SUB (removed too). With neither before the end of the line,
 * only the introducer goes, so the payload stays as inert text.
 */
function stringSequence(s: string, body: number, allowBel: boolean): Step {
  for (let k = body; k < s.length; k += 1) {
    const c = s.charCodeAt(k);
    if (c === ST_8BIT || (allowBel && c === BEL)) return { next: k + 1 };
    if (c === ESC) return { next: s.charCodeAt(k + 1) === BACKSLASH ? k + 2 : k };
    if (c === CAN || c === SUB) return { next: k + 1 };
  }
  return { next: body };
}
