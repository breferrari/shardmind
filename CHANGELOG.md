# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Between releases: see `git log` for merged work and [`ROADMAP.md`](ROADMAP.md) for planned work.

<!-- First release: v0.1.0, target end of Milestone 6. -->

## [Unreleased]

### Added

- **Three-way merge engine** (`source/core/drift.ts`, `source/core/differ.ts`). Solves "propagate template updates to existing vaults" — the same problem Backstage (Spotify) has had open for 3+ years and that cruft/create-react-app/Yeoman never solved. Uses `node-diff3`'s Khanna–Myers algorithm via `diff3MergeRegions` for accurate stats.
  - `detectDrift()` classifies every tracked file into `managed / modified / volatile / missing / orphaned` by sha256-comparing disk content against `state.json.rendered_hash`. Orphan detection is non-recursive: parent directories of tracked files become tracked dirs; files in a tracked dir not in `state.files` are orphans. Engine scaffolding (`shard-values.yaml`, `.shardmind/`) and third-party metadata (`.git/`, `.obsidian/`) are excluded.
  - `computeMergeAction()` returns `skip | overwrite | auto_merge | conflict` — skip when `base === ours`, overwrite for managed files, three-way merge for modified files. Conflict markers use git vocabulary: `<<<<<<< yours` / `=======` / `>>>>>>> shard update`.
  - `threeWayMerge()` is a pure primitive — line-based, CRLF-tolerant on input, LF on output.
- **`renderString()` in `source/core/renderer.ts`** — frontmatter-aware render helper for in-memory templates, used by the merge engine to render base/ours without touching disk.
- **Typed `ErrorCode` union** in `source/runtime/errors.ts` — 39 codes grouped by domain; `ShardMindError.code` is now strictly typed. Exported from `shardmind/runtime` for hook consumers.
- **Cross-OS CI matrix** — `{ubuntu, windows, macos} × {node 22, node 24}`, `fail-fast: false`. Windows coverage caught a CRLF regression on first run.
- **20 fixture scenarios** for the merge engine (`tests/fixtures/merge/`) — 17 spec-defined plus 3 edge cases (empty file, UTF-8 non-ASCII, frontmatter-on-modified-ownership merge).
- **Direct unit tests** for merge primitives: `tests/unit/three-way-merge.test.ts` pins down stats accounting; `tests/unit/differ-line-endings.test.ts` covers CRLF robustness; `tests/unit/drift-classification.test.ts` covers every `DriftReport` bucket including orphans.

### Changed

- `ShardMindError.code` typed as `ErrorCode` instead of free-form `string` (compile-time check of every call site).
- `detectDrift` now runs per-file reads in parallel via `Promise.all`, and runs the orphan scan in parallel with the classification.
- `source/runtime/errno.ts` centralizes `errnoCode` / `isEnoent`; 8 copies of the `err instanceof Error && 'code' in err ? ...` pattern collapsed.

### Fixed

- CRLF on Windows-saved user files no longer produces spurious conflicts against LF-rendered base/ours.

### Docs

- `docs/ARCHITECTURE.md` §17 updated: scenario table now shows 20 rows, `§17.4` code sample shows the actual `diff3MergeRegions` algorithm, `§17.5` corrects the frontmatter-merge decision to match implementation (line-merge of rendered YAML, not YAML object deep-merge).
- `docs/IMPLEMENTATION.md` §4.8 documents orphan detection semantics; §4.9 documents the `diff3MergeRegions` variant and CRLF split.
