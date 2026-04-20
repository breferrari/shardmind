# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Between releases: see `git log` for merged work and [`ROADMAP.md`](ROADMAP.md) for planned work.

<!-- First release: v0.1.0, target end of Milestone 6. -->

## [Unreleased]

### Added

- **`shardmind update` command** — the feature the three-way merge engine was built to serve. Full pipeline: fetch new shard → apply schema migrations → prompt only for newly required values → offer newly optional modules → decide per-file fate for modified files the new shard no longer ships → three-way merge every modified file in parallel → resolve conflicts via `DiffView` → snapshot-and-write → post-update hook → summary. Any failure between snapshot and state-write walks the snapshot back; the vault is indistinguishable from pre-update.
  - `source/core/migrator.ts` — `applyMigrations(values, current, target, migrations)` transforms `shard-values.yaml` across versions. Filter rule is `currentVersion < from_version ≤ targetVersion` (idempotent: re-running an upgrade at the same target version picks up nothing). Four change types (`rename` / `added` / `removed` / `type_changed`); `rename` refuses to clobber an existing target value — warns and keeps both keys instead of destroying user data.
  - `source/core/update-planner.ts` — pure planner. Inputs grouped as `{ vault, values, newShard, removedFileDecisions }` so call sites can't accidentally mix fields from two different shards. Emits `UpdatePlan` with 10 action variants (`overwrite / auto_merge / conflict / noop / skip_volatile / add / restore_missing / delete / keep_as_user`) plus a `pendingConflicts` queue for the state machine to drive. Per-modified-file merges run in parallel via `mapConcurrent(drift.modified, 16, …)`. `theirsHash` is captured at plan time and threaded through to the executor so `keep_mine`/`skip` resolutions don't need to re-read + re-hash the file.
  - `source/core/update-executor.ts` — applies the plan with snapshot-based rollback. Backup directory allocation is collision-safe under same-millisecond concurrent updates (ISO timestamp retains ms, then a numeric suffix is probed if EEXIST). Snapshot copies the plan's touched files plus `.shardmind/state.json`, cached manifest + schema + templates in parallel (`SNAPSHOT_CONCURRENCY=16`). Write pass runs before delete pass so a rename-style move (delete + add at a different path) can't clobber the incoming file.
  - `source/core/values-io.ts` — one YAML reader for both install's `--values` prefill and update's canonical `shard-values.yaml` load. Install filters unknown keys against the schema; update keeps everything so migrations can handle the shape change. Same read → parse → type-check code path.
  - `source/commands/update.tsx` + `source/commands/hooks/use-update-machine.ts` — state machine with phases `booting → loading → (no-install | up-to-date | prompt-new-values → prompt-new-modules → prompt-removed-files → resolving-conflicts) → writing → summary`. Mirrors the `useInstallMachine` pattern.
  - `source/commands/hooks/shared.ts` — `summarizeHook` and `useSigintRollback` shared across install + update. SIGINT always runs the tempdir cleanup (plugging a leak where cancelling during the prompt/wizard phase left the extracted shard on disk).
  - 6 new Ink components: `DiffView` (three-way conflict with ±3 context lines, color-coded yours/shard, CRLF-tolerant), `NewValuesPrompt`, `NewModulesReview`, `RemovedFilesReview`, `UpdateSummary`, plus `CommandFrame` (dry-run banner + keyboard legend, shared with install) and `CommandProgress` (renamed from `InstallProgress`, now used by both commands).
  - Six new error codes typed in `source/runtime/errors.ts`: `UPDATE_NO_INSTALL`, `UPDATE_SOURCE_MISMATCH`, `UPDATE_CACHE_MISSING`, `UPDATE_WRITE_FAILED`, `MIGRATION_INVALID_VERSION`, `MIGRATION_TRANSFORM_FAILED`.
  - Flags: `--yes` (auto-accept every prompt; auto-keep conflicts; include every new optional module), `--verbose` (per-file action history during write), `--dry-run` (plan + summarize without touching the vault or allocating a backup).
- **Adversarial test harness for the update stack** — matches the merge engine's bar. 18 migrator adversarial tests (prototype-key pollution, non-Error throws, unserializable transforms, BOM + null bytes, cyclic value graphs, pre-release + build-metadata semver, chained renames) plus 4 `fast-check` property tests × 200 runs = 800 generative scenarios. 11 update-planner + executor adversarial tests (missing cached template → `conflictFromDirect` fallback, iterator array shrink cleanup, CRLF on user files, Unicode + emoji filenames, inconsistent state + drift inputs, concurrent `createBackupDir` calls, `rollbackUpdate` idempotency, render determinism property). All 62 new tests brought the suite from 341 to 403 passing.
- **6 component tests** for the new Ink components (`DiffView`, `CommandFrame`, `NewValuesPrompt`, `NewModulesReview`, `RemovedFilesReview`, `UpdateSummary`) using `ink-testing-library`. Component tests caught a double-submit bug in `RemovedFilesReview` and `NewValuesPrompt` where a re-entrant render would fire `onComplete` twice; both components now guard via a `submittedRef` + per-file `Select` remount.
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

