# ui-kit provenance

`Select` and `TextInput` from [`@inkjs/ui`](https://github.com/vadimdemedes/ink-ui) 2.0.0, tag `v2.0.0`, commit `14b1145da0123a48cfc2f0ec9ff33dff0633f464`, MIT (see `LICENSE`).

Vendored into ShardMind on 2026-10-04 (#43), because upstream has been frozen since 2024-05-22 and two of its bugs needed local workarounds. The git history of this folder reads as a diff from upstream:

1. Upstream, byte for byte: `components/select`, `components/text-input`, `lib/option-map.ts`, `theme.tsx`, `types.ts`.
2. Adapted to stand alone:
   - `theme.tsx` is cut to these two components, with no `deepmerge` and no `any`;
   - `figures` became `lib/figures.ts` (two glyphs, with the same Unicode fallback);
   - `TextInput` renders its cursor and placeholder as Ink `Text` segments instead of `chalk` strings;
   - the theme parameters are typed;
   - `index.ts` is the entry point.
3. Fixes, each its own commit, named by issue:
   - `Select` fires `onChange` on Enter for the seeded default (ShardMind #103);
   - `TextInput` does not fire `onChange` on a parent re-render (vadimdemedes/ink-ui#26).

Imports allowed: `ink`, `react`, `node:` built-ins, and files in this folder.
