import { useRef } from 'react';

/**
 * Allow exactly one action per distinct `currentKey` over the lifetime of
 * a component instance. Returns a `tryFire` function that returns `true`
 * the first time it is called for a given key (and records the key), and
 * `false` for any subsequent call with the same key.
 *
 * Use case: a component is rendered inside a parent loop where the parent
 * advances iteration via state-machine props (e.g. `phase.currentIndex`)
 * without remounting the child via a `key` prop. A boolean `useRef(false)`
 * to dedupe a callback within a single mount would leak `true` across
 * iterations because React keeps the same component instance and `useRef`
 * returns the same object — every prompt after the first would freeze.
 *
 * Scoping the ref to a per-iteration discriminator from props (the file
 * path, the option ID, the row key) sidesteps that trap: when the parent
 * advances, the new key doesn't match the recorded one, and `tryFire`
 * returns `true` for the next iteration without requiring the parent to
 * pass a `key` prop.
 *
 * Companion convention: see `docs/COMPONENTS.md` for when this pattern
 * (Pattern B) is appropriate vs. internal-iteration with a per-item
 * widget key (Pattern A, see `RemovedFilesReview` / `NewValuesPrompt`).
 *
 * Equality is reference (`===`). Pass primitive keys (strings, numbers).
 * Object keys would only collapse on identity, which is rarely what the
 * caller intends.
 *
 * @example
 * function PerFilePrompt({ path, onChoice }: Props) {
 *   const tryFire = useOncePerKey(path);
 *   return (
 *     <Select
 *       onChange={(choice) => {
 *         if (!isValidChoice(choice)) return;
 *         if (!tryFire()) return;
 *         onChoice(choice);
 *       }}
 *     />
 *   );
 * }
 */
export function useOncePerKey<K>(currentKey: K): () => boolean {
  const lastFiredKeyRef = useRef<K | null>(null);
  return () => {
    if (lastFiredKeyRef.current === currentKey) return false;
    lastFiredKeyRef.current = currentKey;
    return true;
  };
}
