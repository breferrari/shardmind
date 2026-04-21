# ShardMind

Package manager for Obsidian vault templates. TypeScript, Pastel + Ink TUI, spec-driven development. The engine is agent-agnostic — shard content determines which AI agents are supported (Claude Code, Codex, Gemini CLI).

## How This Repo Works

This project is **spec-driven**. The architecture and implementation are fully designed before code is written. Claude Code reads the specs and implements them.

### Source of Truth

| Document | What | When to Read |
|----------|------|-------------|
| `VISION.md` | Origin story, architectural bets, scope guardrails, non-goals. | Before proposing features or scope changes. |
| `ROADMAP.md` | v0.1 milestones linked to GitHub issues. Build order. | Before starting a new milestone. |
| `docs/ARCHITECTURE.md` | The what and why. 22 sections. Core concepts, ownership model, schema format, module system, values layer, signals, operations, competitive moat. | Before making any architectural decision. |
| `docs/IMPLEMENTATION.md` | The how, exactly. System diagram, data flows, 10 module specs with TypeScript signatures, algorithms as numbered steps, error cases, 17 merge test fixtures, 6-day build plan. | Before implementing any module. |
| `examples/minimal-shard/` | Minimal test shard for development. 4 values, 2 modules (core + removable), signals, CLAUDE.md partials. | Use this for testing during Days 1-4 before the obsidian-mind shard conversion on Day 5. |

**Read the relevant spec section before writing code.** The specs define inputs, outputs, algorithms, error cases, and test expectations for every module. Don't improvise — implement what the spec says.

### Build Order

Follow `docs/IMPLEMENTATION.md` §9 (Build Plan). Day-by-day, morning/afternoon splits, exact files to create, exact tests to write, verification steps. The order is designed so each piece has its dependencies ready.

| Day | Focus |
|-----|-------|
| 1 | Scaffold + core modules (manifest, schema, download, renderer, modules, runtime) |
| 2 | Install command with full Ink wizard + module review |
| 3 | Merge engine — TDD with 17 fixtures (write fixtures FIRST, then implement) |
| 4 | Update command + status display + verbose mode |
| 5 | obsidian-mind v6 conversion (shard.yaml, .njk templates, TS hooks) |
| 6 | Research-wiki shard, E2E tests, polish, npm publish |

## Tech Stack

| Tool | Purpose |
|------|---------|
| **Pastel** | CLI framework — file-system routing, zod arg parsing, Commander under the hood |
| **Ink** + **@inkjs/ui** | React terminal renderer + pre-built components |
| **React** | Required peer dep for Ink |
| **Nunjucks** | Template engine (`{{ }}` syntax). Config: `autoescape: false` |
| **yaml** (eemeli/yaml) | YAML parsing. TypeScript-typed, comment-preserving |
| **tar** (node-tar) | Tarball download + extraction |
| **semver** | Version parsing, range checking |
| **tsx** | TypeScript loader for post-install / post-update hook subprocess execution |
| **zod** | Schema validation. Shared with Pastel for arg parsing |
| **diff** | Unified diff generation for update previews |
| **node-diff3** | Three-way merge (Khanna-Myers algorithm) |
| **vitest** | Test runner |
| **@sindresorhus/tsconfig** | Pastel's recommended TS config |

## Project Structure

