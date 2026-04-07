# ShardMind Codebase Patterns

**Spec-driven. Read the spec before writing code.**

## Tech Stack

- **Runtime**: Node 18+ (22 recommended)
- **Language**: TypeScript (ESM, strict mode)
- **Package Manager**: npm
- **CLI Framework**: Pastel (file-system routing, zod args, Commander under the hood)
- **TUI**: Ink + @inkjs/ui (React for terminals)
- **Template Engine**: Nunjucks (`{{ }}` syntax, `autoescape: false`)
- **Validation**: zod (shared between CLI arg parsing and schema validation)
- **Merge**: node-diff3 (Khanna-Myers three-way merge)
- **Tests**: Vitest
- **Build**: tsup (dual entry: cli + runtime)

## Architecture — Read Before Coding

- `docs/ARCHITECTURE.md` — the what and why (22 sections)
- `docs/IMPLEMENTATION.md` — the how, exactly (10 module specs with TypeScript signatures)
- Each file in `source/core/` maps 1:1 to a spec section. Read the section first.

## Module Boundaries — Do Not Cross

```
source/core/        Pure logic. No Ink, no React. Testable without rendering.
source/components/  Ink/React components. Import from core/ for logic.
source/commands/    Pastel command files (.tsx). Thin orchestration only.
source/runtime/     Exported for hook scripts. ZERO dependency on Ink/React/Pastel.
source/types/       Re-exports from runtime/types.ts.
```

- Core must NOT import from components or commands.
- Runtime must NOT import from core, components, or commands.
- If you import `ink` or `react` in `source/runtime/`, the build is broken.

## Import Conventions

- Use `.js` extension for local imports (ESM requirement): `import { foo } from './bar.js'`
- Use `import type { X }` for type-only imports
- All shared types live in `source/runtime/types.ts` — import from there

## Source of Truth Locations

### Types (`source/runtime/types.ts`)

All interfaces: `ShardManifest`, `ShardSchema`, `ShardState`, `FileState`, `ModuleDefinition`, `ValueDefinition`, `SignalDefinition`, `MergeResult`, `DriftReport`, etc.

**NEVER duplicate type definitions. Import from `source/runtime/types.ts`.**

### Error Handling (`source/runtime/types.ts`)

`ShardMindError(message, code, hint)` — the only error class. Throw it from core modules. Commands catch and render via Ink `StatusMessage`.

### Zod Schemas

- `source/core/manifest.ts` — `ShardManifestSchema` for shard.yaml validation
- `source/core/schema.ts` — dynamic zod generation from shard-schema.yaml
- `source/commands/*.tsx` — export `args` and `options` as zod schemas (Pastel convention)

## Naming

- Files: `kebab-case.ts` for core, `PascalCase.tsx` for React components
- Types/Interfaces: `PascalCase`
- Functions: `camelCase`
- Zod schemas: `PascalCaseSchema`
- Constants: `SCREAMING_SNAKE_CASE`

## Pastel/Ink Patterns

- `source/` not `src/` (Pastel convention)
- `.tsx` for commands and components, `.ts` for everything else
- One file per command in `source/commands/`. Filename = CLI command.
- `index.tsx` = root command (no arguments → status display)
- Export `args` and `options` as zod schemas from command files
- Use `<Static>` for completed items, `<Box>` for live content

## Testing

- Merge engine: **TDD mandatory**. Write fixtures first, then implement.
- Fixtures in `tests/fixtures/` — self-contained directories with scenario.yaml
- Unit tests: `tests/unit/<module>.test.ts`
- Integration: `tests/integration/`
- E2E: `tests/e2e/`
- Run `npm test` before committing

## Anti-Patterns

- Do NOT add features not in the spec. Check `docs/IMPLEMENTATION.md` first.
- Do NOT use `any` without documenting why. Prefer `unknown` + narrowing.
- Do NOT add `@ts-ignore` or `@ts-nocheck`. Fix root causes.
- Do NOT modify `.shardmind/` structure without updating `state.ts` and the spec.
- Do NOT add dependencies not in `package.json`. Check the spec's dependency list.
- Do NOT publish manually. Tag and let CI handle it.
- Do NOT fight Pastel conventions (`source/` not `src/`, `.tsx` for commands).

## Commands

```bash
npm install          # Install deps
npm run build        # tsup build (cli + runtime, separate configs)
npm run dev          # tsup watch mode
npm test             # vitest run
npm run test:watch   # vitest watch
npm run test:merge   # just merge engine fixtures
npm run typecheck    # tsc --noEmit
```

## PR Review Checklist

When reviewing PRs, check:

1. Does the change match the spec? (`docs/IMPLEMENTATION.md` for the relevant module)
2. Are module boundaries respected? (no Ink imports in core/ or runtime/)
3. Are types imported from `source/runtime/types.ts`, not duplicated?
4. Do errors use `ShardMindError` with code + hint?
5. Are there tests? (unit for core modules, fixtures for merge scenarios)
6. Does `npm run typecheck && npm test` pass?
