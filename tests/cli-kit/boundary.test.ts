/**
 * cli-kit stays extractable (#277): it imports only ink, react, commander,
 * zod, zod-validation-error, node: built-ins, its own files and the ui-kit's
 * index, and ShardMind reaches it only through its index.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PENDING_FILE } from '../../scripts/vendor/update.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KIT = path.join(REPO, 'source', 'cli-kit');
const UI_KIT_INDEX = path.join(REPO, 'source', 'ui-kit', 'index.js');
const ALLOWED_PACKAGES = new Set(['ink', 'react', 'commander', 'zod', 'zod-validation-error']);

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

describe('cli-kit boundary (#277)', () => {
  it('holds no unfinished vendor update (#280)', () => {
    // A conflicted `vendor:update` leaves this until `--resolved` finishes it;
    // committed, it would put a half-merged kit on main.
    expect(fs.existsSync(path.join(KIT, PENDING_FILE)), `finish it: npm run vendor:update -- cli-kit <version> --resolved`).toBe(false);
  });

  it('imports only its allowed packages, node: built-ins, its own files and the ui-kit index', () => {
    const outside: string[] = [];
    for (const file of sourceFiles(KIT)) {
      for (const spec of specifiers(fs.readFileSync(file, 'utf-8'))) {
        if (spec.startsWith('node:') || ALLOWED_PACKAGES.has(spec)) continue;
        if (spec.startsWith('.')) {
          const target = path.resolve(path.dirname(file), spec);
          if (target === UI_KIT_INDEX || target.startsWith(KIT + path.sep)) continue;
        }
        outside.push(`${path.relative(KIT, file)} → ${spec}`);
      }
    }
    expect(outside).toEqual([]);
  });

  it('is reached from the rest of ShardMind only through its index', () => {
    const deep: string[] = [];
    for (const file of sourceFiles(path.join(REPO, 'source'))) {
      if (file.startsWith(KIT + path.sep)) continue;
      for (const spec of specifiers(fs.readFileSync(file, 'utf-8'))) {
        if (!spec.includes('cli-kit')) continue;
        const target = path.resolve(path.dirname(file), spec);
        if (target !== path.join(KIT, 'index.js')) deep.push(`${path.relative(REPO, file)} → ${spec}`);
      }
    }
    expect(deep).toEqual([]);
  });

  it("keeps Pastel's notice and adds the modifications' copyright", () => {
    expect(fs.readFileSync(path.join(KIT, 'LICENSE'), 'utf-8')).toContain(
      'Copyright (c) Vadym Demedes <vadimdemedes@hey.com> (vadimdemedes.com)\nCopyright (c) 2026 Brenno Ferrari\n',
    );
    expect(fs.readFileSync(path.join(KIT, 'LICENSE-sindresorhus'), 'utf-8')).toMatch(/Copyright \(c\) Sindre Sorhus/);
  });

  it('leaves no pastel import anywhere in source/ or tests/', () => {
    const found: string[] = [];
    for (const dir of ['source', 'tests']) {
      for (const file of sourceFiles(path.join(REPO, dir))) {
        if (specifiers(fs.readFileSync(file, 'utf-8')).some((spec) => spec === 'pastel' || spec.startsWith('pastel/'))) {
          found.push(path.relative(REPO, file));
        }
      }
    }
    expect(found).toEqual([]);
  });
});
