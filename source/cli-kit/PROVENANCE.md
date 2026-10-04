# cli-kit provenance

The CLI framework from [Pastel](https://github.com/vadimdemedes/pastel) 4.0.1, tag `v4.0.1`, commit `fe4ce10046a55d0492a35b1ae08f54b5c64775e4`, MIT (see `LICENSE`).

Vendored into ShardMind on 2026-10-05 (#277). Pastel depended on `@inkjs/ui`, and through it on `chalk ^5`, which kept a second chalk in every install once Ink moves to `chalk ^6` (#270). ShardMind also patched Pastel's Commander at runtime for option scope (#147). The git history of this folder reads as a diff from upstream:

1. Upstream, byte for byte: the ten files of Pastel's `source/`, and its licence.
2. Adapted to stand alone:
   - `StatusMessage` comes from the ui-kit instead of `@inkjs/ui`;
   - `decamelize` (its default path) and `plur` (its regular rule) are inlined in `lib/`;
   - `read-package-up` is dropped: Pastel read the `package.json` above the current directory to default `name`, `version` and `description`, which ShardMind always passes.
3. Fixed at the source: `lib/program.ts` builds the program with Commander's positional options, and passes root options given before a subcommand on to it (ShardMind #147). It replaces `source/cli-options.ts`, which patched Pastel's Commander at runtime.

`commander` and `zod-validation-error` stay npm dependencies of ShardMind: the first is maintained and not ours to own, and the second's message for a zod issue is real code that the text of an argument error depends on.

Records and licences:
- `VENDOR.json` records the upstream (package, version, tag, commit, tarball integrity) and maps each vendored file to its upstream path, with whether ShardMind changed it and how. Each vendored file's header is generated from it, for `npm run vendor:update` (#280).
- `LICENSE` is Pastel's MIT notice, unchanged, with Brenno Ferrari's copyright added for the modifications.
- `LICENSE-sindresorhus` covers what `lib/decamelize.ts` and `lib/plur.ts` take from `decamelize` and `plur`.

Imports allowed: `ink`, `react`, `commander`, `zod`, `zod-validation-error`, `node:` built-ins, files in this folder, and the ui-kit through `ui-kit/index.ts`.
