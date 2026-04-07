# ShardMind Vision

ShardMind is a package manager for Obsidian vault templates.
It installs, configures, upgrades, and diagnoses AI-augmented vaults.

This document explains where the project came from, why it exists, and where it's going.
Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
Implementation: [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md)

## Origin

ShardMind started from a pattern observed in [obsidian-mind](https://github.com/breferrari/obsidian-mind), an Obsidian vault template for Claude Code that hit 1.3k stars in 3 days.

Within the first week, 169 forks appeared. Three of them were analyzed in depth — a solo Rails developer at a research hospital, a Codex/OpenClaw agent-layer adaptation, and the author's own reshape from company-engineer to creator-builder. All three performed the same 8-category surgery independently:

1. Folder restructure
2. Command swap
3. Signal swap
4. Base swap
5. Frontmatter swap
6. Template swap
7. Agent prune
8. Manifest update

Same categories. Same operations. Different domains. Nobody coordinated. The surgery is predictable because the architecture has a universal core (hooks, brain layer, session lifecycle, semantic search) and domain-specific muscles (folders, commands, signals, templates) that people naturally reshape for their context.

That's a product specification, not a coincidence.

The same week, Karpathy published his LLM Wiki pattern (April 2-4, 2026) — a three-layer architecture for LLM-maintained markdown knowledge bases. It converged on the same design from a completely different starting point: raw sources, compiled wiki, schema file. The market for AI-augmented markdown vaults went from niche to visible overnight.

The problem became clear: there is no standardized way to discover, install, version, compose, or upgrade vault templates. Every project ships as a monolithic git clone with manual setup. Fork authors diverge from upstream with no path back. Users who edit rendered files lose the ability to pull template updates.

## The Upgrade Problem

This is the hard problem. And nobody has solved it.

Backstage (Spotify's developer portal, 30k+ stars) has had "propagate template updates to existing projects" as an open feature request since November 2022. Three years, no solution shipped. The community workarounds are cruft (brittle) and migration bots (manual).

Every existing scaffolding tool falls into one of two traps:

**Trap 1: Render once, abandon upgrades.** Cookiecutter, create-react-app, Yeoman, Plop. They render templates into final files and walk away. The user edits those files. When the template updates, there's no path back.

**Trap 2: User never touches output.** Helm, Terraform, Ansible. They own the rendered output entirely. If the user edits a managed file, the next upgrade overwrites it silently. This works for infrastructure (machines don't care about hand-edits) but fails for knowledge vaults — humans absolutely edit their notes. That's the whole point of Obsidian.

ShardMind takes a third path: templates upgrade cleanly, users edit output freely, and the system knows which is which.

## Core Architectural Bets

**Three-state model with ownership tracking.** Adapted from Terraform's drift detection and chezmoi's source/target/destination model. Every managed file has a hash in the state file. On update, if the hash matches, the file is still managed — safe to re-render silently. If the hash differs, the user edited it — show a three-way diff in the TUI. User-created files are never touched.

**Values vs modules.** Two separate mechanisms control a vault's shape. Values control what goes inside files (your name, org, vault purpose). Modules control what files exist (perf tracking, incident management, 1:1 notes). This separation keeps the update engine tractable — modules are included or excluded, no in-between conditional rendering states.

**Signals in the schema.** Classification signals define how the vault routes content. A researcher needs FINDING, HYPOTHESIS, SOURCE_EVALUATION. A freelancer needs CLIENT_UPDATE, INVOICE, MILESTONE. An engineer needs INCIDENT, DECISION, WIN. The classification hook reads signals from the schema at runtime — fully data-driven, no hardcoded signal lists.

**Convention over configuration.** obsidian-mind ships 4 values and 1 TUI screen. Not 15 toggles and a wizard. Empty Obsidian folders cost nothing. Unused slash commands sit silently. The vault ships complete; users exclude modules they don't need during install by deselecting them. Most press Enter.

**Cached templates for three-way merge.** The `.shardmind/templates/` directory stores the templates that produced the current rendered files. This is the base in the three-way merge during update. Without it, you can't compute a proper diff for modified files. This is the implementation detail that makes upgrades work — and the piece every other tool is missing.

## Agent-Agnostic Engine, Agent-Specific Shards

ShardMind the engine knows nothing about Claude Code, Codex, or Gemini CLI. It renders templates, tracks file state, manages modules, and runs the merge engine. The agent choice belongs to the shard, not the engine.

A shard can ship `CLAUDE.md` only (Claude Code-first), all three operating manuals (`CLAUDE.md` + `AGENTS.md` + `GEMINI.md`), or any combination. The vault's markdown notes, frontmatter, folder structure, and bases are completely agent-agnostic — any AI can read them.

The operational layer is where agent specificity lives:
- **Claude Code**: `.claude/commands/`, `.claude/agents/`, `.claude/settings.json` (5-hook lifecycle), `.claude/skills/`
- **Codex**: `AGENTS.md`, `.codex/prompts/`
- **Gemini**: `GEMINI.md`, `save_memory` / `/memory` commands

Claude Code is first-class in obsidian-mind because it has the richest hook system — five lifecycle hooks with external interception points that neither Codex nor Gemini CLI offers. That's an architectural advantage of Claude Code, not a limitation of ShardMind.

The `shardmind/runtime` module is used by hook scripts, and hooks are a Claude Code concept. Other agents that add hook systems in the future can use the same runtime module. It's TypeScript — any Node.js-based agent can import it.

## What ShardMind Is Not

**Not a registry first.** The registry is a single JSON file on GitHub. Versions come from git tags. No database, no server. Distribution is GitHub tarballs. The value is the engine, not the platform.

**Not a general-purpose scaffolding tool.** ShardMind is designed for Obsidian vaults managed by AI coding agents. The frontmatter-aware rendering, the classification signals, the CLAUDE.md partial system, the hook contract — these are specific to this domain. A generic scaffolding tool wouldn't have them.

**Not a replacement for obsidian-mind.** obsidian-mind is the flagship shard. ShardMind is the engine that makes it installable, configurable, and upgradeable. They ship together. obsidian-mind proves the format. ShardMind distributes it.

**Not dependent on ShardMind to function.** A vault installed by ShardMind works exactly the same without ShardMind. Delete `.shardmind/` and `shard-values.yaml` — the vault continues to work in Obsidian and Claude Code. ShardMind is additive, not load-bearing.

## Current Priorities

**v0.1 — Ship the engine:**

- `shardmind install` with TUI wizard (4 values + module review)
- `shardmind update` with drift detection and three-way merge
- `shardmind` status display with `--verbose` diagnostics
- obsidian-mind as the flagship shard (shard.yaml, shard-schema.yaml, .njk templates)
- Research-wiki shard implementing the Karpathy pattern
- `shardmind/runtime` module for TypeScript hooks
- 17 fixture-driven merge tests (TDD)
- npm publish

**Deferred to v0.2+:**

- Dependency fetching (shard authors vendor deps in v0.1)
- Shard composition (one shard per vault in v0.1)
- Structural variants (different purposes = different shards in v0.1)
- SOUL guided creation (empty template in v0.1)
- `shardmind init` for shard authors
- `shardmind eject` (manual for v0.1: delete `.shardmind/`)

## Technology

TypeScript, unified across CLI and hooks. One language, one runtime.

The CLI is built with Pastel (Next.js for terminals, by the Ink author). The TUI uses Ink + @inkjs/ui for React-based terminal components. Templates use Nunjucks (`{{ }}` syntax, the industry standard from Jinja2/Ansible/Helm). The merge engine uses node-diff3 (Khanna-Myers algorithm, same approach as git).

The `shardmind/runtime` module is a separately bundled export (~30KB) with zero dependency on Ink, React, or the CLI framework. Hook scripts import it to read values and validate frontmatter without pulling in the UI layer.

## What We Will Not Build (For Now)

- A GUI or web interface for shard management
- A hosted registry with accounts and publishing workflows
- First-class support for non-Obsidian markdown tools (Logseq, Notion, etc.)
- A plugin system within ShardMind itself (shards ARE the extension mechanism)
- Template inheritance across shards (composition is deferred; each shard is self-contained in v0.1)
- AI-powered migration that reads note content to classify it (that's `/vault-upgrade` in obsidian-mind, not ShardMind's job — ShardMind is a package manager, not an AI)

This list is a scope guardrail, not permanent.
Strong user demand and strong technical rationale can change it.

## The Moat

ShardMind's update engine — hash-based drift detection, cached templates for three-way merge, declarative migrations, ownership-aware file handling — solves a problem that the biggest scaffolding platforms haven't solved in years. That's the moat. Not the registry. Not the TUI. The update engine.
