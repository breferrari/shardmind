# ShardMind Roadmap

> Living document. Updated as priorities shift and milestones land.

---

## v0.1.0 — The Engine (April 2026)

Ship the core: install, update, status. Prove that vault template upgrades work where every other tool failed.

### Milestone 1: Foundation (Day 1)

- [ ] Scaffold with `create-pastel-app`
- [ ] Configure tsup dual entry (cli + runtime)
- [ ] Set up vitest
- [ ] `source/core/manifest.ts` — parse + validate shard.yaml with zod
- [ ] `source/core/schema.ts` — parse shard-schema.yaml, generate dynamic zod validator
- [ ] `source/core/download.ts` — fetch GitHub tarball, extract to temp dir
- [ ] `source/core/renderer.ts` — Nunjucks engine, frontmatter-aware split/render/recombine
- [ ] `source/core/modules.ts` — walk template dir, classify by module, resolve file lists
- [ ] `source/runtime/types.ts` — all shared types (ShardState, ShardSchema, etc.)
- [ ] `source/runtime/index.ts` — loadValues, loadSchema, loadState, validateFrontmatter exports
- [ ] Unit tests: manifest, schema, renderer (5 fixture scenarios), modules
- [ ] `shardmind --version` works

### Milestone 2: Install Command (Day 2)

- [ ] `source/core/state.ts` — read/write state.json, init .shardmind/, cache templates
- [ ] `source/core/registry.ts` — resolve shard ref → GitHub URL + version
- [ ] `source/components/Header.tsx` — branded header
- [ ] `source/components/InstallWizard.tsx` — value prompts from schema groups
- [ ] `source/components/ModuleReview.tsx` — multiselect for removable modules
- [ ] `source/commands/install.tsx` — full flow: resolve → download → prompt → render → write
- [ ] Integration test: install pipeline against real obsidian-mind shard (temp dir)
- [ ] Verify: `shardmind install breferrari/obsidian-mind` works end to end

### Milestone 3: Merge Engine (Day 3)

- [ ] Write all 17 merge fixture directories (scenarios 01–17)
- [ ] Write test runner that auto-discovers fixtures
- [ ] Run tests → all 17 fail (TDD)
- [ ] `source/core/drift.ts` — ownership detection, hash comparison, drift classification
- [ ] `source/core/differ.ts` — three-way merge via node-diff3, conflict markers
- [ ] Iterate until all 17 scenarios pass
- [ ] Add edge case fixtures: frontmatter merge, empty file, binary-identical, encoding

### Milestone 4: Update Command + Status (Day 4)

- [ ] `source/core/migrator.ts` — apply schema migrations to values
- [ ] `source/components/DiffView.tsx` — three-way diff display with action buttons
- [ ] `source/commands/update.tsx` — full flow: fetch → migrate → drift → merge → write
- [ ] `source/components/StatusView.tsx` — quick vault health
- [ ] `source/components/VerboseView.tsx` — detailed diagnostics
- [ ] `source/commands/index.tsx` — root status command + --verbose flag
- [ ] Integration test: install → modify files → update → verify merge behavior
- [ ] E2E test: all 3 commands via CLI invocation

### Milestone 5: Flagship Shard (Day 5)

- [ ] Add `shard.yaml` to obsidian-mind repo
- [ ] Add `shard-schema.yaml` (4 values, 8 modules, signals, frontmatter rules)
- [ ] Convert all note templates to `.njk`
- [ ] Break CLAUDE.md into partials (`claude/_core.md.njk`, `_perf.md.njk`, etc.)
- [ ] Add `AGENTS.md.njk` and `GEMINI.md.njk` stubs for multi-agent support
- [ ] Rewrite 5 hook scripts from Python/shell to TypeScript (importing `shardmind/runtime`)
- [ ] Mark volatile files: Memories.md, Index files
- [ ] Add `templates/settings.json.njk` for hook configuration
- [ ] Verify: `shardmind install breferrari/obsidian-mind` produces identical vault to git clone

### Milestone 6: Ship (Day 6)

- [ ] Create research-wiki shard (Karpathy pattern): shard.yaml, schema, templates, commands, agents
- [ ] Test: `shardmind install breferrari/research-wiki`
- [ ] Full E2E test suite passing
- [ ] `npm publish shardmind`
- [ ] Create `shardmind/registry` repo with index.json (2 shards)
- [ ] README finalized
- [ ] Final test: fresh machine → `npm install -g shardmind` → `shardmind install breferrari/obsidian-mind`

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

---

## v1.0.0 — Ecosystem (2026–2027)

Only after the engine is proven, the flagship shard is stable, and community shards exist.

### Registry

- [ ] Hosted registry (shardmind.dev) with shard discovery and search
- [ ] Shard metadata indexing from GitHub repos
- [ ] Version history and changelog display
- [ ] `shardmind search` command

### Community

- [ ] Shard authoring guide (docs/AUTHORING.md)
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