- `InstallProgress` renamed to `CommandProgress`; both install and update commands render it. Callers should import from `source/components/CommandProgress.js`.
- `mapConcurrent` moved from `source/core/drift.ts` to `source/core/fs-utils.ts` so planner and executor can share the bounded-concurrency primitive.
- `CommandFrame` extracted — was `RootFrame` in `install.tsx` and `Frame` in `update.tsx`. Single component owns the dry-run banner + keyboard legend.
- `ShardMindError.code` typed as `ErrorCode` instead of free-form `string` (compile-time check of every call site).
- `detectDrift` now runs per-file reads in parallel via `Promise.all`, and runs the orphan scan in parallel with the classification.
- `source/runtime/errno.ts` centralizes `errnoCode` / `isEnoent`; 8 copies of the `err instanceof Error && 'code' in err ? ...` pattern collapsed.

### Fixed

- `rename` migration no longer silently overwrites an existing value at the target key. If both the old and new keys have values, the migrator warns and keeps both (the user picks which to drop manually). Previously this was a silent data-loss bug found by the adversarial audit.
- `createBackupDir` allocates distinct backup directories even when called twice in the same millisecond. Previous timestamp stripped the fractional seconds, so two near-simultaneous updates could share a backup dir and clobber each other's rollback snapshots.
- `keep_as_user` decisions now untrack the file from `state.files` on apply. The file stays on disk (as the user asked), but the engine no longer considers it managed on future updates — matches the UI's "Keep my edits (untrack)" label.
- `DiffView` splits on `/\r?\n/` everywhere to match `differ.ts`'s canonical line splitter. Previously, CRLF content left `\r` in the output strings and Ink's renderer treated them as cursor-moving carriage returns, corrupting the terminal display.
- `conflictFromDirect` now receives the new-shard tempdir and produces a cache-relative `templateKey` instead of an absolute path. The fallback fires only on corrupt / missing cached templates, but when it did fire the state it wrote couldn't be re-used by subsequent updates.
- SIGINT now runs the shard tempdir cleanup regardless of which phase was active. Previously, cancelling with Ctrl-C during the wizard/prompt phases left the extracted tarball in the OS temp directory until the next reboot.
- CRLF on Windows-saved user files no longer produces spurious conflicts against LF-rendered base/ours.

### Docs

- `docs/IMPLEMENTATION.md` §3 — Update data flow diagram rewritten to match the actual `useUpdateMachine` phase progression, including the three discrete prompt phases (new values, new modules, removed files) and the explicit rollback branch.
- `docs/IMPLEMENTATION.md` §4.10 — corrected migration filter rule (`currentVersion < from_version ≤ targetVersion`), added the "rename refuses to clobber existing target" invariant, added the `MIGRATION_INVALID_VERSION` throw.
- `docs/IMPLEMENTATION.md` §4.11, §4.12, §4.13 — new module specs for `update-planner.ts`, `update-executor.ts`, `values-io.ts` matching the §4.x style of the existing engine modules.
- `docs/IMPLEMENTATION.md` §6.5 — DiffView props updated to reflect `index` / `total` / `result` (not `mergeResult`), the `DiffAction` union, CRLF handling, and the v0.2 editor stub.
- `docs/IMPLEMENTATION.md` §7 — error handling table adds the six new update + migration error codes.
- `docs/ARCHITECTURE.md` §10.5 — update flow expanded to cover the new flags (`--yes`, `--verbose`, `--dry-run`), the removed-files decision prompt, and the snapshot/rollback guarantee. References `§4.11` / `§4.12` in IMPLEMENTATION for detailed algorithms.
- `CLAUDE.md` — module table includes `update-planner.ts` / `update-executor.ts` / `values-io.ts`; source tree diagram updated with new components and the `commands/hooks/` directory.
- `docs/ARCHITECTURE.md` §17 updated: scenario table now shows 20 rows, `§17.4` code sample shows the actual `diff3MergeRegions` algorithm, `§17.5` corrects the frontmatter-merge decision to match implementation (line-merge of rendered YAML, not YAML object deep-merge).
- `docs/IMPLEMENTATION.md` §4.8 documents orphan detection semantics; §4.9 documents the `diff3MergeRegions` variant and CRLF split.
