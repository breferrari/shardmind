# ShardMind

[![TypeScript](https://img.shields.io/badge/typescript-5.0%2B-3178C6)](https://www.typescriptlang.org)
[![Node](https://img.shields.io/badge/node-18%2B-339933)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **A package manager for Obsidian vault templates.**
> Install, configure, upgrade, and diagnose AI-augmented vaults.

---

## The Problem

Vault templates ship as monolithic git clones. Fork authors diverge from upstream with no path back. Users who edit rendered files lose the ability to pull template updates. Backstage (Spotify, 30k+ stars) has had "propagate template updates to existing projects" as an open feature request since November 2022. Cookiecutter, create-react-app, and Yeoman all gave up on upgrades.

## The Solution

ShardMind separates templates from values. Users only ever edit their values. Templates upgrade cleanly. The system knows which files the user touched and which are still pristine.

```
shardmind install breferrari/obsidian-mind

  Quick Setup

  Your name: Brenno Ferrari
  Organization: Independent
  Purpose: Engineering
  QMD enabled: Yes

  Your vault will include:

  brain/          Goals, memories, patterns, decisions
  work/           Active projects, archive
  reference/      Codebase knowledge, architecture
  org/            People, teams
  perf/           Brag doc, competencies, reviews

  Installed. 51 files. Open in Obsidian and run: claude
```

```
shardmind update

  breferrari/obsidian-mind v3.5.0 -> v4.0.0

  43 files unchanged (silent re-render)
   2 files updated (no conflict)
   1 file needs your review:

  CLAUDE.md — you added a custom section
  [Accept new] [Keep mine] [Open in editor] [Skip]

  Updated. 43 silent. 2 merged. 1 reviewed.
```

---

## How It Works

### Three-State Model

Adapted from Terraform and chezmoi. Templates define the desired state. The vault is the actual state. A state file tracks what was rendered and when.

- **Managed** files (user never edited) upgrade silently
- **Modified** files (user edited) get a three-way diff in the TUI
- **User** files (created by the user, not from any template) are never touched

### Values vs Modules

**Values** control what goes *inside* files — your name, org, vault purpose. 4 values, 30 seconds.

**Modules** control what files *exist* — perf tracking, incident management, 1:1 notes. Toggle during install. Defaults all included.

### Signals

Classification signals define how the vault routes content. Core signals (DECISION, WIN, PATTERN) always apply. Module-gated signals (INCIDENT, 1:1) only apply if their module is included. The classification hook reads signals from the schema at runtime — fully data-driven.

---

## Commands

```bash
shardmind                              # Status + health
shardmind install <namespace/name>     # Install a shard
shardmind update                       # Upgrade to latest version
shardmind --verbose                    # Detailed diagnostics
```

Three commands. Two that write. One that reads. No menu, no wizard fatigue. Status-first.

---

## Technology

Built with [Pastel](https://github.com/vadimdemedes/pastel) (Next.js for CLIs), [Ink](https://github.com/vadimdemedes/ink) (React for terminals), and [Nunjucks](https://mozilla.github.io/nunjucks/) (Jinja2 for JavaScript).

| Layer | Stack |
|-------|-------|
| Framework | Pastel (file-system routing, zod arg parsing, Commander under the hood) |
| TUI | Ink + @inkjs/ui (Select, TextInput, Spinner, ProgressBar, DiffView) |
| Templates | Nunjucks (`{{ }}` syntax, frontmatter-aware rendering) |
| Validation | zod (shared between CLI args and schema validation) |
| Merge | node-diff3 (Khanna-Myers three-way merge, same algorithm as git) |
| Distribution | GitHub tarballs (no registry server needed) |

### Runtime Module

Hook scripts import `shardmind/runtime` — a thin exported module (~30KB) with zero dependency on Ink, React, or the CLI framework:

```typescript
import { loadValues, loadState, validateFrontmatter } from 'shardmind/runtime';
```

---

## Shard Anatomy

A shard is a packaged vault template. It includes folder structures, markdown templates, hooks, commands, agents, and a values schema that drives the install wizard.

```
my-shard/
  shard.yaml              # Package identity (name, version, deps)
  shard-schema.yaml       # Values + modules + signals + frontmatter + migrations
  templates/              # Nunjucks templates (.njk)
    CLAUDE.md.njk         # Assembled from per-module partials
    claude/               # CLAUDE.md partials (one per module)
    brain/
    work/
    perf/
  commands/               # Slash commands (conditionally installed by module)
  agents/                 # Subagents (conditionally installed by module)
  scripts/                # TypeScript hook scripts
  skills/                 # Agent skills
```

---

## Architecture

Full documentation in `docs/`:

| Document | What |
|----------|------|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The what and why. 22 sections. Core concepts, ownership model, schema format, module system, operations, competitive moat. |
| [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) | The how, exactly. 10 sections. System diagram, data flows, module specs with TypeScript signatures, testing strategy with 17 merge fixtures. |

---

## Requirements

- [Node.js](https://nodejs.org) 18+
- [Git](https://git-scm.com)
- [Obsidian](https://obsidian.md) 1.12+ (for CLI support)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (for hook-powered vaults)
- [QMD](https://github.com/tobi/qmd) (optional, for semantic search)

---

## Status

**Pre-release.** Architecture designed. Implementation spec complete. Build in progress.

---

## Author

Created by **[Brenno Ferrari](https://brennoferrari.com)** — Senior iOS Engineer in Berlin. Creator of [obsidian-mind](https://github.com/breferrari/obsidian-mind) (1.3k+ stars).

---

## License

MIT
