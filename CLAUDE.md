# ShardMind

Package manager for Obsidian vault templates. TypeScript, Pastel + Ink TUI, spec-driven development.

## How This Repo Works

This project is **spec-driven**. The architecture and implementation are fully designed before code is written. Claude Code reads the specs and implements them.

### Source of Truth

| Document | What | When to Read |
|----------|------|-------------|
| `docs/ARCHITECTURE.md` | The what and why. 22 sections. Core concepts, ownership model, schema format, module system, values layer, signals, operations, competitive moat. | Before making any architectural decision. |
| `docs/IMPLEMENTATION.md` | The how, exactly. System diagram, data flows, 10 module specs with TypeScript signatures, algorithms as numbered steps, error cases, 17 merge test fixtures, 6-day build plan. | Before implementing any module. |

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

## Conventions

### Code

- **TypeScript strict mode.** No `any` except in zod dynamic schema generation (documented in spec).
- **Pastel conventions**: `source/` not `src/`. `.tsx` for commands and components. Follow `@sindresorhus/tsconfig`.
- **One file per module** in `source/core/`. Each maps 1:1 to a spec section in `docs/IMPLEMENTATION.md`.
- **Exported types** live in `source/runtime/types.ts`. Both CLI and runtime import from there.
- **Error handling**: throw `ShardMindError` with code + hint. Commands catch and render via Ink `StatusMessage`. See spec §7.

### Testing

- **Fixtures before code** for the merge engine. Write all 17 fixture directories (see spec §17.2), then implement until they pass.
- **Unit tests** for pure functions: renderer, schema parser, drift detector, migrator, modules resolver.
- **Integration tests** for pipelines: install (temp dir → full vault), update (install → modify → update → verify).
- **E2E tests** for CLI: invoke binary, check output and file state.
- Each fixture is a self-contained directory with `scenario.yaml`, template files, values files, actual file, and expected output.

### Commits

- Conventional commits: `feat:`, `fix:`, `test:`, `docs:`, `refactor:`.
- One module per commit when building. Don't batch unrelated changes.
- Tests pass before committing. `npx vitest run` must be green.

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
