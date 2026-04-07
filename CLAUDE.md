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
| 5 | obsidian-mind v4 conversion (shard.yaml, .njk templates, TS hooks) |
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
│   │   └── update.tsx                 # shardmind update
│   ├── components/
│   │   ├── StatusView.tsx             # Quick status
│   │   ├── VerboseView.tsx            # Detailed diagnostics (--verbose)
│   │   ├── InstallWizard.tsx          # Values prompts + module review
│   │   ├── ModuleReview.tsx           # Multiselect for modules
│   │   ├── DiffView.tsx               # Three-way diff display
│   │   └── Header.tsx                 # Branded header
│   ├── core/
│   │   ├── manifest.ts                # Parse + validate shard.yaml
│   │   ├── schema.ts                  # Parse shard-schema.yaml → zod validator
│   │   ├── registry.ts                # Resolve shard ref → GitHub URL + version
│   │   ├── download.ts                # Fetch + extract GitHub tarball
│   │   ├── renderer.ts                # Nunjucks + frontmatter-aware rendering
│   │   ├── state.ts                   # Read/write .shardmind/state.json
│   │   ├── drift.ts                   # Ownership detection + drift analysis
│   │   ├── differ.ts                  # Three-way merge (node-diff3)
│   │   ├── migrator.ts                # Apply schema migrations to values
│   │   └── modules.ts                 # Module resolution + file gating
│   ├── runtime/                       # Exported for hook scripts
│   │   ├── index.ts                   # Re-exports
│   │   ├── values.ts                  # loadValues()
│   │   ├── schema.ts                  # loadSchema()
│   │   ├── frontmatter.ts             # validateFrontmatter()
│   │   ├── state.ts                   # loadState(), getIncludedModules()
│   │   └── types.ts                   # All shared types
│   └── types/
│       └── index.ts                   # Re-exports from runtime
├── tests/
│   ├── unit/                          # Pure function tests
│   ├── integration/                   # Multi-module pipeline tests
│   ├── e2e/                           # Full CLI invocation tests
│   └── fixtures/                      # Test data
│       ├── merge/                     # 17 three-way merge scenarios
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
- **No `any`** except in `schema.ts` zod dynamic generation (documented in spec). Prefer `unknown` + type narrowing.
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

Read the spec section before implementing. It has inputs, outputs, algorithm steps, error cases, and test expectations.

### Testing

- **Fixtures before code** for the merge engine. Write all 17 fixture directories (see spec §17.2), then implement until they pass. TDD is mandatory for `drift.ts` and `differ.ts`.
- **Unit tests** for pure functions in `source/core/`. Test files: `tests/unit/<module>.test.ts`.
- **Integration tests** for pipelines: install (temp dir → full vault), update (install → modify → update → verify).
- **E2E tests** for CLI: invoke binary via `execa`, check output and file state.
- Each merge fixture is a self-contained directory with `scenario.yaml`, template files, values files, actual file, and expected output. See `tests/fixtures/merge/01-managed-no-change/` for the pattern.
- **Clean up after tests**: remove temp dirs, don't leak state between tests.
- Run `npm test` before committing. It must be green.

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

## What NOT to Do

- Don't add features not in the spec. If something seems missing, check the spec first — it might be intentionally deferred (see §21 Deferred Items).
- Don't use `any` without documenting why.
- Don't modify `.shardmind/` directory structure without updating the state.ts module and spec.
- Don't add dependencies without checking the spec's dependency list.
- Don't write the merge engine without writing fixtures first. TDD is mandatory for `drift.ts` and `differ.ts`.
- Don't fight Pastel's conventions (source/ not src/, tsx for commands).
