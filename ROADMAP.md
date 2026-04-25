# ShardMind Roadmap

> Living document. Every item links to a GitHub issue so a fresh session can pick up the next unchecked task without context from prior conversations.
>
> Context: [`VISION.md`](VISION.md) | Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Implementation: [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) | **v6 layout spec**: [`docs/SHARD-LAYOUT.md`](docs/SHARD-LAYOUT.md) | Dev guide: [`CLAUDE.md`](CLAUDE.md)

## How to use this roadmap

1. Open this file.
2. Find the first unchecked (`[ ]`) item in the earliest uncompleted milestone.
3. Open the linked issue; read its description for scope + acceptance.
4. **Before touching code**: read [`CLAUDE.md §Working Agreement`](CLAUDE.md#working-agreement-v6-execution-standard) — spec-before-code, tests-before-implementation, adversarial enumeration, quality gate, and session hygiene. Non-negotiable for v6 sub-issues.
5. Execute. Check the box here + close the issue on merge.

---

## v0.1.0 — The Engine (April 2026)

Ship the core: install, update, status. Prove that vault template upgrades work where every other tool failed.

### Milestone 1: Foundation (Day 1) — shipped

- [x] Scaffold with `create-pastel-app` ([#1](https://github.com/breferrari/shardmind/issues/1))
- [x] `source/core/manifest.ts` — parse + validate shard.yaml with zod ([#2](https://github.com/breferrari/shardmind/issues/2))
- [x] `source/core/schema.ts` — parse shard-schema.yaml, generate dynamic zod validator ([#3](https://github.com/breferrari/shardmind/issues/3))
- [x] `source/core/download.ts` — fetch GitHub tarball, extract to temp dir ([#4](https://github.com/breferrari/shardmind/issues/4))
- [x] `source/core/renderer.ts` — Nunjucks engine, frontmatter-aware split/render/recombine ([#5](https://github.com/breferrari/shardmind/issues/5))
- [x] `source/core/modules.ts` — walk template dir, classify by module, resolve file lists ([#6](https://github.com/breferrari/shardmind/issues/6))
- [x] `source/runtime/types.ts` + `runtime/index.ts` — shared types and exports ([#7](https://github.com/breferrari/shardmind/issues/7))
- [x] CI/CD — GitHub Actions for typecheck, test, build, npm publish ([#16](https://github.com/breferrari/shardmind/issues/16))
- [x] Unit tests: manifest, schema, renderer (5 fixture scenarios), modules
- [x] `shardmind --version` works

### Milestone 2: Install Command (Day 2) — shipped

- [x] `source/core/state.ts` + `source/core/registry.ts` ([#9](https://github.com/breferrari/shardmind/issues/9))
- [x] `commands/install.tsx` — full install flow with Ink wizard ([#8](https://github.com/breferrari/shardmind/issues/8))
- [x] Integration test: install pipeline against `examples/minimal-shard` (real obsidian-mind shard verified at Milestone 5)
- [x] `ink-testing-library` component tests for ValueInput, ModuleReview, ExistingInstallGate, InstallWizard ([#38](https://github.com/breferrari/shardmind/issues/38) — pulled forward from v0.2)

### Milestone 3: Merge Engine (Day 3) — shipped

- [x] Write all 17 merge fixture directories — fixtures before code ([#10](https://github.com/breferrari/shardmind/issues/10))
- [x] `core/drift.ts` + `core/differ.ts` — three-way merge engine ([#11](https://github.com/breferrari/shardmind/issues/11))
- [x] Iterate until all 17 scenarios pass
- [x] Add edge case fixtures: empty file (18), UTF-8 non-ASCII (19), frontmatter merge on modified ownership (20). Hash-identical behavior already covered by scenarios 01 and 05

### Milestone 4: Update Command + Status (Day 4) — shipped

- [x] `commands/update.tsx` — upgrade flow with drift detection + DiffView ([#12](https://github.com/breferrari/shardmind/issues/12))
- [x] `commands/index.tsx` — status display + `--verbose` diagnostics ([#13](https://github.com/breferrari/shardmind/issues/13))
- [x] Integration test: install → modify files → update → verify merge behavior
- [x] E2E test: all 3 commands via CLI invocation ([#54](https://github.com/breferrari/shardmind/issues/54))

### Milestone 4.5: v6 Layout Integration — **active** (tracked in [#70](https://github.com/breferrari/shardmind/issues/70))

Engine rework required by the v6 shard-layout contract. Must land before Milestone 5. Spec: [`docs/SHARD-LAYOUT.md`](docs/SHARD-LAYOUT.md).

- [x] Flat shard-root walk + Tier 1 exclusions + `.shardmindignore` parser ([#73](https://github.com/breferrari/shardmind/issues/73))
- [x] Schema defaults enforcement + drop `partials` field ([#74](https://github.com/breferrari/shardmind/issues/74))
- [x] `HookContext` extensions (`valuesAreDefaults`, `newFiles`, `removedFiles`) + post-hook re-hash ([#75](https://github.com/breferrari/shardmind/issues/75))
- [x] Ref installs (`github:owner/repo#<ref>`) + update semantics (`--release`, `--include-prerelease`, ref re-resolution) ([#76](https://github.com/breferrari/shardmind/issues/76))
- [x] `shardmind adopt` command (2-way diff UI + adopt-planner + adopt-executor) ([#77](https://github.com/breferrari/shardmind/issues/77))
- [x] `install --defaults` flag + **Invariant 1 byte-equivalence CI test** ([#78](https://github.com/breferrari/shardmind/issues/78))
- [ ] **Contract acceptance suite** — full install / update (no-conflict + with-conflict) / adopt / additive-principle / hook-failure / adversarial scenario matrix ([#92](https://github.com/breferrari/shardmind/issues/92))

### Milestone 5: Flagship Shard (Day 5) — blocked on Milestone 4.5

- [ ] obsidian-mind v6 conversion — `.shardmind/` sidecar, hooks, `.shardmindignore` ([#14](https://github.com/breferrari/shardmind/issues/14), under [#70](https://github.com/breferrari/shardmind/issues/70))
- [x] Finalize post-install hook runtime ([#30](https://github.com/breferrari/shardmind/issues/30))
- [ ] Verify: `shardmind install github:breferrari/obsidian-mind` (direct mode) produces a vault byte-equivalent to git clone under Invariant 1 ([#78](https://github.com/breferrari/shardmind/issues/78))

### Milestone 6: Ship (Day 6) — blocked on Milestone 5

- [ ] Research-wiki shard + E2E tests + npm publish ([#15](https://github.com/breferrari/shardmind/issues/15))
- [ ] Create `shardmind/registry` repo with index.json (2 shards) — finalize schema per [#29](https://github.com/breferrari/shardmind/issues/29)
- [ ] v6 docs polish: fold remaining SHARD-LAYOUT.md content into ARCHITECTURE §3 + IMPLEMENTATION §4.5/§4.5a/§4.5b once #74-#78 land; rewrite IMPLEMENTATION §9 (Build Plan) to match the actual #70 task series ([#85](https://github.com/breferrari/shardmind/issues/85)) — partial rewrites for §3, AUTHORING §2, IMPLEMENTATION §4.2/§4.5/§4.5a/§4.5b/§4.7 already landed with #73
- [ ] Final test: fresh machine → `npm install -g shardmind` → `shardmind install breferrari/obsidian-mind` (registry mode, proves [#29](https://github.com/breferrari/shardmind/issues/29) shape works end-to-end) ([#15](https://github.com/breferrari/shardmind/issues/15))

---

## v0.2.0 — Composition & Polish (Q2–Q3 2026)

Deferred from v0.1 per [`docs/SHARD-LAYOUT.md §Out of scope`](docs/SHARD-LAYOUT.md#out-of-scope--deferred-to-v02) + [`VISION.md §Current Priorities`](VISION.md). Build only after v0.1 is stable and adoption signals are real. Each feature has an umbrella issue tracking its sub-tasks.

### Core features

- [ ] Guided file creation (`guided_files` schema + third install phase) ([#79](https://github.com/breferrari/shardmind/issues/79))
- [ ] Structural variants (`modules.structure` + `vault_purpose`) ([#80](https://github.com/breferrari/shardmind/issues/80))
- [ ] Shard composition (multi-shard per vault) ([#81](https://github.com/breferrari/shardmind/issues/81))
- [ ] Dependency fetching (recursive + lock file) ([#82](https://github.com/breferrari/shardmind/issues/82))
- [ ] `shardmind eject` command ([#83](https://github.com/breferrari/shardmind/issues/83))
- [ ] `shardmind init` command for shard authors ([#84](https://github.com/breferrari/shardmind/issues/84))

### Layout / contract extensions (deferred from v0.1)

Tracked in [`docs/SHARD-LAYOUT.md §Out of scope`](docs/SHARD-LAYOUT.md#out-of-scope--deferred-to-v02).

- [ ] `rendered_files` opt-in (Nunjucks at vault-visible paths) ([#86](https://github.com/breferrari/shardmind/issues/86))
- [ ] `.shardmindignore` negation (`!pattern`) ([#87](https://github.com/breferrari/shardmind/issues/87))
- [ ] Rename migrations + `shardmind adopt --from-version` — **must ship before any obsidian-mind release that introduces path renames** ([#88](https://github.com/breferrari/shardmind/issues/88))

### Engine polish (from v0.1 review)

Deferred items surfaced during the v0.1 polish-pass architecture audit. None are blockers for shipping v0.1; all are worth doing before v0.2 marketing.

- [ ] VaultFS abstraction with built-in rollback tracking ([#33](https://github.com/breferrari/shardmind/issues/33))
- [ ] `shardmind validate <shard>` command ([#34](https://github.com/breferrari/shardmind/issues/34))
- [ ] Pre-install template syntax lint ([#35](https://github.com/breferrari/shardmind/issues/35))
- [ ] Debug logging (`SHARDMIND_DEBUG` env var) ([#36](https://github.com/breferrari/shardmind/issues/36))
- [ ] `NO_COLOR` / `FORCE_COLOR` respect across Ink components ([#37](https://github.com/breferrari/shardmind/issues/37))
- [ ] Alternate registry configurability (GHE, private, custom URL) ([#39](https://github.com/breferrari/shardmind/issues/39))
- [ ] Encode state-schema migration rules (uses v0.1 framework) ([#40](https://github.com/breferrari/shardmind/issues/40))
- [ ] Re-evaluate `@inkjs/ui` dependency ([#43](https://github.com/breferrari/shardmind/issues/43))
- [ ] Drop `LineInterner` workaround once `node-diff3` releases the prototype-lookup fix ([#49](https://github.com/breferrari/shardmind/issues/49))
- [ ] `$EDITOR` integration for DiffView conflict resolution ([#50](https://github.com/breferrari/shardmind/issues/50))
- [x] 24h update-check cache shared between status + update ([#51](https://github.com/breferrari/shardmind/issues/51) — shipped with #13)
- [ ] DiffView: distinguish preexisting add-collision from modified-file conflict ([#60](https://github.com/breferrari/shardmind/issues/60))
- [ ] `--yes` policy for preexisting add-collisions ([#61](https://github.com/breferrari/shardmind/issues/61))
- [ ] Byte-identical preexisting add-collision adopts silently ([#62](https://github.com/breferrari/shardmind/issues/62))
- [ ] Binary files bypass three-way merge entirely ([#63](https://github.com/breferrari/shardmind/issues/63))
- [ ] `docs/IMPLEMENTATION.md` §4.11a / §4.11b for install-planner + install-executor ([#64](https://github.com/breferrari/shardmind/issues/64))
- [ ] Enforce tarball size cap in `downloadShard` ([#32](https://github.com/breferrari/shardmind/issues/32))
- [ ] `--force` flag on install for scripted collision overwrite without backup ([#55](https://github.com/breferrari/shardmind/issues/55))
- [ ] E2E: bridge SIGINT delivery reliably on GH Actions Windows runner ([#57](https://github.com/breferrari/shardmind/issues/57))

---

## v1.0.0 — Ecosystem (2026–2027)

Only after the engine is proven, the flagship shard is stable, and community shards exist. Each area has a parent umbrella issue; sub-tasks detailed as scoping begins.

### Registry (hosted) ([#89](https://github.com/breferrari/shardmind/issues/89))

- [ ] Hosted registry (shardmind.dev) with shard discovery and search
- [ ] Shard metadata indexing from GitHub repos
- [ ] Version history and changelog display
- [ ] `shardmind search` command

### Community ([#90](https://github.com/breferrari/shardmind/issues/90))

- [x] Shard authoring guide ([`docs/AUTHORING.md`](docs/AUTHORING.md), shipped in v0.1 polish pass)
- [ ] Shard validation CI (GitHub Action for shard authors)
- [ ] Community shard listing
- [ ] Fork-to-shard conversion guide (for obsidian-mind fork authors)

### Teams (if demand signals appear) ([#91](https://github.com/breferrari/shardmind/issues/91))

- [ ] Managed vault templates for organizations
- [ ] Shared values with org-level defaults
- [ ] Admin controls for module enforcement
- [ ] Team sync for `brain/` namespaces

---

## Principles

**Ship the engine, not the platform.** v0.1 has no registry server, no web UI, no accounts. The engine (install, update, merge) is the value. Everything else follows.

**Convention over configuration.** 4 values, 3 commands. The vault ships complete. Users subtract, not add.

**Prove with obsidian-mind first.** The flagship shard must be indistinguishable from a git clone before any other shard matters. If the install experience is worse than `git clone`, nothing else matters.

**The moat is the update engine.** Every feature decision should be evaluated against: "does this make upgrades better?" If not, it can wait.

**Agent-agnostic engine, agent-specific shards.** ShardMind renders templates. Shard authors decide which AIs to support. Don't couple the engine to any agent.

**Invariant 1 is law.** `shardmind install --defaults <shard>` produces a vault byte-equivalent to `git clone <shard>` (modulo Tier 1 exclusions + `.shardmind/` engine metadata + vault-root `shard-values.yaml`). If CI catches a diff, the shard or the engine is wrong.

---

## Non-Goals (Permanent)

These are not on any roadmap version. They represent scope boundaries.

- **GUI for ShardMind itself.** The CLI + TUI is the product. A web UI for managing shards adds complexity without value for the developer audience.
- **Non-Obsidian targets.** Logseq, Notion, etc. have fundamentally different file formats. Supporting them would dilute the engine.
- **AI in the engine.** ShardMind is a package manager. It doesn't read note content, classify semantically, or make AI-powered decisions. That's the shard's job (via hooks and agents). The engine is deterministic.
- **Paid tiers on ShardMind itself.** The engine is MIT. The business (if it becomes one) is managed team templates, not CLI licensing.
