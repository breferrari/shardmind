/**
 * `source/core/color-env.ts` (#37): NO_COLOR turns colour off unless FORCE_COLOR is set.
 * See docs/IMPLEMENTATION.md §4.21.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { applyNoColor, sanitizeHookLine, sanitizeHookPath, sanitizeHookText } from '../../source/core/color-env.js';

function applied(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  applyNoColor(copy);
  return copy;
}

describe('applyNoColor', () => {
  it('turns colour off when NO_COLOR is non-empty', () => {
    expect(applied({ NO_COLOR: '1' })).toEqual({ NO_COLOR: '1', FORCE_COLOR: '0' });
  });

  it('does nothing when NO_COLOR is empty', () => {
    expect(applied({ NO_COLOR: '' })).toEqual({ NO_COLOR: '' });
  });

  it('does nothing when NO_COLOR is unset', () => {
    expect(applied({})).toEqual({});
  });

  it('lets FORCE_COLOR win over NO_COLOR', () => {
    expect(applied({ NO_COLOR: '1', FORCE_COLOR: '1' })).toEqual({ NO_COLOR: '1', FORCE_COLOR: '1' });
  });

  it('lets an empty FORCE_COLOR win too, since it is set', () => {
    expect(applied({ NO_COLOR: '1', FORCE_COLOR: '' })).toEqual({ NO_COLOR: '1', FORCE_COLOR: '' });
  });

  it.each(['-1', '-3', ' -2'])('turns a negative FORCE_COLOR (%j), which chalk would throw on, into 0', (value) => {
    expect(applied({ FORCE_COLOR: value })).toEqual({ FORCE_COLOR: '0' });
    expect(applied({ FORCE_COLOR: value, NO_COLOR: '' })).toEqual({ FORCE_COLOR: '0', NO_COLOR: '' });
  });

  it.each(['0', '1', '3', '4', '', 'true', 'false', 'foo'])('leaves FORCE_COLOR=%j as chalk reads it', (value) => {
    expect(applied({ FORCE_COLOR: value })).toEqual({ FORCE_COLOR: value });
  });

  it('leaves every other variable alone', () => {
    expect(applied({ NO_COLOR: 'yes', TERM: 'xterm', PATH: '/bin' })).toEqual({
      NO_COLOR: 'yes',
      TERM: 'xterm',
      PATH: '/bin',
      FORCE_COLOR: '0',
    });
  });
});

describe('load order in source/cli.ts', () => {
  // chalk reads the environment once, when first imported. A static import
  // that reaches Ink (and so chalk) runs before applyNoColor, whatever the
  // line order, so cli.ts and what it imports statically must not reach it.
  const sourceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../source');
  const parse = (rel: string): ts.SourceFile =>
    ts.createSourceFile(rel, fs.readFileSync(path.join(sourceDir, rel), 'utf-8'), ts.ScriptTarget.Latest, true);

  /** Every module a file loads statically: `import … from`, `import '…'`, `export … from`. */
  const staticImports = (rel: string): string[] =>
    parse(rel)
      .statements.filter(
        (s): s is ts.ImportDeclaration | ts.ExportDeclaration =>
          (ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) && s.moduleSpecifier !== undefined,
      )
      .filter((s) => !(ts.isImportDeclaration(s) && s.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword))
      .map((s) => (s.moduleSpecifier as ts.StringLiteral).text);

  it('imports statically only modules that cannot load chalk', () => {
    expect(staticImports('cli.ts').sort()).toEqual(
      ['./core/cancellation.js', './core/color-env.js', './core/json-run.js', './core/stdout-closed.js', 'node:module'].sort(),
    );
  });

  it.each(['core/cancellation.ts', 'core/color-env.ts', 'core/json-run.ts', 'core/stdout-closed.ts'])('%s imports nothing beyond node built-ins', (rel) => {
    expect(staticImports(rel).filter((spec) => !spec.startsWith('node:'))).toEqual([]);
  });

  it('calls applyNoColor as a top-level statement before any statement that imports', () => {
    // Top level, unconditional, and ahead of every statement holding an
    // import() anywhere inside it (a helper that imports counts too).
    const statements = parse('cli.ts').statements;
    const hasDynamicImport = (node: ts.Node): boolean =>
      (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) ||
      (ts.forEachChild(node, hasDynamicImport) ?? false);
    const applyIndex = statements.findIndex(
      (s) =>
        ts.isExpressionStatement(s) &&
        ts.isCallExpression(s.expression) &&
        ts.isIdentifier(s.expression.expression) &&
        s.expression.expression.text === 'applyNoColor',
    );
    const firstImportIndex = statements.findIndex(hasDynamicImport);
    expect(applyIndex).toBeGreaterThan(-1);
    expect(firstImportIndex).toBeGreaterThan(applyIndex);
  });

  it('marks a --json run non-interactive at the top level before any statement that imports (#198)', () => {
    const statements = parse('cli.ts').statements;
    const hasDynamicImport = (node: ts.Node): boolean =>
      (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) ||
      (ts.forEachChild(node, hasDynamicImport) ?? false);
    const markIndex = statements.findIndex(
      (s) => ts.isIfStatement(s) && s.getText().includes('markNonInteractive('),
    );
    const firstImportIndex = statements.findIndex(hasDynamicImport);
    expect(markIndex).toBeGreaterThan(-1);
    expect(firstImportIndex).toBeGreaterThan(markIndex);
  });
});

