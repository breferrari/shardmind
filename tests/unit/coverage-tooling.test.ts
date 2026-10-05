/**
 * The coverage run's own tooling (#293): moving a spawned CLI's hits onto the
 * workers' coverage, compacting its raw V8 coverage, and telling a coverage
 * run from a plain one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transferHits, type FileCoverageData } from '../coverage-run/transfer-hits.js';
import { compactSubprocessCoverage, COMPACTED_PREFIX } from '../coverage-run/compact-coverage.js';
import { resetSubprocessCoverageDir } from '../coverage-run/coverage-run.js';

const at = (line: number, column: number, endColumn: number | null = null) => ({
  start: { line, column },
  end: { line, column: endColumn },
});

/** Two statements on line 3, one on line 5; a function on line 2; a two-arm branch on line 4. */
function target(): FileCoverageData {
  return {
    statementMap: { '0': at(3, 2, 10), '1': at(3, 12, 20), '2': at(5, 4, 9) },
    s: { '0': 1, '1': 0, '2': 0 },
    fnMap: { '0': { loc: at(2, 9, 14) } },
    f: { '0': 1 },
    branchMap: { '0': { loc: at(4, 2, 30), type: 'if' } },
    b: { '0': [1, 0] },
  };
}

function totals(data: FileCoverageData) {
  return [Object.keys(data.statementMap).length, Object.keys(data.fnMap).length, Object.keys(data.branchMap).length];
}

describe('transferHits (#293)', () => {
  it('adds each hit to the target item on its line whose range contains its start', () => {
    const to = target();
    // Ends differ (null vs a column), and starts are off by a column or two, as
    // vite's and tsup's mappings of the same source are.
    const result = transferHits(to, {
      statementMap: { a: at(3, 13), b: at(5, 4) },
      s: { a: 2, b: 3 },
      fnMap: { a: { loc: at(2, 13) } }, // an arrow function: `async (x)` vs `x`
      f: { a: 4 },
      branchMap: { a: { loc: at(4, 2), type: 'if' } },
      b: { a: [0, 5] },
    });
    expect(to.s).toEqual({ '0': 1, '1': 2, '2': 3 });
    expect(to.f).toEqual({ '0': 5 });
    expect(to.b).toEqual({ '0': [1, 5] });
    expect(result).toEqual({ moved: 4, dropped: 0 });
  });

  it('picks the innermost containing item, and never a neighbour that does not contain it', () => {
    const to: FileCoverageData = {
      statementMap: { whole: at(3, 2, null), inner: at(3, 12, 20) },
      s: { whole: 1, inner: 0 },
      fnMap: {},
      f: {},
      branchMap: {},
      b: {},
    };
    // 3:14 lies in both: the inner one takes it. 3:25 lies only in the
    // statement that runs to the end of the line: that one ran, so it is
    // credited, and the inner one, which ends at 20, is not.
    const result = transferHits(to, {
      statementMap: { a: at(3, 14), b: at(3, 25) },
      s: { a: 2, b: 3 },
      fnMap: {},
      f: {},
      branchMap: {},
      b: {},
    });
    expect(to.s).toEqual({ whole: 4, inner: 2 });
    expect(result).toEqual({ moved: 2, dropped: 0 });
  });

  it('drops an item that no target item contains, even with one nearby on its line', () => {
    const to = target();
    // Line 3's statements end at 10 and 20; 3:25 is in neither.
    const result = transferHits(to, { statementMap: { a: at(3, 25) }, s: { a: 1 }, fnMap: {}, f: {}, branchMap: {}, b: {} });
    expect(result).toEqual({ moved: 0, dropped: 1 });
    expect(to).toEqual(target());
  });

  it('takes the narrower of two items that start together, and treats an end as exclusive', () => {
    const to: FileCoverageData = {
      // `return;` ends at 9 (exclusive) where `foo()` starts; an expression
      // statement and its call start together at 12.
      statementMap: { ret: at(3, 2, 9), foo: at(3, 9, 14), stmt: at(3, 12, 30), call: at(3, 12, 20) },
      s: { ret: 0, foo: 0, stmt: 0, call: 0 },
      fnMap: {},
      f: {},
      branchMap: {},
      b: {},
    };
    transferHits(to, { statementMap: { a: at(3, 9), b: at(3, 15) }, s: { a: 1, b: 1 }, fnMap: {}, f: {}, branchMap: {}, b: {} });
    expect(to.s).toEqual({ ret: 0, foo: 1, stmt: 0, call: 1 });
  });

  it('moves a branch only onto the branch at the same position, type and arity', () => {
    // `x = a ? (b ? 1 : 2) : 3`, with the bundle's inner ternary one column
    // off; and `a || b ? x : y`, a ternary and a logical starting together.
    const to: FileCoverageData = {
      statementMap: {},
      s: {},
      fnMap: {},
      f: {},
      branchMap: {
        outer: { loc: at(5, 4, 24), type: 'cond-expr' },
        inner: { loc: at(5, 9, 19), type: 'cond-expr' },
        tern: { loc: at(6, 0, 14), type: 'cond-expr' },
        logic: { loc: at(6, 0, 6), type: 'binary-expr' },
      },
      b: { outer: [0, 0], inner: [0, 0], tern: [0, 0], logic: [0, 0] },
    };
    const result = transferHits(to, {
      statementMap: {},
      s: {},
      fnMap: {},
      f: {},
      branchMap: { off: { loc: at(5, 8), type: 'cond-expr' }, l: { loc: at(6, 0), type: 'binary-expr' } },
      b: { off: [0, 5], l: [1, 1] },
    });
    // The off-by-one inner ternary is dropped, not credited to the outer one's
    // paths; the logical's hits go to the logical, not the ternary.
    expect(to.b).toEqual({ outer: [0, 0], inner: [0, 0], tern: [0, 0], logic: [1, 1] });
    expect(result).toEqual({ moved: 1, dropped: 1 });
  });

  it('never adds an item: the totals stay those of the target', () => {
    const to = target();
    const before = totals(to);
    transferHits(to, {
      statementMap: { a: at(3, 2), b: at(3, 3), c: at(5, 0) },
      s: { a: 1, b: 1, c: 1 },
      fnMap: {},
      f: {},
      branchMap: {},
      b: {},
    });
    expect(totals(to)).toEqual(before);
  });

  it('drops an item with nothing on its line, and a branch whose arm count differs', () => {
    const to = target();
    const result = transferHits(to, {
      statementMap: { a: at(9, 0) },
      s: { a: 1 },
      fnMap: { a: { loc: at(7, 0) } },
      f: { a: 1 },
      branchMap: { a: { loc: at(4, 2), type: 'if' } },
      b: { a: [1, 1, 1] },
    });
    expect(result).toEqual({ moved: 0, dropped: 3 });
    expect(to).toEqual(target());
  });

  it('ignores items the subprocess never ran', () => {
    const to = target();
    const result = transferHits(to, {
      statementMap: { a: at(9, 0) },
      s: { a: 0 },
      fnMap: { a: { loc: at(2, 9) } },
      f: { a: 0 },
      branchMap: { a: { loc: at(4, 2), type: 'if' } },
      b: { a: [0, 0] },
    });
    expect(result).toEqual({ moved: 0, dropped: 0 });
    expect(to).toEqual(target());
  });
});

