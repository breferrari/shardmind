# ShardMind

Package manager for Obsidian vault templates. TypeScript, Pastel + Ink TUI, spec-driven development. The engine is agent-agnostic — shard content determines which AI agents are supported (Claude Code, Codex, Gemini CLI).

## How This Repo Works

This project is **spec-driven**. The architecture and implementation are fully designed before code is written. Claude Code reads the specs and implements them.

### Source of Truth

| Document | What | When to Read |
|----------|------|-------------|
| `VISION.md` | Origin story, architectural bets, scope guardrails, non-goals. | Before proposing features or scope changes. |
| `ROADMAP.md` | Build order in phases, one per GitHub milestone, each row linking its issue; the Shelf and its dated reasons. Taken with the `take-next` skill (`.claude/skills/take-next/`). | Before starting any task. |
| **`docs/SHARD-LAYOUT.md`** | **v6 shard-layout contract + four binding invariants. Active design spec.** Folded into `ARCHITECTURE.md §3` and `IMPLEMENTATION.md §4.5` / `§4.5a` / `§4.5b` for the engine specs; this doc remains the canonical contract for the binding properties + author-facing layout. | Before implementing anything related to shard layout, install walk, hook context, adopt command, or obsidian-mind v6. Authoritative over ARCHITECTURE.md / IMPLEMENTATION.md where they conflict. |
| `docs/ARCHITECTURE.md` | The what and why. 22 sections. Core concepts, ownership model, schema format, module system, values layer, signals, operations, competitive moat. | Before making any architectural decision. |
| `docs/IMPLEMENTATION.md` | The how, exactly. System diagram, data flows, module specs with TypeScript signatures, algorithms as numbered steps, error cases, 20 merge test fixtures. §9 is a historical note on the v0.1 build; current work is in `ROADMAP.md`. | Before implementing any module. |
| `docs/COMPONENTS.md` | Iterated UI patterns (A/B), `useOncePerKey` hook, `rerender()` regression-test convention. Codifies why state-machine-iterated prompts (`AdoptDiffView`, `DiffView`) need per-iteration ref scoping vs. boolean refs. | Before adding a new Ink component that may be iterated by a parent state machine, or before changing a `useRef` shape inside one. |
| `examples/minimal-shard/` | Minimal test shard for development. 4 values, 2 modules, signals. Flat v6 layout (`.shardmind/` sidecar, content at native paths, dotfolder `.njk` for rendering). | Use as a fixture for engine-level tests; obsidian-mind v6 conversion lands at Milestone 5. |

**Read the relevant spec section before writing code.** The specs define inputs, outputs, algorithms, error cases, and test expectations for every module. Don't improvise — implement what the spec says.

### Build Order