describe('sanitizeHookText', () => {
  const SGR_CASES: Array<[string, string, string]> = [
    ['basic colour and reset', '\x1b[32mgreen\x1b[0m', 'green'],
    ['bare reset', 'a\x1b[mb', 'ab'],
    ['several parameters', '\x1b[1;4;31mx\x1b[22;24;39m', 'x'],
    ['256-colour', '\x1b[38;5;208mo\x1b[48;5;17mb', 'ob'],
    ['truecolor, semicolons', '\x1b[38;2;255;100;0mt', 't'],
    ['truecolor, colons', '\x1b[38:2::255:100:0mt', 't'],
    ['8-bit CSI', '\u009b31mred\u009b0m', 'red'],
  ];

  it.each(SGR_CASES)('removes SGR when colour is off: %s', (_name, input, plain) => {
    expect(sanitizeHookText(input, false)).toBe(plain);
  });

  it.each(SGR_CASES.filter(([name]) => name !== '8-bit CSI'))('keeps SGR when colour is on: %s', (_name, input) => {
    expect(sanitizeHookText(input, true)).toBe(input);
  });

  it('keeps 8-bit SGR as 7-bit, so no raw C1 control reaches the terminal', () => {
    expect(sanitizeHookText('\u009b31mred\u009b0m', true)).toBe('\x1b[31mred\x1b[0m');
  });

  it.each([
    ['OSC 52 clipboard write, BEL', 'a\x1b]52;c;aGk=\x07b', 'ab'],
    ['OSC 52 clipboard write, ST', 'a\x1b]52;c;aGk=\x1b\\b', 'ab'],
    ['OSC 0 title', 'a\x1b]0;pwned\x07b', 'ab'],
    ['8-bit OSC and ST', 'a\u009d0;pwned\u009cb', 'ab'],
    ['OSC 8 hyperlink, keeping its text', '\x1b]8;;https://evil.example\x07click\x1b]8;;\x07', 'click'],
    ['cursor-up', 'a\x1b[1Ab', 'ab'],
    ['erase display', 'a\x1b[2Jb', 'ab'],
    ['private-mode CSI', 'a\x1b[?25lb', 'ab'],
    ['CSI with an intermediate byte', 'a\x1b[1 qb', 'ab'],
    ['a non-SGR CSI ending in m-like params', 'a\x1b[?1mb', 'ab'],
    ['DCS through ST', 'a\x1bP1$tx\x1b\\b', 'ab'],
    ['APC through ST', 'a\x1b_payload\x1b\\b', 'ab'],
    ['PM through ST', 'a\x1b^payload\x1b\\b', 'ab'],
    ['8-bit DCS through ST', 'a\u0090payload\u009cb', 'ab'],
    ['ESC c (reset)', 'a\x1bcb', 'ab'],
    ['ESC 7 (save cursor)', 'a\x1b7b', 'ab'],
    ['ESC ( B (charset)', 'a\x1b(Bb', 'ab'],
    ['BEL', 'a\x07b', 'ab'],
    ['BS', 'a\x08b', 'ab'],
    ['VT and FF', 'a\x0b\x0cb', 'ab'],
    ['NUL and other C0', 'a\x00\x01\x1fb', 'ab'],
    ['DEL', 'a\x7fb', 'ab'],
    ['a C1 control', 'a\u0085b', 'ab'],
  ])('removes %s, colour on or off', (_name, input, expected) => {
    expect(sanitizeHookText(input, true)).toBe(expected);
    expect(sanitizeHookText(input, false)).toBe(expected);
  });

  it.each([
    ['a progress bar', 'build 10%\rbuild 50%\rbuild 100%', 'build 100%'],
    ['a CR per line', 'a 1\ra 2\nb 1\rb 2\n', 'a 2\nb 2\n'],
    ['CRLF line endings', 'one\r\ntwo\r\n', 'one\ntwo\n'],
    ['a trailing CR', 'done\r', 'done'],
    ['text then CR progress', '50%\r60%\r', '60%'],
    ['CR CR LF (Windows text-mode print)', 'ok\r\r\n', 'ok\n'],
  ])('treats a lone CR as rewriting the line: %s', (_name, input, expected) => {
    expect(sanitizeHookText(input, true)).toBe(expected);
  });

  it.each([
    ['a colour set before the CR', '\x1b[31m\rERROR: disk full', '\x1b[31mERROR: disk full', 'ERROR: disk full'],
    ['a style on the overwritten text', '\x1b[1;33mwarn 10%\rwarn 100%', '\x1b[1;33mwarn 100%', 'warn 100%'],
    ['a reset after the shown text', '\x1b[1mBuilding 50%\r\x1b[0m', '\x1b[1mBuilding 50%\x1b[0m', 'Building 50%'],
    ['a colour per update, reduced at each reset', '\x1b[32m1%\x1b[0m\r\x1b[32m2%\x1b[0m\r\x1b[32m3%\x1b[0m', '\x1b[32m3%\x1b[0m', '3%'],
    ['an erase after the text', 'done\r\x1b[2K', 'done', 'done'],
  ])('carries SGR across a CR, as a terminal keeps its pen: %s', (_name, input, coloured, plain) => {
    expect(sanitizeHookText(input, true)).toBe(coloured);
    expect(sanitizeHookText(input, false)).toBe(plain);
  });

  it.each([
    ['a lone ESC at the end', 'text\x1b', 'text'],
    ['a lone ESC before a newline', 'one\x1b\ntwo', 'one\ntwo'],
    ['a lone ESC before a non-ASCII letter', 'a\x1béb', 'aéb'],
    ['an OSC with no terminator', 'a\x1b]52;c;aGk=\nnext line\n', 'a52;c;aGk=\nnext line\n'],
    ['an 8-bit OSC with no terminator', 'a\u009d0;title', 'a0;title'],
    ['an OSC whose last byte is ESC', 'a\x1b]0;x\x1b', 'a'],
    ['a DCS with no terminator', 'a\x1bPpayload\nnext', 'apayload\nnext'],
    ['a CSI cut off at the end', 'x\x1b[3', 'x'],
    ['a CSI cut off after an intermediate', 'x\x1b[1 ', 'x'],
    ['an escape cut off after intermediates', 'a\x1b  ', 'a'],
    ['a CSI cut off before a newline', 'x\x1b[31\ny', 'x\ny'],
  ])('cannot swallow output with %s', (_name, input, expected) => {
    expect(sanitizeHookText(input, true)).toBe(expected);
  });

  it.each([
    ['ESC', 'a\x1b]0;x\x1b[31mERROR\x1b[0m \x07 z', 'a\x1b[31mERROR\x1b[0m  z', 'aERROR  z'],
    ['CAN', 'a\x1b]0;x\x18b', 'ab', 'ab'],
    ['SUB', 'a\x1bPpayload\x1ab', 'ab', 'ab'],
  ])('aborts a string sequence at %s, as a terminal does', (_name, input, coloured, plain) => {
    expect(sanitizeHookText(input, true)).toBe(coloured);
    expect(sanitizeHookText(input, false)).toBe(plain);
  });

  it.each([
    ['a tab at the start', '\tx', '        x'],
    ['a tab mid-word', 'ab\tc', 'ab      c'],
    ['a tab on a stop', 'abcdefgh\tx', 'abcdefgh        x'],
    ['a tab after kept colour', '\x1b[32mab\x1b[0m\tc', '\x1b[32mab\x1b[0m      c'],
    ['a tab after wide characters', '日本\tx', '日本    x'],
    ['a tab after a combining mark', 'é\tx', 'é       x'],
    ['a tab after an astral emoji', '\u{1F389}\tx', '\u{1F389}      x'],
  ])('expands %s to spaces, to the next multiple of 8', (_name, input, expected) => {
    expect(sanitizeHookText(input, true)).toBe(expected);
  });

  it.each([
    ['only colour codes', '\x1b[0m'],
    ['colour codes around a CR', '\x1b[31m\r'],
    ['only removed controls', '\x07\x08'],
  ])('reduces a line of %s to nothing', (_name, line) => {
    expect(sanitizeHookLine(line, true)).toBe('');
    expect(sanitizeHookLine(line, false)).toBe('');
  });
});

