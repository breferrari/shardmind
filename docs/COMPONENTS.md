# Components — iterated UI patterns

> Conventions for Ink components that present a *sequence* of prompts to the user (per-file, per-collision, per-conflict, per-value, etc.). Two valid shapes; mixing them silently is the bug.

This doc exists because of [#109](https://github.com/breferrari/shardmind/issues/109): both `AdoptDiffView` and `DiffView` froze on every prompt after the first, because each held a boolean `useRef(false)` to dedupe `Select.onChange` within a single mount, but their parents (`adopt.tsx`, `update.tsx`) advanced `phase.currentIndex` without passing a `key` prop. React kept the same component instance, `useRef` returned the same object, and the dedup boolean leaked across files.

If a future iterated component picks the same shape without scoping its dedup state to the per-iteration discriminator, the bug recurs.

---

## The two valid shapes

### Pattern A — internal iteration

The component owns the iteration. Parent renders it once with the full work list; the component walks through items via internal `useState(index)`. The inner widget remounts per item via `key={itemKey}`. A boolean dedup ref (`submittedRef`, `completedRef`) only flips on the *terminal* item.

**Used by:** [`RemovedFilesReview`](../source/components/RemovedFilesReview.tsx), [`NewValuesPrompt`](../source/components/NewValuesPrompt.tsx).

```tsx
function MultiPrompt({ items, onSubmit }: Props) {
  const [index, setIndex] = useState(0);
  const submittedRef = useRef(false);
  const item = items[index];
  if (!item) return null;
  return (
    <Select
      key={item.id}                      // remount widget per item
      options={...}
      onChange={(choice) => {
        if (submittedRef.current) return;
        if (index + 1 >= items.length) {
          submittedRef.current = true;   // terminal — flip once
          onSubmit(...);
          return;
        }
        setIndex(index + 1);             // advance internally
      }}
    />
  );
}
```

**When to choose this:** the parent has nothing to do between items — it's just collecting answers and the component can buffer them.

### Pattern B — state-machine iteration

The parent (a state-machine hook in `source/commands/hooks/`) owns iteration. The component receives one item at a time via props; the parent advances by setting `phase.currentIndex++` without passing a `key`. React keeps the same component instance across iterations.

**Used by:** [`AdoptDiffView`](../source/components/AdoptDiffView.tsx), [`DiffView`](../source/components/DiffView.tsx).

The dedup ref **must be scoped to a per-iteration discriminator** from props (the file path, the option id, the row key). Use [`useOncePerKey`](../source/components/use-once-per-key.ts):

```tsx
function PerItemPrompt({ item, onChoice }: Props) {
  const tryFire = useOncePerKey(item.path);
  return (
    <Select
      key={item.path}
      options={...}
      onChange={(choice) => {
        if (!isValidChoice(choice)) return;
        if (!tryFire()) return;          // false on duplicates within same item
        onChoice(choice);
      }}
    />
  );
}
```

When the parent advances `phase.currentIndex`, the new `item.path` doesn't match the recorded key, `tryFire()` returns `true`, and the next item's first interaction goes through.

**When to choose this:** the parent needs to do real work between items (e.g. apply a write before showing the next prompt, run a validation, persist intermediate state). The state machine is the natural sequencer.

---

## Anti-pattern: boolean `useRef` without per-iteration scope

```tsx
// ✗ Wrong when the parent iterates without a key
function PerItemPrompt({ item, onChoice }: Props) {
  const firedRef = useRef(false);
  return (
    <Select
      key={item.path}                    // doesn't help — the inner widget remounts,
                                         // but firedRef sits on the OUTER component,
                                         // which the parent doesn't remount
      onChange={(choice) => {
        if (firedRef.current) return;    // leaks `true` to next item
        firedRef.current = true;
        onChoice(choice);
      }}
    />
  );
}
```

This is exactly the shape both diff views had before #109. The inner `Select` remounting (because of `key={item.path}`) resets the widget's *cursor* state, but doesn't reach the outer component's refs. The dedup boolean stays `true`, and every prompt after the first is rejected at the guard.

If you find yourself writing `firedRef = useRef(false)` inside a component that's rendered in a parent's `currentIndex`-advance loop: stop. Either switch to Pattern A (internal iteration) or use `useOncePerKey` (Pattern B).

---

## Single-mount dedup is fine

`useRef(false)` is the right pattern for components that mount once per command (or once per phase) and never iterate. These are not affected:

- [`CollisionReview`](../source/components/CollisionReview.tsx) — one screen, one decision per install.
- [`ExistingInstallGate`](../source/components/ExistingInstallGate.tsx) — one decision per install.
- [`NewModulesReview`](../source/components/NewModulesReview.tsx) — one screen.
- The three confirm/continue `Select`s inside [`InstallWizard`](../source/components/InstallWizard.tsx).

The boolean ref is the simplest correct shape here. Don't migrate to `useOncePerKey` for migration's sake — the two patterns are semantically distinct and conflating them would obscure the iteration risk.

---

## Testing iterated components

Every component rendered inside a parent's iteration loop **must** have a regression test that re-renders the same root with a new iteration prop and asserts the next iteration's interaction fires. `ink-testing-library`'s [`rerender(...)`](https://github.com/vadimdemedes/ink-testing-library) is the right tool — it models exactly the production render shape that #109's bug lived in.

```tsx
it('fires for the next item after the parent advances without remounting', async () => {
  const onChoice = vi.fn();
  const r = render(<PerItemPrompt item={item1} onChoice={onChoice} />);
  await tick(30);
  r.stdin.write(ENTER);
  await waitForCall(onChoice);

  // Parent advances — no key prop, same instance.
  r.rerender(<PerItemPrompt item={item2} onChoice={onChoice} />);
  await tick(30);
  r.stdin.write(ENTER);
  await waitFor(() => (onChoice.mock.calls.length >= 2 ? 'ok' : ''), (f) => f === 'ok');

  expect(onChoice).toHaveBeenCalledTimes(2);
});
```

Existing same-mount double-fire tests (`expect(onChoice).toHaveBeenCalledTimes(1)` after a single `ENTER`) still belong — they pin the in-mount dedup. They don't pin the cross-iteration shape; the `rerender` test does.

See `tests/component/AdoptDiffView.test.tsx` and `tests/component/DiffView.test.tsx` for the canonical examples; `tests/component/use-once-per-key.test.tsx` exercises the hook directly.

---

## Quick decision tree

```
Is your component rendered once per command, no iteration?
  → useRef(false) is fine. Stop here.

Is your component the iterator (owns useState(index))?
  → Pattern A. Inner widget keyed on per-item key.
    Dedup ref flipped only on terminal item.

Is your component an iteration step (parent advances state machine)?
  → Pattern B. Use useOncePerKey(itemKey).
    Add a rerender() regression test.
```