describe('compactSubprocessCoverage (#293)', () => {
  const DIST = 'file:///repo/dist/';
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shardmind-cov-compact-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, body: string) => fs.writeFileSync(path.join(dir, name), body);
  const script = (url: string) => ({ scriptId: '1', url, functions: [{ functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 9, count: 1 }] }] });

  it('keeps only the dist/ entries of a raw file, renamed so later sweeps skip it', () => {
    const raw = { result: [script(`${DIST}cli.js`), script('file:///repo/node_modules/ink/index.js'), script('node:internal/x'), script(`${DIST}chunk-A.js`)] };
    write('coverage-1-2-0.json', JSON.stringify(raw));

    compactSubprocessCoverage({ dir, ownDir: dir, distPrefix: DIST });

    expect(fs.readdirSync(dir)).toEqual([`${COMPACTED_PREFIX}coverage-1-2-0.json`]);
    const kept = JSON.parse(fs.readFileSync(path.join(dir, `${COMPACTED_PREFIX}coverage-1-2-0.json`), 'utf-8')) as typeof raw;
    expect(kept.result.map((s) => s.url)).toEqual([`${DIST}cli.js`, `${DIST}chunk-A.js`]);
    expect(kept.result[0]).toEqual(raw.result[0]);
  });

  it('deletes a file with no dist/ entries', () => {
    write('coverage-3-4-0.json', JSON.stringify({ result: [script('file:///repo/node_modules/tsx/index.js')] }));
    compactSubprocessCoverage({ dir, ownDir: dir, distPrefix: DIST });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('leaves a file that does not parse yet, and a compacted one, as they are', () => {
    write('coverage-5-6-0.json', '{"result": [');
    const compacted = JSON.stringify({ result: [script(`${DIST}cli.js`)] });
    write(`${COMPACTED_PREFIX}coverage-7-8-0.json`, compacted);

    compactSubprocessCoverage({ dir, ownDir: dir, distPrefix: DIST });

    expect(fs.readdirSync(dir).sort()).toEqual(['coverage-5-6-0.json', `${COMPACTED_PREFIX}coverage-7-8-0.json`]);
    expect(fs.readFileSync(path.join(dir, `${COMPACTED_PREFIX}coverage-7-8-0.json`), 'utf-8')).toBe(compacted);
  });

  it('does nothing outside a coverage run', () => {
    write('coverage-9-9-0.json', JSON.stringify({ result: [script('file:///elsewhere.js')] }));
    compactSubprocessCoverage({ dir: null, ownDir: dir, distPrefix: DIST });
    expect(fs.readdirSync(dir)).toEqual(['coverage-9-9-0.json']);
  });

  it("leaves another tool's NODE_V8_COVERAGE directory untouched", () => {
    write('coverage-9-9-0.json', JSON.stringify({ result: [script('file:///elsewhere.js')] }));
    compactSubprocessCoverage({ dir, ownDir: path.join(dir, 'not-this-one'), distPrefix: DIST });
    expect(fs.readdirSync(dir)).toEqual(['coverage-9-9-0.json']);
  });
});

describe('the v8 provider internals the coverage provider uses (#293)', () => {
  // subprocess-provider.ts calls these; an upgrade of @vitest/coverage-v8
  // that renames or reshapes them must fail here, not in a silent report.
  it('still has remapCoverage(filename, wrapperLength, result, functions)', async () => {
    const { V8CoverageProvider } = await import('@vitest/coverage-v8/dist/provider.js');
    const remap = Reflect.get(V8CoverageProvider.prototype, 'remapCoverage') as unknown;
    expect(typeof remap).toBe('function');
    expect((remap as (...args: unknown[]) => unknown).length).toBe(4);
  });
});

describe('resetSubprocessCoverageDir (#293)', () => {
  it('empties the directory a coverage run starts from, and creates it when missing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shardmind-cov-reset-'));
    try {
      const dir = path.join(root, '.subprocess');
      await resetSubprocessCoverageDir(dir);
      expect(fs.readdirSync(dir)).toEqual([]);
      fs.writeFileSync(path.join(dir, 'dist-coverage-1-2-0.json'), '{"result":[]}');
      await resetSubprocessCoverageDir(dir);
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
