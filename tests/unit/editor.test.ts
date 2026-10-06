/**
 * core/editor.ts (#50): open a conflict in the user's editor. A node script
 * stands in for the editor; its mode is its first argument, and the file is
 * the last, as the real call passes it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  editInEditor,
  hasConflictMarkers,
  resolveEditorCommand,
  withTerminalReleased,
} from '../../source/core/editor.js';
import { withSigintHeld } from '../../source/core/process-control.js';

let dir: string;
let fake: string;

beforeEach(async () => {
  dir = path.join(os.tmpdir(), `shardmind-editor-test-${crypto.randomUUID()}`);
  await fsp.mkdir(dir, { recursive: true });
  fake = path.join(dir, 'fake-editor.cjs');
  await fsp.writeFile(
    fake,
    [
      "const fs = require('node:fs');",
      'const mode = process.argv[2];',
      'const file = process.argv[process.argv.length - 1];',
      "if (mode === 'fail') process.exit(3);",
      "if (mode === 'resolve') fs.writeFileSync(file, 'resolved by hand\\n');",
      "if (mode === 'record') fs.writeFileSync(process.argv[3], file);",
      "if (mode === 'delete') fs.rmSync(file);",
      '',
    ].join('\n'),
  );
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

const editor = (mode: string) => `node "${fake}" ${mode}`;
const leftovers = async () => (await fsp.readdir(dir)).filter((n) => n.startsWith('shardmind-edit-'));

describe('resolveEditorCommand (#50)', () => {
  it('takes $VISUAL, then $EDITOR', () => {
    expect(resolveEditorCommand({ VISUAL: 'code --wait', EDITOR: 'vi' })).toBe('code --wait');
    expect(resolveEditorCommand({ EDITOR: 'nano' })).toBe('nano');
    expect(resolveEditorCommand({ VISUAL: '  ', EDITOR: 'nano' })).toBe('nano');
  });

  it('guesses nothing when neither is set', () => {
    expect(resolveEditorCommand({})).toBeUndefined();
    expect(resolveEditorCommand({ VISUAL: '', EDITOR: ' ' })).toBeUndefined();
  });
});

describe('editInEditor (#50)', () => {
  const CONFLICT = 'a\n<<<<<<< yours\nmine\n=======\ntheirs\n>>>>>>> shard update\nb\n';

  it('returns what the editor saved, and removes its temp copy', () => {
    const outcome = editInEditor(CONFLICT, 'Note.md', { command: editor('resolve'), dir });
    expect(outcome).toEqual({ kind: 'saved', content: 'resolved by hand\n' });
    return leftovers().then((l) => expect(l).toEqual([]));
  });

  it('hands the editor a file named like the vault file, under the given dir', async () => {
    const out = path.join(dir, 'seen.txt');
    editInEditor(CONFLICT, 'My Note.md', { command: `${editor('record')} "${out}"`, dir });
    const seen = await fsp.readFile(out, 'utf-8');
    expect(path.basename(seen)).toBe('My Note.md');
    expect(path.dirname(path.dirname(seen))).toBe(dir);
    expect(path.basename(path.dirname(seen))).toMatch(/^shardmind-edit-/);
  });

  it('is a cancel, not an accept, when the file is saved unchanged', async () => {
    expect(editInEditor(CONFLICT, 'Note.md', { command: editor('noop'), dir })).toMatchObject({ kind: 'cancelled', detail: expect.stringMatching(/unchanged/) });
    expect(await leftovers()).toEqual([]);
  });

  it('is a cancel when the editor exits non-zero', async () => {
    expect(editInEditor(CONFLICT, 'Note.md', { command: editor('fail'), dir })).toMatchObject({ kind: 'cancelled', detail: expect.stringMatching(/exited with code 3/) });
    expect(await leftovers()).toEqual([]);
  });

  it('is a cancel when the editor cannot start', async () => {
    const outcome = editInEditor(CONFLICT, 'Note.md', { command: 'shardmind-no-such-editor-xyz', dir });
    expect(outcome.kind).toBe('cancelled');
    expect(await leftovers()).toEqual([]);
  });

  it('is a cancel, not a crash, when the editor removes the file', async () => {
    expect(editInEditor(CONFLICT, 'Note.md', { command: editor('delete'), dir })).toMatchObject({ kind: 'cancelled' });
    expect(await leftovers()).toEqual([]);
  });

  it('says how to make a window editor wait when the file comes back unchanged', () => {
    const outcome = editInEditor(CONFLICT, 'Note.md', { command: editor('noop'), dir });
    expect(outcome.kind === 'cancelled' && outcome.detail).toMatch(/--wait/);
  });

  it('ends every cancel note with a full stop, so the prompt can append to it', () => {
    for (const mode of ['noop', 'fail']) {
      const outcome = editInEditor(CONFLICT, 'Note.md', { command: editor(mode), dir });
      expect(outcome.kind === 'cancelled' && outcome.detail).toMatch(/\.$/);
    }
    const missing = editInEditor(CONFLICT, 'Note.md', { command: 'shardmind-no-such-editor-xyz', dir });
    expect(missing.kind === 'cancelled' && missing.detail).toMatch(/\.$/);
  });

  it('keeps a name cmd.exe would expand out of the command on Windows', async () => {
    const out = path.join(dir, 'seen.txt');
    editInEditor(CONFLICT, '100%PATH%.md', { command: `${editor('record')} "${out}"`, dir, platform: 'win32' });
    const seen = path.basename(await fsp.readFile(out, 'utf-8'));
    expect(seen).not.toContain('%');
    expect(seen.endsWith('.md')).toBe(true);
  });

  it('quotes a file name with spaces and quotes for the shell', () => {
    const outcome = editInEditor(CONFLICT, "Bob's Note (v2).md", { command: editor('resolve'), dir });
    expect(outcome).toEqual({ kind: 'saved', content: 'resolved by hand\n' });
  });
});

describe('hasConflictMarkers (#50)', () => {
  it('finds the markers the merge writes, at line starts only', () => {
    expect(hasConflictMarkers('a\n<<<<<<< yours\nx\n=======\ny\n>>>>>>> shard update\n')).toBe(true);
    // A lone ======= is a Markdown setext underline, not a marker.
    expect(hasConflictMarkers('Title\n=======\n')).toBe(false);
    expect(hasConflictMarkers('a\nb\n')).toBe(false);
    expect(hasConflictMarkers('text with ======= inside\nand <<<<<<< too\n')).toBe(false);
    expect(hasConflictMarkers('========\nSetext heading underline is longer\n')).toBe(false);
  });
});

describe('withSigintHeld (#50)', () => {
  it.skipIf(process.platform === 'win32')(
    'swallows a real Ctrl+C queued while the editor blocks, and hands the next one to the listeners',
    () => {
      const child = spawnSync(
        process.execPath,
        ['--import', 'tsx', path.join(import.meta.dirname, 'fixtures', 'sigint-held-child.ts')],
        { encoding: 'utf-8', timeout: 20_000 },
      );
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({ during: 0, afterHold: 0, afterRestore: 1 });
    },
    30_000,
  );

  it("swallows a Ctrl+C that arrives while the editor runs, then gives SIGINT back to its listeners", async () => {
    const handler = vi.fn();
    process.on('SIGINT', handler);
    try {
      await new Promise<void>((done) => {
        withSigintHeld(() => {
          // A Ctrl+C in the editor reaches node too; it must not end the update.
          process.emit('SIGINT');
        }, done);
      });
      expect(handler).not.toHaveBeenCalled();
      process.emit('SIGINT');
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      process.off('SIGINT', handler);
    }
  });

  it('gives SIGINT back even when the call throws', async () => {
    const handler = vi.fn();
    process.on('SIGINT', handler);
    try {
      await new Promise<void>((done) => {
        expect(() =>
          withSigintHeld(() => {
            throw new Error('editor crashed');
          }, done),
        ).toThrow('editor crashed');
      });
      process.emit('SIGINT');
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      process.off('SIGINT', handler);
    }
  });
});

describe('withTerminalReleased (#50)', () => {
  it('leaves raw mode for the call and restores it after', () => {
    const calls: boolean[] = [];
    const result = withTerminalReleased((on) => calls.push(on), () => {
      calls.push(true === false);
      return 7;
    });
    expect(result).toBe(7);
    expect(calls).toEqual([false, false, true]);
  });

  it('restores raw mode when the call throws', () => {
    const setRawMode = vi.fn();
    expect(() =>
      withTerminalReleased(setRawMode, () => {
        throw new Error('editor crashed');
      }),
    ).toThrow('editor crashed');
    expect(setRawMode.mock.calls).toEqual([[false], [true]]);
  });

  it('just runs the call when raw mode cannot be set', () => {
    expect(withTerminalReleased(undefined, () => 'ran')).toBe('ran');
  });

  // #282: a read in flight when raw mode leaves becomes a line-mode read on
  // Windows, and cancelling it strands ConPTY. The handle's read stops first.
  describe('the stdin read (#282)', () => {
    function fakeInput(handle: Record<string, unknown> | undefined) {
      const input = { _handle: handle, destroy: vi.fn() };
      return { input: input as unknown as NodeJS.ReadStream, destroy: input.destroy };
    }
    function readingHandle(log: string[], codes: { stop?: number; start?: number } = {}) {
      return {
        reading: true,
        readStop: () => {
          log.push('readStop');
          return codes.stop ?? 0;
        },
        readStart: () => {
          log.push('readStart');
          return codes.start ?? 0;
        },
      };
    }

    it('stops a reading handle before raw mode leaves and starts it after raw mode returns', () => {
      const log: string[] = [];
      const handle = readingHandle(log);
      const { input } = fakeInput(handle);
      const result = withTerminalReleased(
        (on) => log.push(`raw ${on}`),
        () => {
          log.push(`fn reading=${handle.reading}`);
          return 'edited';
        },
        input,
      );
      expect(result).toBe('edited');
      expect(log).toEqual(['readStop', 'raw false', 'fn reading=false', 'raw true', 'readStart']);
      expect(handle.reading).toBe(true);
    });

    it('starts the read again when the call throws', () => {
      const log: string[] = [];
      const { input } = fakeInput(readingHandle(log));
      expect(() =>
        withTerminalReleased(
          (on) => log.push(`raw ${on}`),
          () => {
            throw new Error('editor crashed');
          },
          input,
        ),
      ).toThrow('editor crashed');
      expect(log).toEqual(['readStop', 'raw false', 'raw true', 'readStart']);
    });

    it('leaves a handle that is not reading alone', () => {
      const log: string[] = [];
      const handle = { ...readingHandle(log), reading: false };
      const { input } = fakeInput(handle);
      withTerminalReleased((on) => log.push(`raw ${on}`), () => undefined, input);
      expect(log).toEqual(['raw false', 'raw true']);
      expect(handle.reading).toBe(false);
    });

    it('only toggles raw mode when the handle has no readStop or readStart', () => {
      for (const handle of [undefined, { reading: true }, { reading: true, readStop: () => 0 }, { reading: true, readStart: () => 0 }]) {
        const log: string[] = [];
        const { input } = fakeInput(handle);
        withTerminalReleased((on) => log.push(`raw ${on}`), () => undefined, input);
        expect(log).toEqual(['raw false', 'raw true']);
      }
    });

    it('leaves the read as it was when readStop fails', () => {
      const log: string[] = [];
      const handle = readingHandle(log, { stop: -4058 });
      const { input } = fakeInput(handle);
      withTerminalReleased((on) => log.push(`raw ${on}`), () => undefined, input);
      expect(log).toEqual(['readStop', 'raw false', 'raw true']);
      expect(handle.reading).toBe(true);
    });

    it('destroys the stream with the code when readStart fails, as Node does', () => {
      const log: string[] = [];
      const handle = readingHandle(log, { start: -4077 });
      const { input, destroy } = fakeInput(handle);
      withTerminalReleased((on) => log.push(`raw ${on}`), () => undefined, input);
      expect(log).toEqual(['readStop', 'raw false', 'raw true', 'readStart']);
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(destroy.mock.calls[0]![0]).toBeInstanceOf(Error);
      expect(String(destroy.mock.calls[0]![0])).toContain('-4077');
      expect(handle.reading).toBe(false);
    });

    it('reads process.stdin by default', () => {
      const log: string[] = [];
      const previous: unknown = Reflect.get(process.stdin, '_handle');
      Reflect.set(process.stdin, '_handle', readingHandle(log));
      try {
        withTerminalReleased((on) => log.push(`raw ${on}`), () => undefined);
      } finally {
        Reflect.set(process.stdin, '_handle', previous);
      }
      expect(log).toEqual(['readStop', 'raw false', 'raw true', 'readStart']);
    });
  });
});
