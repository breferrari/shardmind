/**
 * ui-kit stays extractable (#43): it imports only ink, react, node:
 * built-ins and its own files, and ShardMind reaches it only through its
 * index. Either rule broken would tie it to this repo.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KIT = path.join(REPO, 'source', 'ui-kit');
const ALLOWED_PACKAGES = new Set(['ink', 'react']);

function sourceFiles(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true }) as string[])
    .filter((rel) => /\.(ts|tsx)$/.test(rel))
    .map((rel) => path.join(dir, rel));
}

/** Every module specifier in `import … from`, `export … from`, `import('…')` and side-effect imports. */
function specifiers(source: string): string[] {
  const found: string[] = [];
  for (const re of [/\bfrom\s+['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, /^\s*import\s+['"]([^'"]+)['"]/gm]) {
    for (const m of source.matchAll(re)) found.push(m[1]!);
  }
  return found;
}

describe('ui-kit boundary (#43)', () => {
  it('imports only ink, react, node: built-ins and files inside the module', () => {
    const outside: string[] = [];
    for (const file of sourceFiles(KIT)) {
      for (const spec of specifiers(fs.readFileSync(file, 'utf-8'))) {
        if (spec.startsWith('node:') || ALLOWED_PACKAGES.has(spec)) continue;
        if (spec.startsWith('.')) {
          const target = path.resolve(path.dirname(file), spec);
          if (target === KIT || target.startsWith(KIT + path.sep)) continue;
        }
        outside.push(`${path.relative(KIT, file)} → ${spec}`);
      }
    }
    expect(outside).toEqual([]);
  });

  it("is reached from the rest of ShardMind only through its index", () => {
    const deep: string[] = [];
    for (const file of sourceFiles(path.join(REPO, 'source'))) {
      if (file.startsWith(KIT + path.sep)) continue;
      for (const spec of specifiers(fs.readFileSync(file, 'utf-8'))) {
        if (!spec.includes('ui-kit')) continue;
        const target = path.resolve(path.dirname(file), spec);
        if (target !== path.join(KIT, 'index.js')) deep.push(`${path.relative(REPO, file)} → ${spec}`);
      }
    }
    expect(deep).toEqual([]);
  });

  it('leaves no import of @inkjs/ui anywhere in source/ or tests/ (#273)', () => {
    const found: string[] = [];
    for (const dir of ['source', 'tests']) {
      for (const file of sourceFiles(path.join(REPO, dir))) {
        // Pastel, vendored byte for byte and not yet adapted (#277); the
        // next commit swaps its import and removes this exemption.
        if (file.startsWith(path.join(REPO, 'source', 'cli-kit') + path.sep)) continue;
        if (specifiers(fs.readFileSync(file, 'utf-8')).some((spec) => spec === '@inkjs/ui' || spec.startsWith('@inkjs/ui/'))) {
          found.push(path.relative(REPO, file));
        }
      }
    }
    expect(found).toEqual([]);
  });

  it('carries its licence and provenance with it', () => {
    expect(fs.readFileSync(path.join(KIT, 'LICENSE'), 'utf-8')).toMatch(/MIT License/);
    expect(fs.readFileSync(path.join(KIT, 'PROVENANCE.md'), 'utf-8')).toMatch(/14b1145da0123a48cfc2f0ec9ff33dff0633f464/);
    expect(fs.readFileSync(path.join(KIT, 'index.ts'), 'utf-8')).toMatch(/^\/\*!/);
  });

  it('keeps the upstream notice and adds the modifications’ copyright', () => {
    const licence = fs.readFileSync(path.join(KIT, 'LICENSE'), 'utf-8');
    expect(licence).toContain(
      'Copyright (c) Vadym Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes)\nCopyright (c) 2026 Brenno Ferrari\n',
    );
    expect(fs.readFileSync(path.join(KIT, 'LICENSE-sindresorhus'), 'utf-8')).toMatch(/Copyright \(c\) Sindre Sorhus/);
  });

  it('names a copyright at the top of every source file', () => {
    const unnamed = sourceFiles(KIT).filter((file) => {
      const head = fs.readFileSync(file, 'utf-8').slice(0, 400);
      return !/^\/\*!?\n[\s\S]*?Copyright \(c\)/.test(head);
    });
    expect(unnamed.map((file) => path.relative(KIT, file))).toEqual([]);
  });
});
