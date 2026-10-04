/**
 * Ctrl+C on stdin → SIGINT, in a pipe and in a raw-mode TTY (#155).
 *
 * In raw mode the terminal sends Ctrl+C as the byte 0x03, not a signal, and
 * Ink reads stdin through a `readable` listener only while raw mode is on.
 * The bridge observes the bytes Ink reads through a passive `data` listener
 * that exists only while raw mode is on, so Ink still gets every byte and
 * the stream never switches to flowing mode on its own.
 */

import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { attachStdinCancellation } from '../../source/core/cancellation.js';

const ETX = '\x03';

type FakeStdin = Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };

function fakeStdin(isTTY: boolean): FakeStdin {
  const stream = new Readable({ read() {} }) as FakeStdin;
  stream.isTTY = isTTY;
  if (isTTY) stream.setRawMode = () => stream;
  return stream;
}

/**
 * Ink's raw-mode reader, in App.js's order: setRawMode(true), then add the
 * `readable` listener that drains `read()`; on stop, remove it, then
 * setRawMode(false).
 */
function inkReader(stdin: FakeStdin, received: string[]): () => void {
  const onReadable = () => {
    let chunk: Buffer | null;
    while ((chunk = stdin.read() as Buffer | null) !== null) received.push(chunk.toString());
  };
  stdin.setRawMode!(true);
  stdin.addListener('readable', onReadable);
  return () => {
    stdin.removeListener('readable', onReadable);
    stdin.setRawMode!(false);
  };
}

const tick = () => new Promise((r) => setImmediate(r));

function deps(hasSigintListener: boolean) {
  return {
    emitSigint: vi.fn(() => hasSigintListener),
    exit: vi.fn(),
  };
}

describe('attachStdinCancellation — TTY (raw mode, #155)', () => {
  it('attaches nothing until Ink starts reading', () => {
    const stdin = fakeStdin(true);
    attachStdinCancellation(stdin, deps(true));
    expect(stdin.listenerCount('data')).toBe(0);
    expect(stdin.readableFlowing).toBeNull();
  });

  it('turns a Ctrl+C byte Ink reads into SIGINT, and Ink still gets every byte', async () => {
    const stdin = fakeStdin(true);
    const d = deps(true);
    attachStdinCancellation(stdin, d);
    const received: string[] = [];
    inkReader(stdin, received);

    stdin.push('a');
    await tick();
    expect(d.emitSigint).not.toHaveBeenCalled();

    stdin.push(`b${ETX}c`);
    await tick();
    expect(d.emitSigint).toHaveBeenCalledTimes(1);
    expect(d.exit).not.toHaveBeenCalled();
    expect(received.join('')).toBe(`ab${ETX}c`);
  });

  it('exits 130 itself when no SIGINT handler is registered', async () => {
    const stdin = fakeStdin(true);
    const d = deps(false);
    attachStdinCancellation(stdin, d);
    inkReader(stdin, []);
    stdin.push(ETX);
    await tick();
    expect(d.exit).toHaveBeenCalledWith(130);
  });

  it('detaches when Ink stops reading, leaving the stream paused', async () => {
    const stdin = fakeStdin(true);
    const d = deps(true);
    attachStdinCancellation(stdin, d);
    const stop = inkReader(stdin, []);
    expect(stdin.listenerCount('data')).toBe(1);

    stop();
    await tick();
    expect(stdin.listenerCount('data')).toBe(0);
    // Not flowing: a flowing TTY stdin would keep the process alive after
    // Ink unmounts.
    expect(stdin.readableFlowing).not.toBe(true);

    // A later remount (the next interactive phase) observes again.
    inkReader(stdin, []);
    stdin.push(ETX);
    await tick();
    expect(d.emitSigint).toHaveBeenCalledTimes(1);
  });

  it('observes once when raw mode is switched on twice', () => {
    const stdin = fakeStdin(true);
    attachStdinCancellation(stdin, deps(true));
    stdin.setRawMode!(true);
    stdin.setRawMode!(true);
    expect(stdin.listenerCount('data')).toBe(1);
  });

  it('keeps bytes typed between prompts for the next reader', async () => {
    const stdin = fakeStdin(true);
    attachStdinCancellation(stdin, deps(true));
    inkReader(stdin, [])();
    await tick();
    // Typed while no prompt is mounted: must wait in the buffer.
    stdin.push('typeahead');
    await tick();
    const received: string[] = [];
    inkReader(stdin, received);
    await tick();
    expect(received.join('')).toBe('typeahead');
  });
});

describe('attachStdinCancellation — pipe (unchanged)', () => {
  it('reads the pipe directly and turns Ctrl+C into SIGINT', async () => {
    const stdin = fakeStdin(false);
    const d = deps(true);
    attachStdinCancellation(stdin, d);
    expect(stdin.listenerCount('data')).toBe(1);
    stdin.push(`x${ETX}`);
    await tick();
    expect(d.emitSigint).toHaveBeenCalledTimes(1);
  });

  it('exits 130 when no SIGINT handler is registered', async () => {
    const stdin = fakeStdin(false);
    const d = deps(false);
    attachStdinCancellation(stdin, d);
    stdin.push(ETX);
    await tick();
    expect(d.exit).toHaveBeenCalledWith(130);
  });
});
