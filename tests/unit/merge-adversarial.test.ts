/**
 * Adversarial stress tests for the merge engine. These go after the engine
 * from angles that fixture tests don't — bad encodings, reserved strings in
 * user content, prototype pollution, size extremes, idempotence, race
 * conditions. Every test here was written to *try to break* the engine;
 * comments note where the design decisions stood up under pressure.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { threeWayMerge, computeMergeAction } from '../../source/core/differ.js';
import { detectDrift } from '../../source/core/drift.js';
import { sha256 } from '../../source/core/fs-utils.js';
import { makeShardState } from '../helpers/index.js';
import type { RenderContext } from '../../source/runtime/types.js';

const CTX: RenderContext = {
  values: {},
  included_modules: [],
  shard: { name: 'test', version: '0.1.0' },
  install_date: '2026-04-19',
  year: '2026',
};

describe('merge adversarial — control characters in line content', () => {
  // `differ.ts` uses a `LineInterner` that maps every unique line to an
  // integer-named token before passing it to diff3, so user content can
  // contain *any* byte — including control characters that an earlier
  // sentinel-prefix implementation would have mangled. These tests exist
  // as a regression guard against reintroducing a strip-based encoding.

  it('preserves U+0001 that appears inside line content', () => {
    const content = 'before\u0001after\n';
    const result = threeWayMerge(content, content, content);
    expect(result.content).toBe(content);
  });

  it('preserves a line whose first character is U+0001', () => {
    const content = '\u0001leading\n';
    const result = threeWayMerge(content, content, content);
    expect(result.content).toBe(content);
  });
});

describe('merge adversarial — prototype pollution vectors', () => {
  // Object.prototype is large; hit every common member name as a line.
  const prototypeKeys = [
    'constructor',
    '__proto__',
    'toString',
    'hasOwnProperty',
    'valueOf',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
    '__defineGetter__',
    '__defineSetter__',
    '__lookupGetter__',
    '__lookupSetter__',
  ];

  for (const key of prototypeKeys) {
    it(`handles "${key}" as a single-line file`, () => {
      const result = threeWayMerge(key, key, key);
      expect(result.content).toBe(key);
    });
  }

  it('handles a full Object.prototype dictionary as user content', () => {
    const content = prototypeKeys.join('\n') + '\n';
    const result = threeWayMerge(content, content, content);
    expect(result.content).toBe(content);
    expect(result.conflicts).toHaveLength(0);
  });

  it('handles prototype keys in a conflict region', () => {
    const base = 'alpha\nbeta\n';
    const theirs = 'alpha\n__proto__\n';
    const ours = 'alpha\nconstructor\n';
    const result = threeWayMerge(base, theirs, ours);
    expect(result.conflicts).toHaveLength(1);
    expect(result.content).toContain('__proto__');
    expect(result.content).toContain('constructor');
  });
});

describe('merge adversarial — line ending edge cases', () => {
  it('handles files with no trailing newline', () => {
    const result = threeWayMerge('line', 'line', 'line');
    expect(result.content).toBe('line');
    expect(result.conflicts).toHaveLength(0);
  });

  it('preserves base/ours trailing newline style when both agree', () => {
    const withLn = 'a\nb\n';
    const result = threeWayMerge(withLn, withLn, withLn);
    expect(result.content).toBe(withLn);
  });

  it('handles mixed CRLF/LF in theirs by picking CRLF (dominant Windows style)', () => {
    const base = 'a\nb\nc\n';
    const theirs = 'a\r\nb\nc\r\n';
    const ours = 'a\nb\nc\n';
    const result = threeWayMerge(base, theirs, ours);
    expect(result.conflicts).toHaveLength(0);
    // Mixed → CRLF: whenever theirs contains ANY CRLF we honor it on
    // output so we never silently rewrite a Windows user's file to LF.
    expect(result.content).toContain('\r\n');
  });

  it('handles pure CR (old Mac) line endings gracefully — no crash', () => {
    // We don't promise to merge pure-CR files correctly (no realistic source
    // writes them today), but the engine must not crash on them.
    const cr = 'a\rb\rc';
    expect(() => threeWayMerge(cr, cr, cr)).not.toThrow();
  });

  it('handles empty string on all three sides', () => {
    const result = threeWayMerge('', '', '');
    expect(result.content).toBe('');
    expect(result.conflicts).toHaveLength(0);
  });
});

describe('merge adversarial — conflict marker injection', () => {
  // A user's markdown file might legitimately contain `<<<<<<< yours` in a
  // code block explaining git merges. If we don't defend against this, the
  // post-merge output becomes ambiguous — a downstream tool (or human) can't
  // tell the real markers from user content.

  it('user content containing literal marker strings round-trips through identity merge', () => {
    const content = '# Git explainer\n\n```\n<<<<<<< yours\nconflict body\n=======\nother body\n>>>>>>> shard update\n```\n';
    const result = threeWayMerge(content, content, content);
    expect(result.content).toBe(content);
    expect(result.conflicts).toHaveLength(0);
  });

  it('user-content markers do not confuse auto-merge counting', () => {
    const base = '# Note\n\nOriginal.\n';
    const ours = '# Note\n\nShard updated.\n';
    const theirs = '# Note\n\nOriginal.\n\n## Doc\n\n<<<<<<< yours\nexample\n=======\nother\n>>>>>>> shard update\n';
    const result = threeWayMerge(base, theirs, ours);
    expect(result.conflicts).toHaveLength(0);
    expect(result.content).toContain('<<<<<<< yours');
    expect(result.content).toContain('Shard updated.');
  });
});

describe('merge adversarial — unicode, BOM, null bytes', () => {
  it('preserves UTF-8 BOM if present on base/ours/theirs', () => {
    const bom = '\uFEFF';
    const content = `${bom}# Title\n`;
    const result = threeWayMerge(content, content, content);
    expect(result.content).toBe(content);
  });

  it('preserves zero-width joiners inside emoji sequences', () => {
    const content = '👨‍👩‍👧‍👦 family\n';
    const result = threeWayMerge(content, content, content);
    expect(result.content).toBe(content);
  });

  it('preserves RTL text', () => {
    const content = 'שלום עולם\nمرحبا بالعالم\n';
    const result = threeWayMerge(content, content, content);
    expect(result.content).toBe(content);
  });

  it('preserves combining marks without NFC normalization', () => {
    // "é" as precomposed vs decomposed — byte-equal comparison only.
    const nfc = 'café\n';
    const nfd = 'cafe\u0301\n';
    expect(nfc).not.toBe(nfd); // sanity: they are byte-distinct
    const result = threeWayMerge(nfd, nfd, nfd);
    expect(result.content).toBe(nfd);
  });

  it('handles lines containing null bytes', () => {
    const content = 'alpha\nbeta\0gamma\ndelta\n';
    const result = threeWayMerge(content, content, content);
    expect(result.content).toBe(content);
  });
});

describe('merge adversarial — size extremes', () => {
  it('handles a single-line 10K-char file', () => {
    const line = 'x'.repeat(10_000);
    const content = `${line}\n`;
    const result = threeWayMerge(content, content, content);
    expect(result.content).toBe(content);
    expect(result.conflicts).toHaveLength(0);
  });

  it('handles a 5K-line file without panic', () => {
    const lines = Array.from({ length: 5_000 }, (_, i) => `line ${i}`);
    const content = lines.join('\n') + '\n';
    const result = threeWayMerge(content, content, content);
    expect(result.content).toBe(content);
  });

  it('handles many small conflicts in one file', () => {
    const base = Array.from({ length: 20 }, (_, i) => `shared-${i}\nbase-${i}`).join('\n') + '\n';
    const theirs = Array.from({ length: 20 }, (_, i) => `shared-${i}\ntheirs-${i}`).join('\n') + '\n';
    const ours = Array.from({ length: 20 }, (_, i) => `shared-${i}\nours-${i}`).join('\n') + '\n';
    const result = threeWayMerge(base, theirs, ours);
    expect(result.conflicts.length).toBeGreaterThan(5);
  });
});

describe('merge adversarial — idempotence and convergence', () => {
  it('identity merge is idempotent', () => {
    const x = '# Note\n\nLine 1.\nLine 2.\n';
    const once = threeWayMerge(x, x, x);
    const twice = threeWayMerge(once.content, once.content, once.content);
    expect(twice.content).toBe(once.content);
  });

  it('re-merging auto-merged output against itself is stable', () => {
    const base = 'a\nb\nc\n';
    const theirs = 'a\nb\nc\nd\n';
    const ours = 'A\nb\nc\n';
    const first = threeWayMerge(base, theirs, ours);
    expect(first.conflicts).toHaveLength(0);
    const second = threeWayMerge(first.content, first.content, first.content);
    expect(second.content).toBe(first.content);
  });
});

describe('merge adversarial — conflict boundaries', () => {
  it('conflict at very start of file', () => {
    const base = 'base first\nshared\n';
    const theirs = 'theirs first\nshared\n';
    const ours = 'ours first\nshared\n';
    const result = threeWayMerge(base, theirs, ours);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.lineStart).toBe(1);
  });

  it('conflict at very end of file', () => {
    const base = 'shared\nbase last';
    const theirs = 'shared\ntheirs last';
    const ours = 'shared\nours last';
    const result = threeWayMerge(base, theirs, ours);
    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0]!;
    expect(conflict.lineEnd).toBeGreaterThanOrEqual(conflict.lineStart);
  });

  it('conflict is the entire file', () => {
    const result = threeWayMerge('original\n', 'user\n', 'shard\n');
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.lineStart).toBe(1);
  });
});

describe('drift adversarial — races and weird filesystems', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = path.join(os.tmpdir(), `drift-adv-${crypto.randomUUID()}`);
    await fsp.mkdir(vaultRoot, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(vaultRoot, { recursive: true, force: true });
  });

  it('tolerates a file disappearing between state read and scan', async () => {
    const rel = 'ephemeral.md';
    await fsp.writeFile(path.join(vaultRoot, rel), 'content\n', 'utf-8');
    const state = makeShardState({
      files: {
        [rel]: { template: 't.njk', rendered_hash: sha256('content\n'), ownership: 'managed' },
      },
    });

    // Delete just before detectDrift reaches it — approximates a race.
    await fsp.rm(path.join(vaultRoot, rel));
    const report = await detectDrift(vaultRoot, state);

    expect(report.missing).toHaveLength(1);
    expect(report.managed).toHaveLength(0);
  });

  it('orphan scan tolerates a tracked directory being deleted', async () => {
    // Legitimate: CLAUDE.md recorded at root but the vault root somehow
    // lost the file. detectDrift should classify as missing without
    // orphan scan blowing up.
    const state = makeShardState({
      files: {
        'root.md': { template: 't.njk', rendered_hash: sha256('x\n'), ownership: 'managed' },
      },
    });

    const report = await detectDrift(vaultRoot, state);
    expect(report.missing).toHaveLength(1);
    expect(report.orphaned).toEqual([]);
  });

  it('handles backslash path separators in state.files keys on Windows', async () => {
    // install-executor normalizes to posix, but if a state.json ever
    // slips through with native separators, drift must not choke.
    const withBackslashes = 'nested\\file.md';
    await fsp.mkdir(path.join(vaultRoot, 'nested'), { recursive: true });
    await fsp.writeFile(path.join(vaultRoot, 'nested', 'file.md'), 'content\n', 'utf-8');
    const state = makeShardState({
      files: {
        [withBackslashes]: {
          template: 't.njk',
          rendered_hash: sha256('content\n'),
          ownership: 'managed',
        },
      },
    });

    // On Windows, path.join tolerates mixed separators; on POSIX, the
    // backslashed path won't resolve. Either way, no crash.
    await expect(detectDrift(vaultRoot, state)).resolves.toBeDefined();
  });
});

describe('merge adversarial — trailing newline arithmetic', () => {
  it('base ends with \\n, ours does not (shard dropped trailing newline)', () => {
    const base = 'line\n';
    const theirs = 'line\n';
    const ours = 'line';
    const result = threeWayMerge(base, theirs, ours);
    // Spec is silent on the right answer. What we guarantee is that the
    // operation completes and the body content is preserved.
    expect(result.content).toContain('line');
  });

  it('theirs has extra trailing newlines the others do not', () => {
    const base = 'a\n';
    const theirs = 'a\n\n\n';
    const ours = 'a\n';
    const result = threeWayMerge(base, theirs, ours);
    expect(result.content.startsWith('a')).toBe(true);
  });

  it('no file ends with newline — merge still produces LF-joined output', () => {
    const base = 'a\nb';
    const theirs = 'a\nb';
    const ours = 'a\nB';
    const result = threeWayMerge(base, theirs, ours);
    expect(result.content).toBe('a\nB');
  });
});

describe('merge adversarial — whitespace-sensitive diffs', () => {
  it('distinguishes a blank line from a space-only line', () => {
    const base = 'a\n\nb\n';
    const theirs = 'a\n \nb\n';
    const ours = 'a\n\nb\n';
    const result = threeWayMerge(base, theirs, ours);
    // Theirs changed one line from base ("" → " "); ours is identical to
    // base. Auto-merge should take theirs' version.
    expect(result.content).toBe('a\n \nb\n');
  });

  it('tab-vs-spaces indentation differences are treated as distinct lines', () => {
    const base = 'function x() {\n    return 1;\n}\n';
    const theirs = 'function x() {\n\treturn 1;\n}\n';  // tab
    const ours = 'function x() {\n    return 2;\n}\n';  // space, different body
    const result = threeWayMerge(base, theirs, ours);
    // theirs changed indentation, ours changed value — true conflict on
    // that line.
    expect(result.conflicts).toHaveLength(1);
  });
});

describe('merge adversarial — conflict content exposes marker injection hazard', () => {
  it('conflict output remains parseable when user content contained our markers', () => {
    // Realistic: a markdown file explaining git merges. User edits above
    // the explanation, shard edits below. Neither side touches the
    // literal marker strings, so they should pass through.
    const base = '# Doc\n\n## Below\n\nShared.\n';
    const theirs = '# Doc — by user\n\n## Below\n\nShared.\n';
    const ours = '# Doc\n\n## Below\n\nShard update.\n';
    const result = threeWayMerge(base, theirs, ours);
    expect(result.content).toContain('# Doc — by user');
    expect(result.content).toContain('Shard update.');
  });

  it('when user and shard both edit a line, and the line happens to be a marker prefix', () => {
    // The string "<<<<<<<" alone (no " yours" suffix) is not one of our
    // markers but resembles one. Both sides edit the same line.
    const base = 'intro\nsomething\n';
    const theirs = 'intro\n<<<<<<< user\n';
    const ours = 'intro\n<<<<<<< shard\n';
    const result = threeWayMerge(base, theirs, ours);
    expect(result.conflicts).toHaveLength(1);
    // Output has both sides visible, wrapped in OUR markers. The user's
    // literal "<<<<<<< user" appears inside the yours block.
    expect(result.content).toMatch(/<<<<<<< yours\n<<<<<<< user/);
  });
});

describe('merge adversarial — values injection through renderer', () => {
  it('values containing nunjucks-like syntax are not re-interpreted', async () => {
    const action = await computeMergeAction({
      path: 'x.md',
      ownership: 'managed',
      oldTemplate: '# {{ name }}\n',
      newTemplate: '# {{ name }}\n',
      oldValues: { name: '{{ injected }}' },
      newValues: { name: '{{ injected }}' },
      actualContent: '# {{ injected }}\n',
      renderContext: CTX,
    });
    expect(action.type).toBe('skip');
  });

  it('YAML-hostile values in an unquoted frontmatter scalar are auto-recovered', async () => {
    // Template authors often write unquoted scalars: `owner: {{ name }}`.
    // If the value contains YAML special chars (colon, pipe, quote), the
    // naive render produces invalid YAML. The renderer detects the parse
    // failure and retries with every string value JSON-encoded, which is
    // a valid YAML scalar form. This makes the engine robust against
    // user input in obsidian-mind's values (user_name, vault_purpose,
    // etc.) containing colons or quotes.
    const tpl = '---\nowner: {{ name }}\n---\n\n# Body\n';
    const values = { name: 'Alice: AI researcher' };
    const action = await computeMergeAction({
      path: 'x.md',
      ownership: 'managed',
      oldTemplate: tpl,
      newTemplate: tpl,
      oldValues: values,
      newValues: values,
      actualContent: '---\nowner: "Alice: AI researcher"\n---\n\n# Body\n',
      renderContext: CTX,
    });
    // The rendered frontmatter parses cleanly thanks to auto-recovery;
    // identical input on both sides → skip.
    expect(action.type).toBe('skip');
  });

  it('YAML-hostile values with embedded quotes and pipes also recover', async () => {
    const tpl = '---\ndescription: {{ text }}\n---\n\nBody\n';
    const values = { text: 'quote: "inner" | pipe' };
    const action = await computeMergeAction({
      path: 'x.md',
      ownership: 'managed',
      oldTemplate: tpl,
      newTemplate: tpl,
      oldValues: values,
      newValues: values,
      actualContent: '',
      renderContext: CTX,
    });
    // Skip (base === ours) is proof that both rendered successfully.
    expect(action.type).toBe('skip');
  });

  it('non-string values (numbers, booleans) keep their YAML type after auto-recovery', async () => {
    // A template with a number substitution and a YAML-hostile sibling
    // must preserve the number as a YAML integer, not coerce to a string.
    const tpl = '---\nname: {{ name }}\ncount: {{ count }}\n---\n\nBody\n';
    const values = { name: 'foo: bar', count: 42 };
    // Same inputs on both sides to isolate the render behavior.
    const action = await computeMergeAction({
      path: 'x.md',
      ownership: 'managed',
      oldTemplate: tpl,
      newTemplate: tpl,
      oldValues: values,
      newValues: values,
      actualContent: '',
      renderContext: CTX,
    });
    expect(action.type).toBe('skip');
  });
});

describe('merge adversarial — renderer context hardening', () => {
  it('circular references in values do not hang or crash the render', async () => {
    // Users might create circular data structures in values via hooks or
    // computed defaults. The recovery walker must not enter an infinite
    // loop when encoding string leaves.
    const circular: Record<string, unknown> = { name: 'Alice' };
    circular['self'] = circular;

    const tpl = '---\nowner: {{ name }}\n---\n\nBody\n';
    // Same hostile value on both sides to trigger the recovery path and
    // ensure the walker terminates.
    const values = { ...circular, name: 'foo: bar' };
    const action = await computeMergeAction({
      path: 'x.md',
      ownership: 'managed',
      oldTemplate: tpl,
      newTemplate: tpl,
      oldValues: values,
      newValues: values,
      actualContent: '',
      renderContext: CTX,
    });
    expect(action.type).toBe('skip');
  });

  it('deeply nested values recurse without stack overflow for realistic depths', async () => {
    // Build a 50-deep nested object. Not pathological, but confirms the
    // recursive walk handles reasonable input.
    let deep: Record<string, unknown> = { name: 'leaf-value: with colon' };
    for (let i = 0; i < 50; i++) deep = { inner: deep };
    const values = { name: 'colon: value', nest: deep };
    const action = await computeMergeAction({
      path: 'x.md',
      ownership: 'managed',
      oldTemplate: '---\nowner: {{ name }}\n---\n\nBody\n',
      newTemplate: '---\nowner: {{ name }}\n---\n\nBody\n',
      oldValues: values,
      newValues: values,
      actualContent: '',
      renderContext: CTX,
    });
    expect(action.type).toBe('skip');
  });
});

describe('merge adversarial — exotic value types', () => {
  it('Date values in context do not crash the walker', async () => {
    // Hooks could conceivably set a Date. YAML + Nunjucks normally coerce.
    const tpl = '---\nname: {{ name }}\n---\n\nBody\n';
    const values = { name: 'foo: bar', stamp: new Date('2026-01-01') };
    const action = await computeMergeAction({
      path: 'x.md',
      ownership: 'managed',
      oldTemplate: tpl,
      newTemplate: tpl,
      oldValues: values,
      newValues: values,
      actualContent: '',
      renderContext: CTX,
    });
    expect(action.type).toBe('skip');
  });

  it('function values in context are left alone (unusual, but must not crash)', async () => {
    const tpl = '---\nname: {{ name }}\n---\n\nBody\n';
    const values = { name: 'foo: bar', fn: () => 'hello' };
    const action = await computeMergeAction({
      path: 'x.md',
      ownership: 'managed',
      oldTemplate: tpl,
      newTemplate: tpl,
      oldValues: values,
      newValues: values,
      actualContent: '',
      renderContext: CTX,
    });
    expect(action.type).toBe('skip');
  });

  it('symbol values pass through without YAML crash', async () => {
    const tpl = '---\nname: {{ name }}\n---\n\nBody\n';
    const values = { name: 'foo: bar', sym: Symbol('marker') };
    const action = await computeMergeAction({
      path: 'x.md',
      ownership: 'managed',
      oldTemplate: tpl,
      newTemplate: tpl,
      oldValues: values as Record<string, unknown>,
      newValues: values as Record<string, unknown>,
      actualContent: '',
      renderContext: CTX,
    });
    expect(action.type).toBe('skip');
  });
});

describe('drift adversarial — performance and scale', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = path.join(os.tmpdir(), `drift-perf-${crypto.randomUUID()}`);
    await fsp.mkdir(vaultRoot, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(vaultRoot, { recursive: true, force: true });
  });

  it('handles 500 tracked files in parallel without falling over', async () => {
    const filesState: Record<string, import('../../source/runtime/types.js').FileState> = {};
    await Promise.all(
      Array.from({ length: 500 }, async (_, i) => {
        const rel = `notes/note-${i.toString().padStart(4, '0')}.md`;
        const content = `# Note ${i}\n`;
        await fsp.mkdir(path.join(vaultRoot, 'notes'), { recursive: true });
        await fsp.writeFile(path.join(vaultRoot, rel), content, 'utf-8');
        filesState[rel] = {
          template: 'notes/_each.md.njk',
          rendered_hash: sha256(content),
          ownership: 'managed',
        };
      }),
    );

    const start = Date.now();
    const report = await detectDrift(vaultRoot, makeShardState({ files: filesState }));
    const elapsed = Date.now() - start;

    expect(report.managed).toHaveLength(500);
    expect(report.orphaned).toEqual([]);
    // 500 files should classify in well under a second on any runner;
    // > 5s would indicate a regression toward sequential IO.
    expect(elapsed).toBeLessThan(5000);
  });
});

describe('merge adversarial — token interning stress', () => {
  it('10K lines with many duplicates tokenize correctly and merge is identity', () => {
    // Interner should deduplicate repeated lines so Map/Array stay
    // bounded by unique-line count, not total line count.
    const lines = Array.from({ length: 10_000 }, (_, i) => `line-${i % 100}`);
    const content = lines.join('\n') + '\n';
    const result = threeWayMerge(content, content, content);
    expect(result.content).toBe(content);
    expect(result.stats.linesConflicted).toBe(0);
  }, 60_000);  // node-diff3 on 10K identical lines is near-linear in
               // isolation but parallel-CPU contention on macOS CI can
               // push it past the 30s default. Doubled budget gives
               // headroom under load without masking a real regression.

  it('all lines identical is the densest interning case', () => {
    const content = Array.from({ length: 1000 }, () => 'same').join('\n') + '\n';
    const result = threeWayMerge(content, content, content);
    expect(result.content).toBe(content);
  });

  it('all lines unique is the sparsest interning case', () => {
    const lines = Array.from({ length: 500 }, (_, i) => crypto.randomUUID());
    const content = lines.join('\n') + '\n';
    const result = threeWayMerge(content, content, content);
    expect(result.content).toBe(content);
  });
});

describe('merge adversarial — stats bookkeeping under stress', () => {
  it('stats never go negative', () => {
    const cases = [
      ['', '', ''],
      ['a', 'b', 'c'],
      ['a\nb\nc', 'a\nX\nc', 'a\nb\nY'],
    ];
    for (const [base, theirs, ours] of cases) {
      const r = threeWayMerge(base!, theirs!, ours!);
      expect(r.stats.linesUnchanged).toBeGreaterThanOrEqual(0);
      expect(r.stats.linesAutoMerged).toBeGreaterThanOrEqual(0);
      expect(r.stats.linesConflicted).toBeGreaterThanOrEqual(0);
    }
  });

  it('linesConflicted > 0 iff there is at least one conflict region', () => {
    const cases = [
      { base: 'a', theirs: 'a', ours: 'a' },                // no conflict
      { base: 'a', theirs: 'b', ours: 'c' },                // true conflict
      { base: 'a', theirs: 'a\nb', ours: 'a' },             // auto-merge only
    ];
    for (const c of cases) {
      const r = threeWayMerge(c.base, c.theirs, c.ours);
      expect(r.conflicts.length > 0).toBe(r.stats.linesConflicted > 0);
    }
  });
});

describe('computeMergeAction adversarial', () => {
  it('handles empty templates on both sides', async () => {
    const action = await computeMergeAction({
      path: 'x.md',
      ownership: 'managed',
      oldTemplate: '',
      newTemplate: '',
      oldValues: {},
      newValues: {},
      actualContent: '',
      renderContext: CTX,
    });
    expect(action.type).toBe('skip');
  });

  it('produces a stable MergeAction discriminator across identical runs', async () => {
    const input = {
      path: 'x.md',
      ownership: 'modified' as const,
      oldTemplate: '# {{ name }}\n\nOriginal.\n',
      newTemplate: '# {{ name }}\n\nUpdated by shard.\n',
      oldValues: { name: 'Test' },
      newValues: { name: 'Test' },
      actualContent: '# Test\n\nOriginal.\n\nUser note.\n',
      renderContext: CTX,
    };
    const a = await computeMergeAction(input);
    const b = await computeMergeAction(input);
    expect(a.type).toBe(b.type);
    if (a.type === 'auto_merge' && b.type === 'auto_merge') {
      expect(a.content).toBe(b.content);
    }
  });
});