describe('sanitizeHookPath', () => {
  it.each([
    ['a CR that would hide the real name', 'secrets-dump.sh\rnotes.md', 'secrets-dump.sh\\rnotes.md'],
    ['an LF that would forge a line', 'x.md\n✔ Bootstrap completed.', 'x.md\\n✔ Bootstrap completed.'],
    ['a tab', 'a\tb.md', 'a\\tb.md'],
    ['OSC 52 and OSC 8', '\x1b]52;c;aGk=\x07\x1b]8;;https://evil.example\x07notes.md\x1b]8;;\x07', 'notes.md'],
    ['colour, which a path never keeps', '\x1b[31mred.md\x1b[0m', 'red.md'],
    ['BEL and BS', 'a\x07\x08b.md', 'ab.md'],
  ])('shows %s safely', (_name, input, expected) => {
    expect(sanitizeHookPath(input)).toBe(expected);
  });

  it('leaves an ordinary path alone', () => {
    expect(sanitizeHookPath('brain/North Star.md')).toBe('brain/North Star.md');
  });

  it.each([
    ['newlines', 'a\nb\nc\n'],
    ['Unicode and emoji', 'café ✓ 🎉 日本語'],
    ['plain text with brackets', 'array[0m] ]52;'],
  ])('leaves %s alone', (_name, input) => {
    expect(sanitizeHookText(input, true)).toBe(input);
    expect(sanitizeHookText(input, false)).toBe(input);
  });
});
