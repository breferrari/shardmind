# ui-kit provenance

`Select`, `TextInput`, `Alert`, `Badge`, `ProgressBar`, `Spinner` and `StatusMessage` from [`@inkjs/ui`](https://github.com/vadimdemedes/ink-ui) 2.0.0, tag `v2.0.0`, commit `14b1145da0123a48cfc2f0ec9ff33dff0633f464`, MIT (see `LICENSE`).

`Select` and `TextInput` were vendored into ShardMind on 2026-10-04 (#43): upstream has been frozen since 2024-05-22, and its bugs needed local workarounds. The other five followed on 2026-10-05 (#273), so ShardMind neither imports nor depends on `@inkjs/ui` any more. Pastel, which depended on it too, is vendored as the cli-kit (#277). The git history of this folder reads as a diff from upstream.

1. Upstream, byte for byte, in one commit for each issue:
   - #43: `components/select`, `components/text-input`, `lib/option-map.ts`, `theme.tsx`, `types.ts`;
   - #273: `components/alert`, `components/badge`, `components/progress-bar`, `components/spinner`, `components/status-message`.
2. Adapted to stand alone:
   - `theme.tsx` holds only these components, with no `deepmerge` and no `any`;
   - `figures` became `lib/figures.ts`: the glyphs the components draw, with `is-unicode-supported` 2.1.0's rule for falling back. The rule is a copy, so a terminal upstream adds later has to be added here by hand;
   - `cli-spinners` became `lib/spinners.ts`: the `dots` frames. `SpinnerName` is the union of its keys, so a new frame set is a non-breaking widening;
   - `TextInput` renders its cursor and placeholder as Ink `Text` segments instead of `chalk` strings;
   - the theme parameters are typed;
   - there is no default `React` import;
   - `index.ts` is the entry point.
3. Fixes, each its own commit, named by issue:
   - `Select` fires `onChange` on Enter for the seeded default (ShardMind #103);
   - `TextInput` does not fire `onChange` on a parent re-render (vadimdemedes/ink-ui#26);
   - `Select` starts with focus on its `defaultValue`, scrolled into view (upstream always focused the first option);
   - `Select` reads its choice from the reducer on Enter, so keys typed ahead in the same input chunk count.

The status widgets carry no behaviour change: `tests/ui-kit/upstream-frames.test.tsx` holds the frames `@inkjs/ui` drew for each variant ShardMind uses, colour included, and the vendored copies must draw the same.

Licences:
- `LICENSE` is `@inkjs/ui`'s MIT notice, unchanged, with Brenno Ferrari's copyright added for the modifications.
- `LICENSE-sindresorhus` covers what `lib/figures.ts` takes from `figures` and `is-unicode-supported`, and what `lib/spinners.ts` takes from `cli-spinners`.
- Each vendored file names its origin in a header, and the files ShardMind changed add a "Modified by" line saying what changed.

Imports allowed: `ink`, `react`, `node:` built-ins, and files in this folder.
