/**
 * ConPTY's own framing, stripped exactly and nothing more (#174). The cases
 * are the bytes captured from Windows 11 ConPTY through node-pty 1.1.0.
 */

import { describe, it, expect } from 'vitest';
import {
  stripConptyFraming,
  stripConptyWraps,
  CONPTY_STARTUP,
  CONPTY_FIRST_FRAME,
  conptyTitle,
  conptyWrap,
} from '../e2e/tui/helpers/conpty-framing.js';

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const ESC = '\x1b';

describe('stripConptyFraming', () => {
  it('leaves nothing of a child that wrote nothing', () => {
    expect(stripConptyFraming(`${ESC}[?9001h${ESC}[?1004h`, NODE)).toBe('');
  });

  it('strips the startup, first-frame and title framing around one write', () => {
    const raw = `${ESC}[?9001h${ESC}[?1004h${ESC}[?25l${ESC}[2J${ESC}[m${ESC}[H{\r\n  "a": 1\r\n}\r\n${ESC}]0;${NODE}\x07${ESC}[?25h`;
    expect(stripConptyFraming(raw, NODE)).toBe('{\r\n  "a": 1\r\n}\r\n');
  });

  it('strips the title where ConPTY put it, after its first frame', () => {
    const raw = `${CONPTY_STARTUP}${CONPTY_FIRST_FRAME}line 0\r\n${conptyTitle(NODE)}line 1\r\nline 2\r\n`;
    expect(stripConptyFraming(raw, NODE)).toBe('line 0\r\nline 1\r\nline 2\r\n');
  });

  it('keeps any escape byte that is not on the list, so the test fails on it', () => {
    // Ink's synchronized-output codes: the #198 bug itself.
    const raw = `${CONPTY_STARTUP}${CONPTY_FIRST_FRAME}${ESC}[?2026h{}\r\n${conptyTitle(NODE)}`;
    expect(stripConptyFraming(raw, NODE)).toBe(`${ESC}[?2026h{}\r\n`);
  });

  it('keeps an unknown ConPTY sequence, so a new one shows up as a list change', () => {
    const raw = `${CONPTY_STARTUP}${ESC}[?2004h${CONPTY_FIRST_FRAME}{}\r\n${conptyTitle(NODE)}`;
    expect(stripConptyFraming(raw, NODE)).toContain(`${ESC}[?2004h`);
  });

  it('strips the title only for the child it names', () => {
    const raw = `${CONPTY_STARTUP}${CONPTY_FIRST_FRAME}{}\r\n${conptyTitle('C:\\other.exe')}`;
    expect(stripConptyFraming(raw, NODE)).toContain(`${ESC}]0;C:\\other.exe`);
  });

  it('strips each framing string once, not every occurrence', () => {
    const raw = `${CONPTY_STARTUP}${CONPTY_FIRST_FRAME}a${conptyTitle(NODE)}b${conptyTitle(NODE)}`;
    expect(stripConptyFraming(raw, NODE)).toBe(`ab${conptyTitle(NODE)}`);
  });

  it('returns a stream without the startup sequence unchanged', () => {
    expect(stripConptyFraming('{}\n', NODE)).toBe('{}\n');
  });
});

describe('stripConptyWraps', () => {
  // Captured at 80x24: a hash broken where the line overflowed. ConPTY moves
  // to the last column of the row above and prints that column's character
  // again before going on, so the character before the break repeats.
  it('rejoins a line ConPTY broke at the terminal width, dropping the repeated character', () => {
    const wrapped = `"shardHash": "3caead8f…ccfcc\r\n${conptyWrap(24, 80)}c61f9ca",\r\n`;
    expect(stripConptyWraps(wrapped, 24, 80)).toBe('"shardHash": "3caead8f…ccfcc61f9ca",\r\n');
  });

  it('leaves a wrap whose next character does not repeat the one before it', () => {
    const odd = `ab\r\n${conptyWrap(24, 80)}cd`;
    expect(stripConptyWraps(odd, 24, 80)).toBe(odd);
  });

  it('removes only the wrap for this terminal size', () => {
    const other = `a\r\n${conptyWrap(50, 120)}b`;
    expect(stripConptyWraps(other, 24, 80)).toBe(other);
  });

  it('keeps a cursor move that is not a wrap', () => {
    const move = `a${ESC}[23;80Hb`;
    expect(stripConptyWraps(move, 24, 80)).toBe(move);
  });
});
