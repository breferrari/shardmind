# Contributing to ShardMind

## Development Setup

```bash
git clone https://github.com/breferrari/shardmind.git
cd shardmind
npm install
npm run build
npm test
```

## PR Rules

- One PR = one issue. Do not bundle unrelated changes.
- Every PR references its GitHub issue number.
- Tests pass before merging. `npm test` must be green.
- Conventional commits: `feat:`, `fix:`, `test:`, `docs:`, `refactor:`.

## Spec-Driven Development

ShardMind is spec-driven. Read the spec before writing code:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the what and why
- [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) — the how, exactly

Each module in `source/core/` maps 1:1 to a section in the implementation spec. The spec defines inputs, outputs, algorithms, error cases, and test expectations. Don't improvise — implement what the spec says.

## Testing

- **Unit tests** for pure functions in `source/core/`
- **Fixtures before code** for the merge engine (TDD mandatory for `drift.ts` and `differ.ts`)
- **Integration tests** for install and update pipelines
- **E2E tests** for CLI invocation

```bash
npm test              # all tests
npm run test:merge    # just the merge engine
npm run test:watch    # watch mode
```

## Architecture Decisions

If you want to propose an architectural change, check [`VISION.md`](VISION.md) first — it lists scope guardrails and non-goals. If your proposal aligns, open an issue with the rationale before writing code.