**Authoritative task list for v0.1: [#70](https://github.com/breferrari/shardmind/issues/70)** (engine changes, shard conversion, docs, tests, acceptance criteria). Spec for what to build: [`docs/SHARD-LAYOUT.md`](docs/SHARD-LAYOUT.md). The day-by-day rhythm below is kept for cadence reference. `docs/IMPLEMENTATION.md §9` is now a short historical note, and #70's tracks replaced its pre-v6 sub-tasks.

| Day | Focus |
|-----|-------|
| 1 | Scaffold + core modules per #70 "Walk + discovery" and "Schema + values" tracks |
| 2 | Install command with full Ink wizard + module review + `--defaults` flag |
| 3 | Merge engine — TDD with 17 fixtures (write fixtures FIRST, then implement) |
| 4 | Update command + status display + verbose mode + ref re-resolution + `--version` / `--include-prerelease` |
| 5 | obsidian-mind v6 conversion (`.shardmind/` sidecar, dotfolder `.njk`, hooks) + `shardmind adopt` command |
| 6 | Research-wiki shard, Invariant 1 E2E test, polish, npm publish |

## Working Agreement (v6 execution standard)

Every v6 sub-issue (#73–#78, #14, #15, #85) passes these gates before merge. These practices are what this project has used from day one — spec-driven, fixture-first, adversarial. This section makes them explicit so any session picking up work knows the bar.

### 1. Spec before code

- Read the relevant section of [`docs/SHARD-LAYOUT.md`](docs/SHARD-LAYOUT.md) AND the linked issue body before touching code.
- If the spec is silent or ambiguous on a decision you need, **update the spec first via a separate commit** — do not invent behavior in the implementation.
- If your implementation reveals a spec mistake, fix the spec and submit the fix alongside the code change.

### 2. Tests before implementation

- Write the failing test first for every new behavior or bug fix. No code without a test.
- For merge-engine-class work (`drift.ts`, `differ.ts`, `renderer.ts`), write **fixtures first** — the pattern used for the 20 merge fixtures in `tests/fixtures/merge/`.
- Prefer property-based tests via `fast-check` when the input space is wide: ref-syntax parsing, `.shardmindignore` glob matching, hash-equivalence under whitespace.
- Right test type for the work: unit for pure functions in `source/core/*.ts`; component via `ink-testing-library` for `source/components/*.tsx`; integration for multi-module pipelines; E2E via `tests/e2e/cli.test.ts` spawning `dist/cli.js`.

### 3. Adversarial cases enumerated

Before coding, list adversarial scenarios in the issue thread or PR description. Every listed case gets a test. Starter enumeration per v0.1 track:

- **#73 walk**: symlinks pointing outside vault, paths with Unicode + spaces, missing `.shardmind/`, empty `.shardmind/`, `.shardmindignore` with thousands of patterns, tarball with Windows path separators.
- **#74 schema**: defaults of `null` / `""` / `0` / `false` / nested objects; required-without-default must reject at parse time.
- **#75 hooks**: hook crashes mid-edit (state.json must still reflect actual content), hook exceeds timeout, hook writes to unmanaged paths, `valuesAreDefaults` deep-equal vs. near-equal (whitespace, case, type coercion).
- **#76 update**: ref moves between install and update, tag force-moved upstream, non-existent ref, rate-limited GitHub API, `--release` + `--include-prerelease` combined, beta-only repos (no stable release).
- **#77 adopt**: adopt into dir with partial vault, adopt with existing `.shardmind/`, adopt with user files byte-equivalent to shard paths, adopt mid-failure recovery, adopt when shard can't be fetched.
- **#78 Invariant 1**: shard with all-defaults empty strings, shard with zero modules, `.shardmindignore` excluding everything, byte-equivalence on case-insensitive filesystems (macOS), clone of shard vs. install includes/excludes parity.

### 4. Quality gate (PR-merge requirements)

Every PR for a v6 issue must demonstrate in its description:

- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes (all scopes).
- [ ] New behavior has new tests (§2) — no code without tests.
- [ ] Adversarial cases from §3 are enumerated and covered.
- [ ] Once [#78](https://github.com/breferrari/shardmind/issues/78) lands: Invariant 1 E2E test still green.
- [ ] Issue's acceptance criteria checked off with evidence.
- [ ] Roadmap row's mark updated in the same PR.

### 5. Session hygiene

- **Start**: read this file, then run `sh .claude/skills/take-next/next.sh` (the milestone to take from; the topmost ⬜ row of its `ROADMAP.md` section is the task), then the linked issue, then `docs/SHARD-LAYOUT.md` (relevant section). In that order. Don't skip ahead. The `take-next` skill runs this whole agreement as one pass.
- **During**: run `npm run typecheck` and `npm test` frequently, not just at the end. If a test that should stay green goes red, stop and investigate before continuing — don't paper over.
- **End**: if work is complete, open a PR referencing the issue (`closes #N`) with the quality-gate evidence. If incomplete, push the branch and comment on the issue with where you stopped, why, and what blocks progress — so the next session can resume.

### 6. PR hygiene

- **PR and issue titles are imperative**: they say what to do, not what is true or what should happen. PR titles keep the conventional-commit prefix (`fix: keep user edits across updates`, not `fix: update no longer overwrites edits`); issue titles take no prefix (`List the paths an update replaced`, not `update summary should list the paths it overwrote`). Applies to every PR and issue opened from 2026-10-03 on; older titles stay as they are.
- **One PR per issue** by default. Bundling multiple issues into one PR is discouraged — it tangles review, makes revert granularity worse, and confuses the roadmap-checkbox flow. If two issues are truly inseparable, comment on both issues explaining why before opening the combined PR.
- The quality-gate checklist above lives in [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) and auto-populates every new PR. Don't delete items — check them or justify their absence.
- **Interim proxy for Invariant 1** while #73-#77 are in-flight: until [#78](https://github.com/breferrari/shardmind/issues/78) lands its CI test, each PR on #73-#77 should manually run `git clone <a fixture shard>` + `shardmind install --defaults` + `diff -r` and paste the result (or "no diff beyond Tier 1 + `.shardmind/` metadata") into the PR description.

### 7. Commit hygiene — step-by-step, never one mega-commit

- **A PR is a sequence of small, reviewable commits.** A single squashed commit on a multi-step change is a review-hostile artifact: reviewers can't bisect, can't read incrementally, can't revert the wrong piece. Always split.
- **Commit at every coherent step.** A new module + its tests is a step. A test sweep that migrates N existing tests to a new contract is a step. A docs update is a step. A fixture regeneration is a step. Don't batch unrelated steps; don't fragment the same step across commits.
- **Each commit must be self-consistent**: typecheck + the relevant test scope green at every commit. Reviewers (and `git bisect`) rely on this — a broken intermediate commit defeats the purpose. If a step needs a follow-up step to make tests green, fold them into the same commit.
- **Conventional-commit prefixes** (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:`). Subject ≤ 70 chars. Body explains *why* and links the issue. The issue tag goes in the *first* commit of the series; subsequent commits in the same PR don't repeat it unless they cite a sub-decision.
- **Recommended split shape** for engine work: (1) new pure module(s) + their unit tests, (2) wire-up to existing modules, (3) call-site migrations + test sweep, (4) fixtures / examples, (5) docs (CHANGELOG, ROADMAP). Five commits is normal for a v6 sub-issue PR; one commit is wrong.
- **Force-pushing the topic branch to fix history is fine** (and expected) before review starts. Once a reviewer has commented, prefer additive `fixup!` commits over rewriting their context. Auto-squash on merge if the maintainer prefers a squashed history at merge time — the *review* still happened against the granular series.

## Tech Stack

| Tool | Purpose |
|------|---------|
| **Pastel** (vendored) | CLI framework in `source/cli-kit/`, vendored from Pastel 4.0.1 (#277): file-system routing, zod arg parsing |
| **commander** | Argument parsing under the cli-kit |
| **zod-validation-error** | The cli-kit's message for an invalid argument or option |
| **Ink** | React terminal renderer. Prompts and status widgets come from `source/ui-kit/`, vendored from `@inkjs/ui` 2.0.0 (#43, #273) |
| **React** | Required peer dep for Ink |
| **chalk** | The colour decision Ink already makes; read `chalk.level`, don't re-derive it. Same range as Ink's (^6, Ink 8), one deduped copy (#37, #270) |
| **Nunjucks** | Template engine (`{{ }}` syntax). Config: `autoescape: false` |
| **yaml** (eemeli/yaml) | YAML parsing. TypeScript-typed, comment-preserving |
| **tar** (node-tar) | Tarball download + extraction |
| **semver** | Version parsing, range checking |
| **ignore** | gitignore-spec glob matcher for `.shardmindignore`. Negation pre-filtered by the wrapper (deferred to v0.2 per #87). |
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
│   ├── cli.ts                        # Pastel entry point
│   ├── commands/
│   │   ├── index.tsx                  # Status display (root command)
│   │   ├── _app.tsx                   # Pastel custom app: wraps every command in CrashBoundary (#225)
│   │   ├── install.tsx                # shardmind install <shard>
│   │   ├── update.tsx                 # shardmind update
│   │   ├── adopt.tsx                  # shardmind adopt <shard>
│   │   ├── validate.tsx               # shardmind validate [dir|shard] — author-facing check (#34)
│   │   └── hooks/                     # State-machine + shared command hooks
│   │       ├── use-install-machine.ts
│   │       ├── use-update-machine.ts
│   │       ├── use-adopt-machine.ts
│   │       ├── use-status-report.ts   # Async loader for status command
│   │       ├── use-self-update-check.ts # Cached npm check + detached refresh + suppression rules (#113, #285)
│   │       ├── use-self-update-banner.tsx # Composed hook: pkg.version + check + <SelfUpdateBanner /> (#113)
│   │       ├── cli-version.ts         # Bundle-aware shardmind pkg.version resolver (#113)
│   │       ├── use-vault-lock.ts      # take/release the vault lock in install/update/adopt (#253)
│   │       ├── update-check-option.ts # Shared --no-update-check option, named for the positive (#147)
│   │       └── shared.ts              # summarizeHook, useSigintRollback
│   ├── components/
│   │   ├── CommandFrame.tsx           # Dry-run banner + keyboard legend
│   │   ├── ErrorView.tsx              # Every command's error view: known / environment / bug (#225)
│   │   ├── CrashBoundary.tsx          # Shows a render-time throw through ErrorView, exit 1 (#225)
│   │   ├── CommandProgress.tsx        # Shared progress UI (install + update)
│   │   ├── StatusView.tsx             # Quick status (shardmind root command)
│   │   ├── VerboseView.tsx            # Detailed diagnostics (shardmind --verbose)
│   │   ├── InstallWizard.tsx          # Values prompts + module review
│   │   ├── ModuleReview.tsx           # Multiselect for modules
│   │   ├── ScrollableMultiSelect.tsx  # Custom multi-select with ↑/↓ N more scroll hints (#100)
│   │   ├── CollisionReview.tsx        # Install: backup / overwrite / cancel
│   │   ├── ExistingInstallGate.tsx    # Install: existing-install disambiguation
│   │   ├── DiffView.tsx               # Three-way diff + conflict resolution
│   │   ├── AdoptValuesGate.tsx        # Adopt: values confirm-or-override page (#104)
│   │   ├── AdoptModePicker.tsx        # Adopt: batch mode picker (keep-all / use-all / auto-merge / per-file) (#120)
│   │   ├── AdoptDiffView.tsx          # Adopt: 2-way diff (no merge base) + per-file prompt
│   │   ├── AdoptSummary.tsx           # Final adopt report (matched / mine / shard / fresh)
│   │   ├── NewValuesPrompt.tsx        # Update: prompt for newly required values
│   │   ├── NewModulesReview.tsx       # Update: offer newly optional modules
│   │   ├── RemovedFilesReview.tsx     # Update: per-file keep/delete decision
│   │   ├── HookProgress.tsx           # Live output tail while a post-install/-update hook runs
│   │   ├── HookSummarySection.tsx     # Four-branch hook outcome render, shared by Summary + UpdateSummary
│   │   ├── ExternalToolsSection.tsx   # Unmet optional external tools / dry-run note, shared by the three summaries (#138)
│   │   ├── SelfUpdateBanner.tsx       # One-line "newer shardmind on npm" notice, rendered above each command (#113)
│   │   ├── Summary.tsx                # Final install report
│   │   ├── UpdateSummary.tsx          # Final update report
│   │   ├── ValueInput.tsx             # Typed input widget (string/number/select…)
│   │   ├── Header.tsx                 # Branded header
│   │   ├── use-once-per-key.ts        # Per-iteration dedup hook for state-machine-iterated prompts (see docs/COMPONENTS.md Pattern B)
│   │   └── ui.ts                      # Barrel re-export of the ui-kit
│   ├── core/
│   │   ├── manifest.ts                # Parse + validate shard.yaml
│   │   ├── schema.ts                  # Parse shard-schema.yaml → zod validator
│   │   ├── registry.ts                # Resolve shard ref → GitHub URL + version (incl. `#<ref>` commit resolution)
│   │   ├── download.ts                # Fetch + extract GitHub tarball
│   │   ├── renderer.ts                # Nunjucks + frontmatter-aware rendering
│   │   ├── state.ts                   # Read/write .shardmind/state.json
│   │   ├── state-migrator.ts          # Forward-migrate state.json (v0.2 hook, v0.1 scaffolding)
│   │   ├── drift.ts                   # Ownership detection + drift analysis
│   │   ├── differ.ts                  # Three-way merge (node-diff3)
│   │   ├── diff3.ts                   # node-diff3's diff3MergeRegions, ported with a fast LCS for repeated lines (#170)
│   │   ├── migrator.ts                # Apply schema migrations to values
│   │   ├── modules.ts                 # Shard-root walker + module resolution + file gating
│   │   ├── tier1.ts                   # Engine-enforced source-side path exclusions
│   │   ├── shardmindignore.ts         # gitignore-spec glob matcher (negation rejected v0.1)
│   │   ├── update-planner.ts          # Pure update plan from drift + new shard
│   │   ├── update-executor.ts         # Apply update plan with rollback
│   │   ├── install-planner.ts         # Pure install plan + collisions
│   │   ├── install-executor.ts        # Apply install plan with rollback
│   │   ├── adopt-planner.ts           # Classify user vault vs shard (matches/differs/shard-only)
│   │   ├── adopt-executor.ts          # Apply adopt plan with snapshot-rollback
│   │   ├── adopt-merge.ts             # Two-way union merge for adopt --mode=auto-merge (#120)
│   │   ├── values-io.ts               # Shared YAML load for shard-values.yaml
│   │   ├── values-defaults.ts         # `valuesAreDefaults(values, schema)` — Invariant 2 helper
│   │   ├── update-check.ts            # 24h cached latest-version lookup (status + update)
│   │   ├── vault-lock.ts              # One run per vault: <vault>/.shardmind.lock, stale takeover, exit backstop (#253)
│   │   ├── self-update-check.ts       # 24h cached npm-registry check for newer engine versions (#113)
│   │   ├── status.ts                  # Pure StatusReport builder for the status command
│   │   ├── cancellation.ts            # Cross-platform SIGINT bridge (Windows stdin-ETX)
│   │   ├── hook.ts                    # Slot-agnostic hook lookup + subprocess execution (runHook, executeHook)
│   │   ├── hook-orchestrator.ts       # Hook lifecycle: slot selection/order, boundary checks, re-hash, fingerprint (#102)
│   │   ├── hook-boundary.ts           # Pure detect-and-warn write-boundary detector — managed-write / unmanaged-create (#102)
│   │   ├── vault-path-guard.ts        # Refuse writes through symlinks, hard links, case-folded names (#163)
│   │   ├── stdout-closed.ts           # A reader that closes stdout early: quiet exit 141 after the run ends (#252)
│   │   ├── lint-shard.ts              # Install's checks in check mode, collecting every finding (#34)
│   │   ├── validate-shard.ts          # validate target (dir or ref) + headless --json runner (#34)
│   │   ├── color-env.ts               # NO_COLOR → chalk level 0 before Ink loads; FORCE_COLOR wins (#37)
│   │   ├── bug-report.ts              # describeError (known / environment / bug), report link, top-level crash handler (#225)
│   │   ├── rollback-report.ts         # ROLLBACK_INCOMPLETE: what a failed rollback left behind (#247)
│   │   ├── restore-tree.ts            # Put a snapshot back: copy over, or a whole-replaced folder exactly (#264)
│   │   ├── json-run.ts                # A terminal --json run behaves as piped: stdout non-interactive before Ink (#198)
│   │   ├── editor.ts                  # Open in editor: $VISUAL/$EDITOR, temp copy, raw-mode handoff (#50)
│   │   ├── created-folders.ts         # The folders a run created, removed by its rollback (#258)
│   │   ├── external-tools.ts          # Check external_tools against their ranges; no-shell probe (#138)
│   │   └── fs-utils.ts                # sha256, pathExists, toPosix, mapConcurrent
│   ├── internal/                      # NOT public API — runtime-spawned helpers
│   │   ├── hook-runner.ts             # ESM subprocess entry that imports + invokes a hook
│   │   └── self-update-refresh.ts     # Detached child that refreshes the npm self-update cache (#285)
│   ├── ui-kit/                        # Components vendored from @inkjs/ui 2.0.0 (#43, #273); index.ts is the only entry, licences + PROVENANCE.md + VENDOR.json inside
│   ├── cli-kit/                       # CLI framework vendored from Pastel 4.0.1 (#277); index.ts is the only entry, positional options built in (#147)
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
├── scripts/
│   └── vendor/                        # Repo tooling, never shipped (IMPLEMENTATION §4.27, #280)
│       ├── record.ts                  # VENDOR.json schema, headerFor / stripHeader
│       ├── upstream.ts                # UpstreamSource: npm + GitHub (fixtures in tests)
│       ├── check.ts                   # npm run vendor:check: kits behind npm, always exit 0
│       └── update.ts                  # npm run vendor:update <kit> <version>: per-file merge via core/differ.ts
├── tests/
│   ├── unit/                          # Pure function tests
│   ├── component/                     # Ink components via ink-testing-library
│   │   └── flows/                     # Layer 1 TUI flow tests — drive whole-command React trees (Install / Update / Adopt / Index) through stdin (#111 Phase 1)
│   ├── ui-kit/                        # ui-kit tests, incl. boundary.test.ts (imports only ink, react, node:) — no ShardMind fixtures
│   ├── integration/                   # Multi-module pipeline tests
│   ├── e2e/                           # Full CLI invocation tests (subprocess)
│   │   ├── cli.test.ts                # End-to-end scenarios across status / install / update / adopt + post-install hook + Invariant 1 byte-equivalence
│   │   ├── crash.test.ts              # A bug no error view catches: top-level handler + render-time CrashBoundary, exit 1 (#225)
│   │   ├── obsidian-mind-contract.test.ts  # v6 contract acceptance suite — install / update / adopt / refs / additive / hook failure / adversarial against the obsidian-mind-like fixture (#92)
│   │   ├── tui/                       # Layer 2 real-PTY TUI scenarios — node-pty + @xterm/headless drive `dist/cli.js` under a real terminal (#111 Phase 2; every OS, Windows under ConPTY, gated on probed PTY capabilities, #174)
│   │   │   ├── helpers/               # pty-cli, virtual-screen, build-fixture-shard
│   │   │   ├── harness.test.ts        # Smoke for pty-cli + virtual-screen contracts
│   │   │   ├── install-wizard.test.ts # Scenarios 1, 9, 11
│   │   │   ├── update-conflicts.test.ts # Scenarios 14, 18 (SIGINT rollback)
│   │   │   ├── adopt-diff.test.ts     # Scenario 20
│   │   │   └── hook-lifecycle.test.ts # Scenarios 26, 27, 28
│   │   └── helpers/                   # build-once, tarball, github-stub,
│   │                                  # spawn-cli, vault factories,
│   │                                  # invariant1 byte-equivalence helper,
│   │                                  # obsidian-mind-tarball builder
│   ├── helpers/                       # Shared test utilities (factories)
│   │   ├── shard-state.ts             # makeShardState, makeFileState
│   │   └── make-shard-source.ts       # makeShardSource — v6 temp-shard scaffold
│   └── fixtures/                      # Test data
│       ├── merge/                     # 20 three-way merge scenarios
│       ├── shards/
│       │   ├── minimal-shard.tar.gz       # Pre-built minimal shard tarball
│       │   └── obsidian-mind-like/        # Flat-layout shard fixture for the v6 contract acceptance suite (#92)
│       ├── schema/                    # Valid + invalid schemas
│       ├── render/                    # Template rendering scenarios
│       └── migration/                 # Value migration scenarios
├── docs/
│   ├── ARCHITECTURE.md                # The what and why (22 sections)
│   ├── IMPLEMENTATION.md              # The how exactly (10 sections)
│   ├── SHARD-LAYOUT.md                # v6 shard-layout contract — Invariants 1/2/3/4, file disposition tiers, engine change scope
│   ├── AUTHORING.md                   # Shard author guide — schema, modules, hooks, dotfolder convention
│   ├── ERRORS.md                      # Typed error code registry — codes, messages, hints, remediation
│   ├── OPERATIONS.md                  # Deployment notes — air-gapped install, GitHub endpoints, registry config
│   └── COMPONENTS.md                  # Iterated UI patterns (A/B), useOncePerKey hook, testing convention for state-machine-iterated prompts
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Build, Test, and Development Commands

```bash
npm ci                # Install deps from lockfile (routine — see Lockfile discipline below)
npm install           # Only when adding/bumping a dep (run after `rm -rf node_modules`)
npm run build         # tsup build (cli + runtime)
npm run dev           # tsup watch mode
npm test              # vitest run (all tests)
npm run test:watch    # vitest watch
npm run test:merge    # just the merge engine fixtures
npm run typecheck     # tsc --noEmit (source/, then scripts/ via tsconfig.scripts.json)
npm run vendor:check  # vendored kits behind their upstream (exit 0)
npm run vendor:update -- <kit> <version>  # merge a new upstream into a kit
```

- If deps are missing or a command fails with "module not found", run `npm ci` first, then retry.
- Before pushing: `npm run typecheck && npm test` must both pass.
- Before publishing: `npm run build` must produce clean output in `dist/`.

### Lockfile discipline

Use `npm ci` for routine syncing after `git pull` — it installs exactly what the lockfile specifies and never mutates it. When adding or bumping a dep, always `rm -rf node_modules` before `npm install`: npm has a [known bug](https://github.com/npm/cli/issues/4828) that prunes non-host platform binaries (e.g. `@esbuild/*`, `@rolldown/binding-*`) from `package-lock.json` when regenerating with `node_modules/` present. Starting from a clean `node_modules` avoids the prune on every platform. CI runs `npm ci` on all matrix runners, so a lockfile missing platform variants will fail the Windows or macOS job loudly instead of silently.

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
- `source/cli-kit/` — the CLI framework vendored from Pastel 4.0.1 (#277): imports only `ink`, `react`, `commander`, `zod`, `zod-validation-error`, `node:` built-ins, its own files and the ui-kit's index (`tests/cli-kit/boundary.test.ts`); ShardMind imports it only through `cli-kit/index.ts`. See ARCHITECTURE §11.4.
- `source/ui-kit/` — the TUI components (`Select`, `TextInput`, `Alert`, `Badge`, `ProgressBar`, `Spinner`, `StatusMessage`) vendored from `@inkjs/ui` 2.0.0 (#43, #273), self-contained for later extraction: imports only `ink`, `react`, `node:` built-ins and its own files (`tests/ui-kit/boundary.test.ts` enforces it); ShardMind imports it only through `ui-kit/index.ts`, via `components/ui.ts`. See ARCHITECTURE §11.4.

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
| `modules.ts` | §4.5 (v6: see SHARD-LAYOUT.md §Engine change scope §Walk + discovery) | Shard-root walker + module resolution + file gating |
| `tier1.ts` | SHARD-LAYOUT.md §File disposition Tier 1 | Engine-enforced source-side path exclusions (`.git/`, `.github/`, `.shardmind/`, `.obsidian/{workspace,workspace-mobile,graph}.json`) |
| `shardmindignore.ts` | SHARD-LAYOUT.md §Engine change scope item 6 | gitignore-spec glob matcher for the root `.shardmindignore` (negation rejected in v0.1, deferred to #87) |
| `state.ts` | §4.7 | Read/write .shardmind/state.json |
| `registry.ts` | §4.1 | Resolve shard ref → GitHub URL (registry / direct / `#<ref>` commit resolution / `/releases` listing with prerelease policy) |
| `drift.ts` | §4.8 | Ownership detection + drift analysis |
| `differ.ts` | §4.9 | Three-way merge via node-diff3 |
| `diff3.ts` | §4.9 | node-diff3's `diff3MergeRegions`, ported with a binary-search LCS; regions identical to node-diff3's (#170) |
| `migrator.ts` | §4.10 | Apply schema migrations to values |
| `install-planner.ts` | §4.11a | Pure install plan (outputs, collisions, value-coercion, computed defaults) |
| `install-executor.ts` | §4.11b | Apply install plan with transactional backup + rollback |
| `update-planner.ts` | §4.11 | Plan update actions from drift + new-shard render |
| `update-executor.ts` | §4.12 | Apply update plan with snapshot-based rollback |
| `adopt-planner.ts` | §4.17 | Classify user vault vs shard outputs (matches / differs / shard-only) |
| `adopt-executor.ts` | §4.18 | Apply adopt plan with snapshot-based rollback |
| `adopt-merge.ts` | SHARD-LAYOUT.md §Adopt semantics | Two-way union merge for `adopt --mode=auto-merge` (#120) |
| `values-io.ts` | §4.13 | Shared YAML load for shard-values.yaml (install + update) |
| `values-defaults.ts` | §4.16 (HookContext extensions) | `valuesAreDefaults(values, schema)` — deep-equal pure fn for Invariant 2 |
| `status.ts` | §4.14 | Pure StatusReport builder for the `shardmind` (status) command |
| `update-check.ts` | §4.15 | 24h cached GitHub latest-version lookup shared by status + update |
| `self-update-check.ts` | §4.19 | 24h cached npm-registry check for newer shardmind engine versions; powers `<SelfUpdateBanner>` |
| `vault-path-guard.ts` | §4.20 | Refuses install / update / adopt over a symlinked, hard-linked or case-folded vault path (`VAULT_PATH_UNSAFE`, #163) |
| `stdout-closed.ts` | §7.2a | A reader that closes stdout early (`| head`): later writes dropped, the run finishes or rolls back, then a quiet exit 141 (#252) |
| `color-env.ts` | §4.21 | Applies `NO_COLOR` to the environment before chalk loads; `FORCE_COLOR` wins when both are set (#37) |
| `json-run.ts` | §4.23 | Detects a `--json` run of update / adopt / validate / status and marks stdout non-interactive before Ink loads, so a terminal run equals the piped one; a crash in it answers on stdout too (#198) |

| `lint-shard.ts` | §4.22 | Install's checks in check mode, collecting every finding; used by `validate` (#34) and the pre-install check (#35) |
| `validate-shard.ts` | ARCHITECTURE §10.5b | `validate`'s target resolution (dir or downloaded ref) and its headless `--json` runner |
| `cancellation.ts` | ARCHITECTURE §19.7 | Cross-platform SIGINT bridge (Windows stdin-ETX → process.emit SIGINT) |
| `state-migrator.ts` | §4.7 | Forward-migration framework for `.shardmind/state.json`; first rule (v1→v2, `bootstrap_fingerprint`) landed with #102 |
| `hook.ts` | §4.16 | Slot-agnostic hook lookup + execute via bundled `tsx` subprocess (non-fatal) |
| `hook-orchestrator.ts` | §4.16a | Hook lifecycle: slot selection/order, per-slot ctx, write-boundary checks, re-hash, fingerprint persist |
| `hook-boundary.ts` | §4.16b | Pure detect-and-warn write-boundary detector (managed-write / unmanaged-create) |
| `bug-report.ts` | §7.2a | `describeError` (known / environment / bug), the version-only report link, the plain-text top-level crash handler (#225) |
| `restore-tree.ts` | §4.12 step 7 | `restoreTree` (copy a snapshot over, skipping paths restored another way) and `restoreDirExactly` (a folder the run replaced whole, made equal to its snapshot) (#264) |
| `rollback-report.ts` | §4.11b (Reporting the rollback) | `ROLLBACK_INCOMPLETE` for a rollback that left files behind, shared by install / update / adopt (#247) |
| `editor.ts` | §4.24 | Open a conflict in `$VISUAL` / `$EDITOR`: temp copy, outcome (saved / cancelled), raw-mode handoff, marker check (#50) |
| `vault-lock.ts` | §4.25 | One run per vault: `<vault>/.shardmind.lock` (wx), `VAULT_LOCKED`, stale same-host takeover, release + exit backstop (#253) |
| `created-folders.ts` | §4.11b, §4.12 (4a), §4.18 | The folders a run created, for install / update / adopt rollbacks (#258) |
| `external-tools.ts` | §4.26 | Check a shard's `external_tools` against their version ranges before install / adopt / update write (`EXTERNAL_TOOL_UNMET`); the probe runs without a shell (#138) |
| `fs-utils.ts` | (shared utilities) | sha256, pathExists, toPosix, mapConcurrent |

Read the spec section before implementing. It has inputs, outputs, algorithm steps, error cases, and test expectations.

### Testing

- **Fixtures before code** for the merge engine. Write all 17 fixture directories (see spec §19.2), then implement until they pass. TDD is mandatory for `drift.ts` and `differ.ts`.
- **Unit tests** for pure functions in `source/core/`. Test files: `tests/unit/<module>.test.ts`.
- **Component tests** for Ink components via `ink-testing-library`. Files: `tests/component/<Component>.test.tsx`.
- **Iterated-component regression tests are mandatory.** If a component is rendered inside a parent's iteration loop (state machine advances `phase.currentIndex`, `setIndex`, etc.) without a `key` prop forcing remount, its component test MUST include a `rerender()` case asserting the next iteration's interaction fires. Rationale: see [`docs/COMPONENTS.md`](docs/COMPONENTS.md) (Pattern B) — [#109](https://github.com/breferrari/shardmind/issues/109) shipped because `AdoptDiffView` and `DiffView` had only single-mount tests; the iteration-shape bug lived in the gap.
- **Layer 1 TUI flow tests are mandatory** for new commands or major flow changes to existing commands. Each new command (or flow change) gets a `tests/component/flows/<command>-flow.test.tsx` file in the same PR. Layer 1 mounts the whole command React tree via `ink-testing-library` and drives stdin end-to-end against the local GitHub stub — the same surface that #103 (wizard select-Enter freeze) and #109 (iterated diff freeze) fell through. Rationale: per-component tests verify single-mount behavior; only Layer 1 covers the production-shape iteration. See [#111](https://github.com/breferrari/shardmind/issues/111) Phase 1.
- **Layer 2 real-PTY tests are added when a bug needs real-terminal semantics** (SIGINT delivery, ANSI rendering, raw-mode keystroke handling, or live stdout streaming during `running-hook`) to manifest. Layer 2 lives under `tests/e2e/tui/` and spawns `dist/cli.js` inside a `node-pty` pseudoterminal, rendering the byte stream through `@xterm/headless`. Use Layer 1 by default — it's faster and covers most regressions; reach for Layer 2 only when the bug surface requires the kernel signal pipe, the actual TTY raw-mode path, or incremental terminal rendering. They run on every OS, Windows under ConPTY, gated on capabilities the global setup probes, never on `process.platform` ([#174](https://github.com/breferrari/shardmind/issues/174)); ConPTY's own framing is stripped against an exact allow-list (`tests/e2e/tui/helpers/conpty-framing.ts`). See [#111](https://github.com/breferrari/shardmind/issues/111) Phase 2 + `docs/ARCHITECTURE.md §19.7`.
- **Integration tests** for pipelines: install (temp dir → full vault), update (install → modify → update → verify).
- **E2E tests** for CLI: spawn `dist/cli.js` as a subprocess via `node:child_process` and route through the local GitHub stub (`tests/e2e/helpers/github-stub.ts`). No `execa` dependency; no public network. See `docs/ARCHITECTURE.md §19.7` for the hermetic-E2E methodology.
- Each merge fixture is a self-contained directory with `scenario.yaml`, template files, values files, actual file, and expected output. See `tests/fixtures/merge/01-managed-no-change/` for the pattern.
- **Clean up after tests**: remove temp dirs, don't leak state between tests.
- Run `npm test` before committing. It must be green. In CI, `npm run build` runs before `npm test` so the E2E suite has `dist/cli.js` to spawn.

### Commits

See [`§Working Agreement §7 — Commit hygiene`](#7-commit-hygiene--step-by-step-never-one-mega-commit) for the binding rule. Quick reference:

- Conventional commits: `feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:`.
- **Step-by-step always — never one mega-commit on a multi-step PR.** Splitting is what makes a PR reviewable; squashing is the maintainer's call at merge time.
- Each commit must be self-consistent: typecheck + relevant tests green at every commit.
- Reference the GitHub issue in the *first* commit of a PR series; subsequent commits cite the issue only when introducing a sub-decision.

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

## Where design decisions live

The specs in `docs/` hold the contract. The reasoning behind it, earlier designs and lessons from other projects live outside this repo, reachable through the **`vigil` MCP server**. This repo declares its identity as `shardmind` in `.om-project`, which is what scopes `recall`, `remember` and `record_work` to this project.

### Reading

| Tool | Use it for |
|---|---|
| **`search`** | The full written record: why the ownership model is hash-based, why values and modules are separate, which layouts came before v6 and why they were dropped. **Start here.** |
| **`expand`** | Once you have a specific note, see what it links to and what links back. Cheaper and more exact than searching again. |
| **`recall`** | Short durable lessons scoped to this project. Pass `explain: true` when something you expected is missing: it tells "scoped away" from "never existed". |
| **`reason`** | A judgement that needs several notes weighed against each other, such as "is this change consistent with what was decided". It spawns a second session, so it is slower and costs more. Use it only when `search` returned the notes but not the answer. |
| **`health`** | When something that should be there cannot be found. Every failure in this layer looks the same from outside (no results), and this is what tells them apart. |
| Resources | Notes are also exposed as `vault://note/<path>` and can be read directly when the title already answers the question. |

**`recall` is empty until sessions put things in it.** For this project's first sessions it returns little or nothing, and that is *not* evidence the record is missing. Use `search`, and cite the note path you used.

Consult the record before changing:

- the ownership model and `state.json` (what `managed` / `modified` mean, what a recorded hash is the baseline of)
- the merge engine (`drift.ts`, `differ.ts`, the three-way merge base)
- the shard contract in `docs/SHARD-LAYOUT.md` (the invariants, file disposition tiers, hook boundaries)
- the CLI surface (commands, flags, `--json` shapes, exit codes)

If the record and this repo disagree, the repo's specs hold the *contract* and the record holds the *why*. A disagreement means one of them is stale: find out which and reconcile before changing behaviour, then fix the stale side in the same pass (the spec by its own commit, the vault by `record_work`).

### Writing

Two tools, and picking the wrong one is the common mistake. **The test is whether it helps someone working on a different project.**

**`remember`** stores a durable **lesson**: a constraint you discovered, a gotcha that cost time, a rule that generalises. Not status, not a task summary.

- `confidence` is `verified` | `inferred` | `unverified`. Supply `verification` whenever you claim `verified`: the test you ran or the source you read.
- `scope` decides who sees the memory again:
  - **`project`**: true because of how ShardMind is built. `projects: ["shardmind"]`. "A recorded hash is the merge base, so recording user bytes as it makes them engine-owned" is this.
  - **`platform`**: true for anyone on the same technology. A Node, npm, Ink or Windows-filesystem fact is `platform` (`platforms: ["node"]`, `["windows"]`), not `general`.
  - **`general`**: true with no platform at all, such as test shapes, review process, git workflow. It reaches every project the vault serves. If the lesson names a library, runtime or environment variable, it is almost certainly `platform`.
- `links` connects it to existing notes by title. `supersedes` corrects an earlier memory. `dry_run: true` previews first.

**`record_work`** files what happened **here**. Use it at the end of a real piece of work, written for a session that will not have your context: `summary`, `changes` (one line per file), `decisions` (especially rejected alternatives), `learned`, `open`, `verification` (tests run and their result, failures stated honestly). `kind: "decision"` files it as a decision record. `informed_by` credits the notes you actually read.

Rule of thumb: **a `node-diff3` or Windows rename trap any Node project can hit is a `remember`** with `scope: "platform"`. **"Fixed #150 and here is what it cost" is a `record_work`.** Do both when both are true.

Never move commercial reasoning (positioning, competitors, launch planning) into this repo. Architectural rationale belongs in the specs; strategic conclusions go to `remember`.

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

**Binding gate:** Do not run `npm run release:*` until the smoke checklist in [`RELEASE-SMOKE.md`](RELEASE-SMOKE.md) has been completed against the packed-tarball CLI at the release SHA. After the `release.yml` workflow publishes the GitHub Release, append the saved smoke result table to the v\<version> release notes as a mandatory post-step. CI green is necessary, not sufficient — two consecutive 0.1.x patches ([#103](https://github.com/breferrari/shardmind/issues/103), [#109](https://github.com/breferrari/shardmind/issues/109)) shipped green and broke the flagship install on day one.

**Cadence:** [`RELEASE-SMOKE.md §Release cadence`](RELEASE-SMOKE.md#release-cadence) defines which v0.1.x patches batch together (hotfix / UX / foundation). Consult it before tagging — it answers "is this its own patch or does it ride with the next bundle?".

```bash
# 1. Update CHANGELOG.md: move [Unreleased] items to a new version section
# 2. Run RELEASE-SMOKE.md end-to-end against the release SHA
# 3. Bump version + tag + push:
npm run release:patch    # 0.1.0 → 0.1.1
npm run release:minor    # 0.1.0 → 0.2.0
npm run release:major    # 0.1.0 → 1.0.0
# 4. After the workflow publishes, paste the smoke result table into the
#    v<version> release tag body via the GitHub UI or `gh release edit`.
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
