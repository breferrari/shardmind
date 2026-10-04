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
import {
  editInEditor,
  hasConflictMarkers,
  resolveEditorCommand,
  withSigintHeld,
  withTerminalReleased,
} from '../../source/core/editor.js';

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
});
