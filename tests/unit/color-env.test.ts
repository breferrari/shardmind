/**
 * `source/core/color-env.ts` (#37): NO_COLOR turns colour off unless FORCE_COLOR is set.
 * See docs/IMPLEMENTATION.md §4.21.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { applyNoColor, stripSgr } from '../../source/core/color-env.js';

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
      ['./core/cancellation.js', './core/color-env.js', 'node:module'].sort(),
    );
  });

  it.each(['core/cancellation.ts', 'core/color-env.ts'])('%s imports nothing beyond node built-ins', (rel) => {
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
});

describe('stripSgr', () => {
  it.each([
    ['basic colour and reset', '\x1b[32mgreen\x1b[0m', 'green'],
    ['bare reset', 'a\x1b[mb', 'ab'],
    ['several parameters', '\x1b[1;4;31mx\x1b[22;24;39m', 'x'],
    ['256-colour', '\x1b[38;5;208mo\x1b[48;5;17mb', 'ob'],
    ['truecolor, semicolons', '\x1b[38;2;255;100;0mt', 't'],
    ['truecolor, colons', '\x1b[38:2::255:100:0mt', 't'],
    ['8-bit CSI', '\u009b31mred\u009b0m', 'red'],
  ])('strips %s', (_name, input, expected) => {
    expect(stripSgr(input)).toBe(expected);
  });

  it.each([
    ['a lone ESC', 'a\x1bb'],
    ['an unterminated CSI', 'x\x1b[31'],
    ['a cursor-up (not colour; #204)', 'x\x1b[1A'],
    ['an OSC title (not colour; #204)', '\x1b]0;title\x07'],
    ['plain text with brackets', 'array[0m]'],
  ])('leaves %s alone', (_name, input) => {
    expect(stripSgr(input)).toBe(input);
  });
});