```
shardmind/
├── source/                           # Pastel convention (not src/)
│   ├── cli.ts                        # Pastel entry point (3 lines)
│   ├── commands/
│   │   ├── index.tsx                  # Status display (root command)
│   │   ├── install.tsx                # shardmind install <shard>
│   │   ├── update.tsx                 # shardmind update
│   │   └── hooks/                     # State-machine + shared command hooks
│   │       ├── use-install-machine.ts
│   │       ├── use-update-machine.ts
│   │       ├── use-status-report.ts   # Async loader for status command
│   │       └── shared.ts              # summarizeHook, useSigintRollback
│   ├── components/
│   │   ├── CommandFrame.tsx           # Dry-run banner + keyboard legend
│   │   ├── CommandProgress.tsx        # Shared progress UI (install + update)
│   │   ├── StatusView.tsx             # Quick status (shardmind root command)
│   │   ├── VerboseView.tsx            # Detailed diagnostics (shardmind --verbose)
│   │   ├── InstallWizard.tsx          # Values prompts + module review
│   │   ├── ModuleReview.tsx           # Multiselect for modules
│   │   ├── CollisionReview.tsx        # Install: backup / overwrite / cancel
│   │   ├── ExistingInstallGate.tsx    # Install: existing-install disambiguation
│   │   ├── DiffView.tsx               # Three-way diff + conflict resolution
│   │   ├── NewValuesPrompt.tsx        # Update: prompt for newly required values
│   │   ├── NewModulesReview.tsx       # Update: offer newly optional modules
│   │   ├── RemovedFilesReview.tsx     # Update: per-file keep/delete decision
│   │   ├── HookProgress.tsx           # Live output tail while a post-install/-update hook runs
│   │   ├── HookSummarySection.tsx     # Four-branch hook outcome render, shared by Summary + UpdateSummary
│   │   ├── Summary.tsx                # Final install report
│   │   ├── UpdateSummary.tsx          # Final update report
│   │   ├── ValueInput.tsx             # Typed input widget (string/number/select…)
│   │   ├── Header.tsx                 # Branded header
│   │   └── ui.ts                      # Barrel re-export of @inkjs/ui primitives
│   ├── core/
│   │   ├── manifest.ts                # Parse + validate shard.yaml
│   │   ├── schema.ts                  # Parse shard-schema.yaml → zod validator
│   │   ├── registry.ts                # Resolve shard ref → GitHub URL + version
│   │   ├── download.ts                # Fetch + extract GitHub tarball
│   │   ├── renderer.ts                # Nunjucks + frontmatter-aware rendering
│   │   ├── state.ts                   # Read/write .shardmind/state.json
│   │   ├── state-migrator.ts          # Forward-migrate state.json (v0.2 hook, v0.1 scaffolding)
│   │   ├── drift.ts                   # Ownership detection + drift analysis
│   │   ├── differ.ts                  # Three-way merge (node-diff3)
│   │   ├── migrator.ts                # Apply schema migrations to values
│   │   ├── modules.ts                 # Module resolution + file gating
│   │   ├── update-planner.ts          # Pure update plan from drift + new shard
│   │   ├── update-executor.ts         # Apply update plan with rollback
│   │   ├── install-planner.ts         # Pure install plan + collisions
│   │   ├── install-executor.ts        # Apply install plan with rollback
│   │   ├── values-io.ts               # Shared YAML load for shard-values.yaml
│   │   ├── update-check.ts            # 24h cached latest-version lookup (status + update)
│   │   ├── status.ts                  # Pure StatusReport builder for the status command
│   │   ├── cancellation.ts            # Cross-platform SIGINT bridge (Windows stdin-ETX)
│   │   ├── hook.ts                    # Post-install / post-update hook lookup + subprocess execution
│   │   └── fs-utils.ts                # sha256, pathExists, toPosix, mapConcurrent
│   ├── internal/                      # NOT public API — runtime-spawned helpers
│   │   └── hook-runner.ts             # ESM subprocess entry that imports + invokes a hook
│   ├── runtime/                       # Exported for hook scripts
│   │   ├── index.ts                   # Re-exports
│   │   ├── values.ts                  # loadValues(), validateValues()
│   │   ├── schema.ts                  # loadSchema()
│   │   ├── frontmatter.ts             # validateFrontmatter()
│   │   ├── state.ts                   # loadState(), getIncludedModules()
│   │   ├── vault-paths.ts             # SHARDMIND_DIR, VALUES_FILE, STATE_FILE, …
│   │   ├── errors.ts                  # Typed ErrorCode registry
│   │   ├── errno.ts                   # errnoCode(err), isEnoent(err) helpers
│   │   └── types.ts                   # All shared types + ShardMindError + assertNever
│   └── types/
│       └── index.ts                   # Re-exports from runtime
├── tests/
│   ├── unit/                          # Pure function tests
│   ├── component/                     # Ink components via ink-testing-library
│   ├── integration/                   # Multi-module pipeline tests
│   ├── e2e/                           # Full CLI invocation tests (subprocess)
│   │   ├── cli.test.ts                # 31 scenarios covering all 3 commands + post-install hook
│   │   └── helpers/                   # build-once, tarball, github-stub,
│   │                                  # spawn-cli, vault factories
│   ├── helpers/                       # Shared test utilities (factories)
│   └── fixtures/                      # Test data
│       ├── merge/                     # 20 three-way merge scenarios
│       ├── shards/                    # Pre-built shard tarballs
│       ├── schema/                    # Valid + invalid schemas
│       ├── render/                    # Template rendering scenarios
│       └── migration/                 # Value migration scenarios
├── docs/
│   ├── ARCHITECTURE.md                # The what and why (22 sections)
│   └── IMPLEMENTATION.md              # The how exactly (10 sections)
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Build, Test, and Development Commands

```bash
npm install           # Install deps
npm run build         # tsup build (cli + runtime)
npm run dev           # tsup watch mode
npm test              # vitest run (all tests)
npm run test:watch    # vitest watch
npm run test:merge    # just the merge engine fixtures
npm run typecheck     # tsc --noEmit
```

- If deps are missing or a command fails with "module not found", run `npm install` first, then retry.
- Before pushing: `npm run typecheck && npm test` must both pass.
- Before publishing: `npm run build` must produce clean output in `dist/`.

## Coding Style

- **Language**: TypeScript, ESM, strict mode.
- **Formatting**: follow the existing style in the codebase. No formatter configured yet — consistency by convention.
- **No `any`** except in `source/core/schema.ts` and `source/runtime/values.ts` zod dynamic generation (documented in spec; the runtime copy is a necessary duplicate because `runtime/` can't import from `core/`). Prefer `unknown` + type narrowing everywhere else.
- **No `as unknown as` casts** in `source/` except in `source/commands/hooks/shared.ts::appendHookOutput` — the cast narrows the generic `P extends { kind: string }` to `RunningHookPhase` inside the `kind === 'running-hook'` branch. Both machines' Phase unions intersect `RunningHookPhase`, so the runtime is sound; the cast is what lets the helper be shared across install and update without exposing their internal phase shapes. Documented in place.
- **No `@ts-ignore` or `@ts-nocheck`**. Fix root causes. If a suppression is truly needed, comment why.
- **Prefer `zod`** for validation at external boundaries: shard.yaml parsing, values validation, CLI arg parsing (Pastel handles this).
- **Error handling**: throw `ShardMindError(message, code, hint)`. Commands catch and render via Ink `StatusMessage`. User errors get a message + hint. Engine errors get a full stack trace + "This is a bug, please report." See spec §7.
- **Imports**: use `.js` extension for local imports (ESM requirement). `import { foo } from './bar.js'`.
- **File references** in conversation: always repo-root relative (e.g., `source/core/renderer.ts:45`), never absolute paths.

## Module Boundaries

- `source/core/` — pure logic. No Ink, no React, no TUI. These modules are testable without rendering anything.
- `source/components/` — Ink/React components. Import from `core/` for logic.
- `source/commands/` — Pastel command files (.tsx). Thin orchestration: read args, call core, render components.
- `source/runtime/` — exported for hook scripts. **Zero dependency on Ink, React, or Pastel.** If you import from `ink` or `react` here, the build is broken.
- `source/internal/` — NOT public API. Contains the hook-runner subprocess entry (`hook-runner.ts`) that `core/hook.ts` spawns via `node --import tsx`. Must not be imported at module scope by anything in `source/`; only spawn-paths touch it. Exported from package.json's `exports` under `./internal/hook-runner` so `createRequire` can resolve it at runtime.
- `source/types/` — re-exports from `runtime/types.ts`. Both CLI and runtime import from here.

Do not cross these boundaries:
- Core must not import from components or commands.
- Runtime must not import from core, components, or commands.
- Components can import from core but not from commands.

## Naming

- **Files**: `kebab-case.ts` for core modules, `PascalCase.tsx` for React components.
- **Types/Interfaces**: `PascalCase` (e.g., `ShardManifest`, `DriftReport`).
- **Functions**: `camelCase` (e.g., `parseManifest`, `detectDrift`).
- **Constants**: `SCREAMING_SNAKE_CASE` only for true constants (e.g., `DEFAULT_REGISTRY_URL`).
- **Zod schemas**: `PascalCase` + `Schema` suffix (e.g., `ShardManifestSchema`).

## Conventions

### Pastel/Ink Specific

- **`source/` not `src/`**. Pastel convention. Don't fight it.
- **`.tsx` for commands and components**. `.ts` for everything else.
- **Follow `@sindresorhus/tsconfig`**. It's configured in `tsconfig.json`.
- **One file per command** in `source/commands/`. File name = CLI command name. `index.tsx` = root command (no args).
- **Export `args` and `options` as zod schemas** from command files. Pastel uses them for arg parsing + help generation.
- **React hooks** are fine in components. Keep state minimal — most logic should be in core modules.
- **`<Static>` for completed items**, `<Box>` for live content. See Ink docs for the distinction.

### One File Per Core Module

Each file in `source/core/` maps 1:1 to a section in `docs/IMPLEMENTATION.md`:

| File | Spec Section | Purpose |
|------|-------------|---------|
| `manifest.ts` | §4.3 | Parse + validate shard.yaml |
| `schema.ts` | §4.4 | Parse shard-schema.yaml → zod validator |
| `download.ts` | §4.2 | Fetch + extract GitHub tarball |
| `renderer.ts` | §4.6 | Nunjucks + frontmatter-aware rendering |
| `modules.ts` | §4.5 | Module resolution + file gating |
| `state.ts` | §4.7 | Read/write .shardmind/state.json |
| `registry.ts` | §4.1 | Resolve shard ref → GitHub URL |
| `drift.ts` | §4.8 | Ownership detection + drift analysis |
| `differ.ts` | §4.9 | Three-way merge via node-diff3 |
| `migrator.ts` | §4.10 | Apply schema migrations to values |
| `install-planner.ts` | §4.11a (to land) | Pure install plan (outputs, collisions, value-coercion, computed defaults) |
| `install-executor.ts` | §4.11b (to land) | Apply install plan with transactional backup + rollback |
| `update-planner.ts` | §4.11 | Plan update actions from drift + new-shard render |
| `update-executor.ts` | §4.12 | Apply update plan with snapshot-based rollback |
| `values-io.ts` | §4.13 | Shared YAML load for shard-values.yaml (install + update) |
| `status.ts` | §4.14 | Pure StatusReport builder for the `shardmind` (status) command |
| `update-check.ts` | §4.15 | 24h cached GitHub latest-version lookup shared by status + update |
| `cancellation.ts` | ARCHITECTURE §19.7 | Cross-platform SIGINT bridge (Windows stdin-ETX → process.emit SIGINT) |
| `state-migrator.ts` | §4.7 (v0.2 hook) | Forward-migration framework for `.shardmind/state.json`; scaffolding in v0.1 |
| `hook.ts` | §4.16 | Resolve + execute post-install / post-update hook scripts via bundled `tsx` subprocess (non-fatal) |
| `fs-utils.ts` | (shared utilities) | sha256, pathExists, toPosix, mapConcurrent, stripTemplatePrefix |

Read the spec section before implementing. It has inputs, outputs, algorithm steps, error cases, and test expectations.

### Testing

- **Fixtures before code** for the merge engine. Write all 17 fixture directories (see spec §19.2), then implement until they pass. TDD is mandatory for `drift.ts` and `differ.ts`.
- **Unit tests** for pure functions in `source/core/`. Test files: `tests/unit/<module>.test.ts`.
- **Component tests** for Ink components via `ink-testing-library`. Files: `tests/component/<Component>.test.tsx`.
- **Integration tests** for pipelines: install (temp dir → full vault), update (install → modify → update → verify).
- **E2E tests** for CLI: spawn `dist/cli.js` as a subprocess via `node:child_process` and route through the local GitHub stub (`tests/e2e/helpers/github-stub.ts`). No `execa` dependency; no public network. See `docs/ARCHITECTURE.md §19.7` for the hermetic-E2E methodology.
- Each merge fixture is a self-contained directory with `scenario.yaml`, template files, values files, actual file, and expected output. See `tests/fixtures/merge/01-managed-no-change/` for the pattern.
- **Clean up after tests**: remove temp dirs, don't leak state between tests.
- Run `npm test` before committing. It must be green. In CI, `npm run build` runs before `npm test` so the E2E suite has `dist/cli.js` to spawn.

### Commits

- Conventional commits: `feat:`, `fix:`, `test:`, `docs:`, `refactor:`.
- One module per commit when building. Don't batch unrelated changes.
- Reference the GitHub issue: `feat: core/manifest.ts — parse + validate shard.yaml (#2)`.
- Tests pass before committing.

## Key Architectural Decisions

These are documented fully in `docs/ARCHITECTURE.md`. Quick reference:

| Decision | Choice | Why |
|----------|--------|-----|
| Template engine | Nunjucks | `{{ }}` syntax familiarity. Shard authors know it. |
| CLI framework | Pastel | File-system routing + zod + Commander + Ink. One framework. |
| Three-way merge | node-diff3 | Battle-tested Khanna-Myers. Same approach as git. |
| State locality | Vault-local (.shardmind/) | Same model as git. No global state. |
| Values vs modules | Separate concerns | Values = file content. Modules = file existence. |
| 4 values, 3 commands | Convention over configuration | Obsidian handles unused features gracefully. |
| TypeScript hooks | Unified stack | One language. Hooks import `shardmind/runtime`. |
| Dependencies | Vendored in v0.1 | Shard authors bundle deps. Validated, not fetched. |
| Hook contract | Non-fatal | Hooks enhance but can't break install. Helm pattern. |

## Runtime Module

`shardmind/runtime` is a separately bundled entry point for hook scripts. It has zero dependency on Ink, React, Pastel, or CLI code. ~30KB.

```typescript
import { loadValues, loadState, validateFrontmatter } from 'shardmind/runtime';
```

Build isolation via tsup:

```typescript
// tsup.config.ts
export default {
  entry: {
    cli: 'source/cli.ts',
    'runtime/index': 'source/runtime/index.ts',
  },
  format: ['esm'],
  dts: true,
  splitting: true,  // shared chunks for yaml/zod
};
```

## Package Exports

```json
{
  "name": "shardmind",
  "exports": {
    ".": "./dist/cli.js",
    "./runtime": "./dist/runtime/index.js"
  }
}
```

## Release Process

```bash
# 1. Update CHANGELOG.md: move [Unreleased] items to a new version section
# 2. Bump version + tag + push:
npm run release:patch    # 0.1.0 → 0.1.1
npm run release:minor    # 0.1.0 → 0.2.0
npm run release:major    # 0.1.0 → 1.0.0
```

This triggers `.github/workflows/release.yml`:
- Runs typecheck + test + build
- Publishes to npm with provenance
- Creates GitHub Release with changelog from commits since last tag

**Do not** publish manually with `npm publish`. Always tag and let CI handle it.

## What NOT to Do

- Don't add features not in the spec. If something seems missing, check the spec first — it might be intentionally deferred (see §21 Deferred Items).
- Don't use `any` without documenting why.
- Don't modify `.shardmind/` directory structure without updating the state.ts module and spec.
- Don't add dependencies without checking the spec's dependency list.
- Don't write the merge engine without writing fixtures first. TDD is mandatory for `drift.ts` and `differ.ts`.
- Don't fight Pastel's conventions (source/ not src/, tsx for commands).
