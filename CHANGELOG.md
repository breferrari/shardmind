# Changelog

All notable changes to ShardMind will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Project scaffold: Pastel + Ink + tsup + vitest
- `docs/ARCHITECTURE.md` — 22-section architecture spec
- `docs/IMPLEMENTATION.md` — 10-section implementation spec
- `VISION.md` — origin story, architectural bets, scope guardrails
- `ROADMAP.md` — milestones linked to GitHub issues
- `examples/minimal-shard/` — test shard for development
- `source/runtime/types.ts` — 34 shared TypeScript interfaces
- CI/CD: GitHub Actions for typecheck, test, build, npm publish
- **Core engine modules** (v0.1 Milestone 1): manifest, schema, download, renderer, modules, state, registry, install-planner, install-executor, hook, fs-utils, state-migrator, vault-paths
- **Install command** (v0.1 Milestone 2): `shardmind install <shardRef>` with Ink wizard, collision detection + backup/overwrite/cancel, existing-install gate with typed REINSTALL confirm, back-navigation via Esc, computed-default preview, per-module file counts + live total, progress display, SIGINT rollback, `--dry-run` / `--values` / `--yes` / `--verbose` flags
- `docs/AUTHORING.md` — 9-section shard author guide
- `docs/ERRORS.md` — every `ShardMindError` code's meaning, cause, remedy
- `schemas/shard.schema.json` + `schemas/shard-schema.schema.json` — JSON Schema files for editor tooling
- JSDoc on every `shardmind/runtime` public export
- `ShardState.tarball_sha256` — source-drift detection anchor for update command
- State migration framework (`source/core/state-migrator.ts`) for future `schema_version` bumps
- `source/core/vault-paths.ts` — centralized path constants
- `source/core/renderer.ts:buildRenderContext` — shared context builder for install + update
- Reserved-name validation in `parseSchema` (shard, install_date, year, included_modules, values)
- `source/commands/hooks/use-install-machine.ts` — extracted state machine hook

### Changed

- Upgraded `vitest` to `^4.1.4` and `diff` to `^9.0.0` (via `npm audit fix`, zero vulnerabilities).
- Renamed `install-plan.ts` → `install-planner.ts` and `install-runner.ts` → `install-executor.ts` to match I/O concerns.
