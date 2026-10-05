/**
 * Add a spawned CLI's hits to the workers' coverage of the same file (#293).
 *
 * The workers' coverage maps `source/` through vite's transform; the spawned
 * CLI's maps the tsup bundle through its sourcemap. The two agree on most
 * starts but not on all: one statement starts at `const` and the other at its
 * initializer, one function at `export` and the other at its name, and they
 * rarely agree on where an item ends. Merged as two structures, every item
 * would count twice. So the hits move onto the target's own items instead,
 * and the target's totals stay as they were:
 *
 * - A statement or function with hits goes to the innermost target item of
 *   its kind that starts on the same line, no later than it, and whose range
 *   contains its start (the narrowest on a tie). An item that ran means its
 *   enclosing item ran, so the hit never lands on code that did not run.
 * - A branch's hits are per path, and an enclosing branch's paths are other
 *   code, so a branch goes only to a target branch that starts at the same
 *   position, with the same type and number of paths.
 *
 * An item with no such target is dropped and counted in the result.
 */

/** The parts of istanbul's per-file coverage data this reads and writes. */
type Position = { line: number; column: number | null };
type Range = { start: Position; end: Position };
export type FileCoverageData = {
  statementMap: Record<string, Range>;
  s: Record<string, number>;
  fnMap: Record<string, { loc: Range }>;
  f: Record<string, number>;
  branchMap: Record<string, { loc: Range; type: string }>;
  b: Record<string, number[]>;
};

export type TransferResult = { moved: number; dropped: number };

export function transferHits(target: FileCoverageData, source: FileCoverageData): TransferResult {
  const result: TransferResult = { moved: 0, dropped: 0 };
  const tally = (moved: boolean): void => {
    if (moved) result.moved++;
    else result.dropped++;
  };
  transferCounts(target.statementMap, target.s, source.statementMap, source.s, (loc) => loc, tally);
  transferCounts(target.fnMap, target.f, source.fnMap, source.f, (fn) => fn.loc, tally);
  transferBranches(target, source, tally);
  return result;
}

/** Statements or functions: each to the innermost target item containing its start. */
function transferCounts<Item>(
  targetMap: Record<string, Item>,
  targetHits: Record<string, number>,
  sourceMap: Record<string, Item>,
  sourceHits: Record<string, number>,
  rangeOf: (item: Item) => Range,
  tally: (moved: boolean) => void,
): void {
  const index = byLine(Object.entries(targetMap).map(([id, item]) => [id, rangeOf(item)]));
  for (const [id, item] of Object.entries(sourceMap)) {
    const hits = sourceHits[id] ?? 0;
    if (hits === 0) continue;
    const to = innermostContaining(index, rangeOf(item).start);
    if (to !== undefined) targetHits[to] = (targetHits[to] ?? 0) + hits;
    tally(to !== undefined);
  }
}

/** Branches: each to the target branch at the same position, of the same type and arity. */
function transferBranches(target: FileCoverageData, source: FileCoverageData, tally: (moved: boolean) => void): void {
  const key = (br: { loc: Range; type: string }, arms: number): string =>
    `${br.loc.start.line}:${br.loc.start.column ?? 0}:${br.type}:${arms}`;
  const byKey = new Map<string, string>();
  for (const [id, br] of Object.entries(target.branchMap)) {
    const k = key(br, target.b[id]?.length ?? 0);
    // Two target branches with the same key are ambiguous: match neither.
    byKey.set(k, byKey.has(k) ? '' : id);
  }
  for (const [id, br] of Object.entries(source.branchMap)) {
    const arms = source.b[id] ?? [];
    if (!arms.some((h) => h > 0)) continue;
    const to = byKey.get(key(br, arms.length));
    const into = to ? target.b[to] : undefined;
    if (into) arms.forEach((h, i) => (into[i] = (into[i] ?? 0) + h));
    tally(into !== undefined);
  }
}

type Indexed = Map<number, Array<{ id: string; start: number; end: Position }>>;

/** Target items by the line they start on. */
function byLine(items: Array<[string, Range]>): Indexed {
  const index: Indexed = new Map();
  for (const [id, range] of items) {
    const row = index.get(range.start.line) ?? [];
    row.push({ id, start: range.start.column ?? 0, end: range.end });
    index.set(range.start.line, row);
  }
  return index;
}

/**
 * The latest-starting target item on `at`'s line that starts no later than
 * `at` and ends after it (end columns are exclusive; a null one runs to the
 * end of its line). On a tie, the one that ends first: the narrower.
 */
function innermostContaining(index: Indexed, at: Position): string | undefined {
  const column = at.column ?? 0;
  const endOf = (end: Position): number => (end.line > at.line || end.column === null ? Infinity : end.column);
  let best: { id: string; start: number; end: number } | undefined;
  for (const item of index.get(at.line) ?? []) {
    const end = endOf(item.end);
    if (item.start > column || end <= column) continue;
    if (!best || item.start > best.start || (item.start === best.start && end < best.end)) {
      best = { id: item.id, start: item.start, end };
    }
  }
  return best?.id;
}
