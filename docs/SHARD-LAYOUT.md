# Shard Layout (v6 contract)

> **Status**: Design resolved for v0.1. All rules binding. Folds into [`ARCHITECTURE.md §3`](ARCHITECTURE.md) + [`AUTHORING.md §2`](AUTHORING.md) once implementation lands; until then this is the source of truth.
> Discussion thread: [#70](https://github.com/breferrari/shardmind/issues/70).

## Guiding principle

From [`VISION.md`](../VISION.md):

> **Not dependent on ShardMind to function.** A vault installed by ShardMind works exactly the same without ShardMind. Delete `.shardmind/` and `shard-values.yaml` — the vault continues to work in Obsidian and Claude Code. ShardMind is additive, not load-bearing.

The mirror obligation: **the shard repo must also work as a vault without shardmind**. obsidian-mind's clone-and-open experience is the product that earned the flagship its 2k+ stars. ShardMind extends that experience with install-time personalization, safe upgrades, and modular composition — without subtracting anything.

## Design posture: minimum viable sidecar

A shard is today's vault + a `.shardmind/` sidecar. No wrapper directories, no partials/assembly system, no committed-rendered artifacts. The engine's full capability surface (Nunjucks rendering, merge, migrations, signals, values, modules, hooks, runtime) stays intact; only the *shard contract* is simplified.

**Scope rule for this design**: v0.1 ships what obsidian-mind v6 needs to install, configure, and upgrade cleanly. Features not exercised by obsidian-mind v6 live in the Out-of-scope section with explicit justifications showing they can be added later without retroactive redesign.

## What a shard is

> **A shard is an Obsidian vault with a `.shardmind/` directory.** The vault is the product; `.shardmind/` is the opt-in sidecar that makes it installable, configurable, and upgradeable.

Three testable properties:

1. The shard repo at HEAD opens cleanly as a vault in Obsidian with no preparation.
2. `shardmind install <shard>` with all defaults produces a vault byte-equivalent to `git clone <shard>` (modulo Tier 1 exclusions + `.shardmind/` engine metadata).
3. Deleting `.shardmind/` on either side leaves a working vault.

## Layout — source side (the shard repo)

```
my-shard/                             ← git repo root; also opens cleanly as an Obsidian vault
│
├── .shardmind/                       ← engine metadata (source-side)
│   ├── shard.yaml                    ← manifest (name, version, values refs, modules, agents, hooks)
│   ├── shard-schema.yaml             ← values schema → zod at runtime (every value MUST have a default)
│   └── hooks/                        ← source-side only; engine reads from tarball, does NOT copy to installed vault
│       ├── post-install.ts           ← optional, non-fatal
│       └── post-update.ts            ← optional, non-fatal
│
├── .shardmindignore                  ← at repo root; glob semantics (negation deferred to v0.2)
│
├── <vault content at native paths>   ← brain/, work/, Home.md, bases/, etc. (v5.1's shape)
│
├── CLAUDE.md, AGENTS.md, GEMINI.md   ← verbatim; included per agent selection
│
├── .claude/, .codex/, .gemini/       ← agent operational layers (dotfolders; .njk allowed inside)
├── .mcp.json, .obsidian/             ← config + Obsidian vault-shape config
│
├── README.md, LICENSE, CHANGELOG.md  ← installed by default; vault-relevant docs
├── ARCHITECTURE.md, .gitignore       ← installed if present
│
└── <repo-only>                       ← .github/, CONTRIBUTING.md, README.<lang>.md, demo media
                                        (excluded via .shardmindignore; see §File disposition)
```

## Layout — installed side (after `shardmind install`)

```
my-vault/
│
├── .shardmind/
│   ├── state.json                    ← ownership + hashes + modules + agents + version + ref (if applicable)
│   ├── shard-values.yaml             ← user's answers from the wizard
│   └── templates/                    ← cached source files; merge base on update
│
├── <same vault content as source, with:>
│   ├── .njk files in dotfolders rendered with user values (suffix stripped)
│   ├── optional modules/agents included per wizard (default: all)
│   └── hook may have personalized managed files (bound by Invariants 2 + 3)
│
├── README.md, LICENSE, CHANGELOG.md
│
└── (no .github/, no CONTRIBUTING.md, no translations, no demo media)
```

## Personalization model

Three mechanisms. v0.1 deliberately does NOT ship Nunjucks rendering at vault-visible paths — hooks cover what obsidian-mind v6 needs. Adding rendered-content at visible paths is a v0.2 feature when a shard (likely research-wiki) pushes on it.

1. **Module / agent selection.** Wizard values gate which files ship. Default wizard state is **all modules enabled, all agent files shipped** — per VISION's "ships complete" posture and Invariant 1. User deselects what they don't want.

2. **Dotfolder `.njk` rendering.** Config files the user doesn't see (`.claude/settings.json.njk`, `.mcp.json.njk`) render with user values; suffix stripped on install. Obsidian hides dotfolders, so no clone-UX cost.

3. **Post-install / post-update hooks.** Shard-author TypeScript reads `shard-values.yaml` and does whatever it wants — QMD bootstrap, programmatic edits to `brain/North Star.md`, MCP wiring. Bound by Invariants 2 + 3 below.

## Installation invariants

Three hard rules the engine + authors uphold. Enforced by CI.

### Invariant 1 — `install --defaults` is byte-equivalent to clone

If a user runs `shardmind install <shard>` and accepts every default value, the resulting vault is byte-identical to `git clone <shard>`, modulo:
- Tier 1 engine exclusions (absent from install)
- `.shardmind/{state.json, shard-values.yaml, templates/}` (present in install)

Enforced by a CI E2E test. Any other delta is a shard-design bug. Byte-equivalence = content hash + relative path; modes and mtimes are not compared.

### Invariant 2 — Hooks respect default-values

Hooks that modify *managed* files (tracked in state.json) must no-op when `ctx.valuesAreDefaults === true`. Hooks that create *unmanaged* files (QMD indexes, MCP caches, etc.) may run unconditionally — they don't affect the 1-1 invariant. Engine computes `valuesAreDefaults` by deep-equal comparing each user value against its schema default.

### Invariant 3 — Post-update hooks are additive-only by default

Post-update hooks receive `ctx.newFiles: string[]` — managed files added in this update. By default, hook writes are restricted to those paths. Writing to any other managed file risks clobbering user edits or the three-way-merge resolution that just ran.

## Values, schema, and modules — spec rules

- **Every value has a default.** `shard-schema.yaml` validator rejects values without a `default` field. Makes Invariant 1 testable. Since v0.1 is the first contract, no migration cost. Authors model "required" behavior via non-empty defaults or hook validation.
- **Default wizard state = all modules + all agents selected.** User deselects. Preserves Invariant 1 under default install.
- **Agent selection is modeled as module gating.** Shard declares `agents` in `shard.yaml`; each agent is a module with file patterns. Uniform mechanism; no per-agent engine code.
- **Module deselection = file-path gating, not section pruning.** Files under deselected module paths don't install. CLAUDE.md / AGENTS.md / GEMINI.md stay whole. Per VISION: "empty folders cost nothing; unused commands sit silently."

## Hooks, state, and re-hash semantics

- **Hook runs after state.json write.** Unchanged from current engine behavior.
- **Engine re-hashes all managed files after hook exits — success OR failure.** State.json must reflect actual file content even if the hook partially failed (hook non-fatal contract preserved). Parallel hash compute; cost is bounded.
- **`HookContext` extensions** (new fields in `source/runtime/types.ts`):
  - `valuesAreDefaults: boolean` — true iff every user value equals its schema default
  - `newFiles: string[]` — managed files added by this install/update (empty on clean install; populated on update with paths newly added in the new version)
  - `removedFiles: string[]` — managed files removed by this update (module deselection). Hooks use this to maintain external state (QMD collection refs, MCP registrations).
- **`.shardmind/hooks/` is source-side only.** The installed-side `.shardmind/` holds state.json + shard-values.yaml + templates/ cache — not hooks. Engine reads hook scripts from the extracted source tarball during install/update; hook scripts never get copied into the installed vault.
- **Hook timeout** stays at the existing `DEFAULT_HOOK_TIMEOUT_MS` (non-fatal on timeout).

## Update semantics — spec rules

- **Default: latest stable release.** `shardmind update` resolves via GitHub's `/releases` filtered for non-prerelease. Closes the [`ARCHITECTURE §10.7`](ARCHITECTURE.md) gap (current code hits `/releases/latest` which 404s for beta-only repos).
- **Prerelease opt-in.** `--include-prerelease` flag widens resolution to all releases. Explicit opt-in matches npm tag conventions; safer default.
- **`--version <version>` flag.** Pins to a specific tag (stable or prerelease).
- **Ref-install re-resolution.** Vaults installed via `github:owner/repo#<ref>` re-fetch HEAD of the ref on every `shardmind update` — ref installs track the branch/ref. `state.json` records the resolved commit SHA so status can show movement. Enables the shard-author dev loop (install from `#main`, iterate, update to pull new commits).

## Adopt semantics — `shardmind adopt <shard>`

For users who cloned before shardmind support (obsidian-mind v5.1 and earlier) and want to adopt the update engine retroactively.

Flow:
1. Fetch shard at target version into temp.
2. Walk the user's existing vault (cwd); for each file:
   - Matches shard content exactly → record hash, mark managed.
   - Differs from shard content → 2-way diff UI (no base); user marks "my modification" (record user's content hash as managed) or "use shard's version" (overwrite, record shard hash as managed).
   - Exists in user's vault but not in shard → left as user-created (not managed).
   - Exists in shard but not in user's vault → installed fresh, managed.
3. Wizard collects values (same as install).
4. Write `.shardmind/state.json` + `shard-values.yaml` + cache shard content to `.shardmind/templates/`.
5. Run post-install hook with `valuesAreDefaults` reflecting user's values, `newFiles` = files created in step 2d, `removedFiles` = [].
6. Re-hash managed files per the usual post-hook semantics.

Future `shardmind update` calls work normally — merge base is the adopt-time cache.

Reuses: drift detection (`core/drift.ts`), install-executor, values wizard, hook runtime. New surfaces: 2-way diff UI component, adopt-planner, adopt-executor.

## Naming decisions

| Thing | Name | Rationale |
|-------|------|-----------|
| Engine metadata dir | `.shardmind/` on both sides | Mirror; same semantics source ↔ installed |
| Exclusion file | `.shardmindignore` at repo root | `.gitignore` convention; more discoverable than nested |
| Ignore-file semantics | Glob-only in v0.1 (negation deferred to v0.2) | obsidian-mind's patterns are simple excludes; negation not exercised |
| Dotfolder render marker | `.njk` suffix | Obsidian hides dotfolders; no clone-UX cost |
| No `templates/` in vocabulary | — | Obsidian reserves `templates/` for user note templates |

## File disposition

Three tiers. **Default is install.** Engine subtracts the minimum necessary; authors use `.shardmindignore` for the rest.

### Tier 1 — engine-enforced exclusions (always excluded)

Not author-configurable. Would break things or are meaningless off-GitHub:

- `.shardmind/` (source-side) — installed side gets a fresh one with different contents
- `.git/` — VCS database
- `.github/` — GitHub CI, issue templates, `FUNDING.yml` (defensive: prevents accidental Actions activation if user git-pushes their vault)
- `.obsidian/workspace.json`, `.obsidian/workspace-mobile.json`, `.obsidian/graph.json` — Obsidian ephemeral user-specific state
- **Symbolic links anywhere in the shard source** — engine rejects with a clear error during the install walk. Security baseline: an untrusted shard could symlink outside the install target.

Other Obsidian user-state files (`starred.json`, `bookmarks.json`, `backlink.json`, `page-preview.json`) are author-controlled via `.shardmindignore`. obsidian-mind v5.1 commits none of these, so no practical issue.

### Tier 2 — default-included

Everything else at the shard root. The annotations below cover the two audiences the layout must serve:

| File | In the vault (installed user) | In the repo (contributor) |
|------|------------------------------|---------------------------|
| `README.md` | Instructions manual | GitHub landing page |
| `LICENSE` | Attribution | Legal terms |
| `CHANGELOG.md` | What changed — surfaced post-update | Release notes |
| `ARCHITECTURE.md` (if shipped) | How the vault is structured | Design rationale |
| `Home.md` | Obsidian landing note | Same |
| `.gitignore` | Useful if user gits their vault | Git hygiene |
| `.obsidian/` (minus Tier 1) | Vault-shape config; plugins pre-enabled | Same |
| `.claude/`, `.codex/`, `.gemini/`, `.mcp.json`, `.claude-plugin/` | Operational layer | Same |
| `scripts/` | Vault-bundled scripts (QMD bootstrap) | Same |
| `vault-manifest.json` | Shard-author config; vault content | Same |
| `bases/`, `brain/`, `work/`, … | Vault content folders | Same |
| `templates/` | **Obsidian's** native user-templates folder | Same |

### Tier 3 — author-controlled via `.shardmindignore`

Glob-only in v0.1. Typical obsidian-mind-shaped shard:

```gitignore
# Repo-meta — meaningful on GitHub, noise in a vault
CONTRIBUTING.md
README.*.md              # translations (README.ja.md, README.ko.md, …)

# Marketing media — not vault content
*.gif
*.png
obsidian-mind-logo.*
```

**Rule of thumb**: if a file is a property of *the GitHub repo*, exclude it. If it's *about the shard's content*, leave it installed.

## Engine change scope

Paths reference current code. Detail to land in `ARCHITECTURE.md §3` + `IMPLEMENTATION.md §4.*`.

### Walk + discovery

1. `source/core/modules.ts` — replace `templates/` walk with shard-root walk; apply Tier 1 exclusions + root-level `.shardmindignore`. Remove partials gating (`mod.partials`). Reject symlinks with a clear error.
2. `source/core/state.ts:117-119` — replace "Missing `templates/`" error with `.shardmind/shard.yaml`-absence check.
3. `source/core/download.ts:78-79` — look for manifest/schema under `.shardmind/` in the extracted tarball.
4. `source/core/fs-utils.ts:25-27` — remove `stripTemplatePrefix` helper (dead under flat layout).
5. `source/runtime/vault-paths.ts` — add `SHARD_SOURCE_DIR = '.shardmind'`; keep installed-side `.shardmind/templates/` cache constant.
6. New parser: `.shardmindignore` glob matcher (gitignore semantics minus negation).
7. New data: canonical Tier 1 exclusion set.

### Schema + values

8. `source/core/schema.ts:66` — remove dead `partials` field; **add validation that every value has a `default`** (reject at parse time if missing).
9. `source/runtime/types.ts:71` — remove `partials?: string[]` from module type.

### Hooks + state

10. `source/runtime/types.ts` — extend `HookContext` with `valuesAreDefaults: boolean`, `newFiles: string[]`, `removedFiles: string[]`.
11. `source/core/install-executor.ts` + `source/core/update-executor.ts` — compute `valuesAreDefaults` (deep-equal values vs schema defaults), `newFiles` + `removedFiles` (diff current file set vs previous state). Re-hash all managed files after hook exits (success or failure) and write updated state.json.

### Registry + update

12. `source/core/registry.ts` — `github:owner/repo#<ref>` syntax (subsumes [#67](https://github.com/breferrari/shardmind/issues/67)); record resolved commit SHA for ref installs.
13. `source/core/update-check.ts` — default resolution via `/releases` filtered non-prerelease; `--include-prerelease` widens. For ref-installs, re-resolve ref HEAD on every update.
14. `source/commands/update.tsx` — add `--version <version>` flag; add `--include-prerelease` flag.
15. `source/runtime/types.ts` — `ShardState.ref?` + `ShardState.resolvedSha?` for ref installs.

### Adopt

16. New command: `source/commands/adopt.tsx` + `source/commands/hooks/use-adopt-machine.ts`.
17. New component: 2-way diff UI (`source/components/AdoptDiffView.tsx`) + per-file prompt flow.
18. `source/core/adopt-planner.ts` — walk existing vault, classify each file (matches-shard, differs-from-shard, user-created, shard-only), plan adoption operations.
19. `source/core/adopt-executor.ts` — apply plan, write state.json + shard-values.yaml + templates/ cache; run post-install hook; re-hash managed files.

### Install non-interactive mode

20. `source/commands/install.tsx` — add `--defaults` flag that accepts all schema defaults, enables all modules + agents, skips wizard prompts. Used by Invariant 1 CI test; also useful for CI/scripting.

### Testing

21. **Invariant 1 byte-equivalence E2E test.** Clone shard repo to dir-A; run `shardmind install --defaults` to dir-B; recursively compare file trees. Expected delta: Tier 1 absent in B, `.shardmind/{state.json,shard-values.yaml,templates/}` present in B, content of all other files identical (content-hash match; modes and mtimes not compared). Any other diff fails.
22. **Unit tests**: `valuesAreDefaults` computation, `newFiles`/`removedFiles` diff, `.shardmindignore` glob matching, symlink rejection.
23. Migrate `examples/minimal-shard/` to flat layout.
24. Migrate `tests/fixtures/shards/` tarballs.
25. Verify `tests/fixtures/merge/*` don't reference `templates/` prefixes.

## Why `shardmind install` beats `git clone`

The adoption pitch for obsidian-mind v6 users:

1. **Configured on install.** Wizard applies values, modules, agents; hooks finish the job. No hand-editing.
2. **Modular.** Skip modules you don't want — vault sized to your life.
3. **Safe upgrades.** `shardmind update` three-way-merges your edits with upstream. Backstage has had this open for three years. This is the moat per `VISION.md §The Moat`.
4. **Drift visibility.** `shardmind` status shows stale / diverged / user-created.
5. **Retroactive adopt.** Cloned v5.1 already? `shardmind adopt github:breferrari/obsidian-mind` reconciles your vault in place.

Compressed: **clone is free but frozen; install (or adopt) gives you a configured, upgradeable vault.**

## Out of scope — deferred to v0.2

Criterion: **obsidian-mind v6 does not need these to install, configure, or upgrade cleanly.** Each is a clean additive extension — deferring doesn't force retroactive design changes.

| Deferred | Why not needed for v6 | How it's added later without redesign |
|----------|----------------------|---------------------------------------|
| `rendered_files` opt-in (Nunjucks at vault-visible paths) | obsidian-mind uses post-install hook to personalize `brain/North Star.md`; no `{{ }}` at vault-visible paths | New optional field in `shard.yaml`; `renderer.ts` extended to include files in the list during install. Existing `rendered_files: undefined` behavior stays |
| `.shardmindignore` negation (`!pattern`) | obsidian-mind's patterns are simple excludes; no negation needed | Parser upgrade; existing glob-only files keep working |
| Rename migrations + `adopt --from-version` | v6.0 = v5.1's structure + `.shardmind/` sidecar (zero renames vs v5.1). **If a future obsidian-mind release introduces renames, rename migrations must ship before that release** | New `migrations` field in `shard.yaml`; update-planner + adopt-planner consume it. Missing field = no-op (current behavior) |
| Shard composition (multi-shard per vault) | One shard per vault in v0.1 | State.json extends from `{shard, version}` to `{shards: [...]}`; single-shard remains the special case. No break |
| Dependency fetching | Shards vendor deps (obsidian-mind already does this) | `shard.yaml` gets `dependencies: []`; engine fetches on install. No break |
| Structural variants | obsidian-mind is a single shard | Future feature; orthogonal to layout |
| `shardmind init` | obsidian-mind author already has the shard; manual scaffolding works | New command; doesn't interact with existing install/update |
| `shardmind eject` | Manual `rm -rf .shardmind/` works per additive principle (VISION.md line 85) | New command; orchestrates the manual delete + optional backup |
| SOUL guided creation | Obsidian-mind product feature, not a shardmind engine concern | — |

## Transition

No shard migration required — zero shards published under the v0.1 `templates/` contract. obsidian-mind v6 is the first shard under this contract.

- `examples/minimal-shard/` restructures to the flat layout during Day 1-4 build.
- obsidian-mind v6 conversion (Day 5): v5.1's structure + `.shardmind/` sidecar + any dotfolder `.njk` for config rendering.
- Research-wiki shard (Day 6): same flat layout; uses hooks for any personalization (no `rendered_files` dependency).
- `docs/ARCHITECTURE.md §3`, `docs/AUTHORING.md §2` + §7, `docs/IMPLEMENTATION.md §4.*` rewrite once this design lands in code.
- [#67](https://github.com/breferrari/shardmind/issues/67) (branch/ref install) and [#69](https://github.com/breferrari/shardmind/issues/69) (`.shardmind/` source layout) subsumed by [#70](https://github.com/breferrari/shardmind/issues/70).
