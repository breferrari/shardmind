# ShardMind Roadmap

> Living document. Updated as priorities shift and milestones land.
>
> Context: [`VISION.md`](VISION.md) | Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Implementation: [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) | Dev guide: [`CLAUDE.md`](CLAUDE.md)

---

## v0.1.0 — The Engine (April 2026)

Ship the core: install, update, status. Prove that vault template upgrades work where every other tool failed.

### Milestone 1: Foundation (Day 1)

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

### Milestone 2: Install Command (Day 2)

- [x] `source/core/state.ts` + `source/core/registry.ts` ([#9](https://github.com/breferrari/shardmind/issues/9))
- [x] `commands/install.tsx` — full install flow with Ink wizard ([#8](https://github.com/breferrari/shardmind/issues/8))
- [x] Integration test: install pipeline against `examples/minimal-shard` (real obsidian-mind shard verified at Milestone 5)
- [x] `ink-testing-library` component tests for ValueInput, ModuleReview, ExistingInstallGate, InstallWizard ([#38](https://github.com/breferrari/shardmind/issues/38) — pulled forward from v0.2)

### Milestone 3: Merge Engine (Day 3)

- [ ] Write all 17 merge fixture directories — fixtures before code ([#10](https://github.com/breferrari/shardmind/issues/10))
- [ ] `core/drift.ts` + `core/differ.ts` — three-way merge engine ([#11](https://github.com/breferrari/shardmind/issues/11))
- [ ] Iterate until all 17 scenarios pass
- [ ] Add edge case fixtures: frontmatter merge, empty file, binary-identical, encoding

### Milestone 4: Update Command + Status (Day 4)

- [ ] `commands/update.tsx` — upgrade flow with drift detection + DiffView ([#12](https://github.com/breferrari/shardmind/issues/12))
- [ ] `commands/index.tsx` — status display + --verbose diagnostics ([#13](https://github.com/breferrari/shardmind/issues/13))
- [ ] Integration test: install → modify files → update → verify merge behavior
- [ ] E2E test: all 3 commands via CLI invocation

### Milestone 5: Flagship Shard (Day 5)

- [ ] obsidian-mind v4 — convert to shard format ([#14](https://github.com/breferrari/shardmind/issues/14))
- [ ] Finalize post-install hook runtime ([#30](https://github.com/breferrari/shardmind/issues/30)) — first real hook arrives with obsidian-mind
- [ ] Verify: `shardmind install github:breferrari/obsidian-mind` (direct mode) produces identical vault to git clone — the registry repo isn't created until Milestone 6

### Milestone 6: Ship (Day 6)

- [ ] Research-wiki shard + E2E tests + npm publish ([#15](https://github.com/breferrari/shardmind/issues/15))
- [ ] Create `shardmind/registry` repo with index.json (2 shards) — finalize schema per [#29](https://github.com/breferrari/shardmind/issues/29)
- [ ] Final test: fresh machine → `npm install -g shardmind` → `shardmind install breferrari/obsidian-mind` (registry mode, proves #29 shape works end-to-end)

---

## v0.2.0 — Composition & Polish (Q2–Q3 2026)

Deferred from v0.1. Build only after v0.1 is stable and adoption signals are real.

### Guided File Creation

- [ ] `guided_files` section in shard-schema.yaml
- [ ] Third install phase: guided prompts for files like SOUL.md
- [ ] Render partially populated files from wizard answers + template structure

### Structural Variants

- [ ] `modules.structure` field with purpose-driven folder variants
- [ ] `vault_purpose` drives folder structure, not just CLAUDE.md framing
- [ ] Design doc: the Vigil Mind Reshape decision record

### Shard Composition

- [ ] `state.json` schema_version 2 with `shards[]`
- [ ] Multiple shards in one vault (base shard + overlay shard)
- [ ] Module conflict resolution between shards
- [ ] `shardmind list` command (now useful with multiple shards)

### Dependency Fetching

- [ ] `registry.ts` gains `fetchDependencies()` method
- [ ] Recursive download loop for declared dependencies
- [ ] Lock file for transitive dependency resolution

### Eject

- [ ] `shardmind eject` command
- [ ] Clean removal of `.shardmind/` and `shard-values.yaml`
- [ ] Confirm prompt with file count

### Init

- [ ] `shardmind init` command for shard authors
- [ ] Scaffold `shard.yaml`, `shard-schema.yaml`, `templates/` from prompts
- [ ] Generate starter module structure

### Engine polish (from v0.1 review)

Deferred items surfaced during the v0.1 polish-pass architecture audit. None are blockers for shipping v0.1; all are worth doing before v0.2 marketing.

- [ ] VaultFS abstraction with built-in rollback tracking ([#33](https://github.com/breferrari/shardmind/issues/33))
- [ ] `shardmind validate <shard>` command ([#34](https://github.com/breferrari/shardmind/issues/34))
- [ ] Pre-install template syntax lint ([#35](https://github.com/breferrari/shardmind/issues/35))
- [ ] Debug logging (`SHARDMIND_DEBUG` env var) ([#36](https://github.com/breferrari/shardmind/issues/36))
- [ ] `NO_COLOR` / `FORCE_COLOR` respect across Ink components ([#37](https://github.com/breferrari/shardmind/issues/37))
- [ ] Alternate registry configurability (GHE, private, custom URL) ([#39](https://github.com/breferrari/shardmind/issues/39))
- [ ] Encode state-schema migration rules (uses v0.1 framework) ([#40](https://github.com/breferrari/shardmind/issues/40))
- [ ] Re-evaluate `@inkjs/ui` dependency (upstream frozen; shim at `source/components/ui.ts` keeps swap cheap) ([#43](https://github.com/breferrari/shardmind/issues/43))

---

## v1.0.0 — Ecosystem (2026–2027)

Only after the engine is proven, the flagship shard is stable, and community shards exist.

### Registry

- [ ] Hosted registry (shardmind.dev) with shard discovery and search
- [ ] Shard metadata indexing from GitHub repos
- [ ] Version history and changelog display
- [ ] `shardmind search` command

### Community

- [x] Shard authoring guide ([`docs/AUTHORING.md`](docs/AUTHORING.md), shipped in v0.1 polish pass)
- [ ] Shard validation CI (GitHub Action for shard authors)
- [ ] Community shard listing
- [ ] Fork-to-shard conversion guide (for obsidian-mind fork authors)

### Teams (if demand signals appear)

- [ ] Managed vault templates for organizations
- [ ] Shared values with org-level defaults
- [ ] Admin controls for module enforcement
- [ ] Team sync for brain/ namespaces

---

## Principles

**Ship the engine, not the platform.** v0.1 has no registry server, no web UI, no accounts. The engine (install, update, merge) is the value. Everything else follows.

**Convention over configuration.** 4 values, 3 commands. The vault ships complete. Users subtract, not add.

**Prove with obsidian-mind first.** The flagship shard must be indistinguishable from a git clone before any other shard matters. If the install experience is worse than `git clone`, nothing else matters.

**The moat is the update engine.** Every feature decision should be evaluated against: "does this make upgrades better?" If not, it can wait.

**Agent-agnostic engine, agent-specific shards.** ShardMind renders templates. Shard authors decide which AIs to support. Don't couple the engine to any agent.

---

## Non-Goals (Permanent)

These are not on any roadmap version. They represent scope boundaries.

- **GUI for ShardMind itself.** The CLI + TUI is the product. A web UI for managing shards adds complexity without value for the developer audience.
- **Non-Obsidian targets.** Logseq, Notion, etc. have fundamentally different file formats. Supporting them would dilute the engine.
- **AI in the engine.** ShardMind is a package manager. It doesn't read note content, classify semantically, or make AI-powered decisions. That's the shard's job (via hooks and agents). The engine is deterministic.
- **Paid tiers on ShardMind itself.** The engine is MIT. The business (if it becomes one) is managed team templates, not CLI licensing.
