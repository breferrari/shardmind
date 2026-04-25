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
├── .shardmind/                       ← engine metadata (installed-side)
│   ├── state.json                    ← ownership hashes + module/agent selections + version + resolved ref
│   ├── shard.yaml                    ← cached manifest (runtime reads without re-extracting the tarball)
│   ├── shard-schema.yaml             ← cached values schema
│   └── templates/                    ← cached source files; merge base for three-way merge on update
│
├── shard-values.yaml                 ← user's answers from the wizard; vault-root (not under .shardmind/);
│                                       named separately from .shardmind/ per VISION's
│                                       "Delete .shardmind/ and shard-values.yaml — the vault
│                                       continues to work" contract (§What ShardMind Is Not)
│
├── <same vault content as source, with:>
│   ├── .njk files in dotfolders rendered with user values (suffix stripped)
│   ├── optional modules/agents included per wizard (default: all)
│   └── hook may have personalized managed files (bound by Invariants 2 + 3)
│
├── .shardmindignore                  ← installed verbatim (Tier 2); inert post-install
├── README.md, LICENSE, CHANGELOG.md
│
└── (no .github/, no CONTRIBUTING.md, no translations, no demo media)
```

The installed-side path constants are authoritative in [`source/runtime/vault-paths.ts`](../source/runtime/vault-paths.ts): `STATE_FILE`, `CACHED_MANIFEST`, `CACHED_SCHEMA`, `CACHED_TEMPLATES` all live under `.shardmind/`; `VALUES_FILE` lives at vault root.

## Personalization model

Three mechanisms.

1. **Module / agent selection.** Wizard values gate which files ship. Default wizard state is **all modules enabled, all agent files shipped** — per VISION's "ships complete" posture and Invariant 1. User deselects what they don't want.

2. **`.njk` Nunjucks rendering** (author-explicit opt-in by suffix). Any file ending in `.njk` is rendered with user values and the suffix is stripped on install. Author convention is to keep `.njk` to **dotfolder configs** the user doesn't see — `.claude/settings.json.njk`, `.mcp.json.njk` — so the clone-UX cost stays zero. The engine doesn't enforce that convention because iterator templates (`<dir>/_each.<ext>.njk`) and other legitimate uses produce vault-visible output. Vault-visible `{{ values.X }}` *without* the `.njk` suffix is the deferred `rendered_files` opt-in tracked under [#86](https://github.com/breferrari/shardmind/issues/86).

3. **Post-install / post-update hooks.** Shard-author TypeScript reads `shard-values.yaml` and does whatever it wants — QMD bootstrap, programmatic edits to `brain/North Star.md`, MCP wiring. Bound by Invariants 2 + 3 below.

## Installation invariants

Three hard rules the engine + authors uphold. Enforced by CI.

### Invariant 1 — `install --defaults` is clone-equivalent

When a user runs `shardmind install --defaults <shard>`, the resulting vault stands in a precise relationship to `git clone <shard>`:

For every clone-side path P that survives Tier 1 exclusion + `.shardmindignore` filtering:
- **Static file** (P does NOT end in `.njk`): the install has a file at the same path P with **byte-identical content**. Content hash + relative path are compared; modes and mtimes are not.
- **Renderable template** (P ends in `.njk`): the install has a file at the **stripped** path (P with `.njk` removed). The rendered bytes legitimately differ from the source — `install_date`, value substitutions, frontmatter normalization. No byte comparison; presence-at-mapped-path is the contract.

The install additionally contains, never present in the clone:
- Engine metadata under `.shardmind/`: `state.json`, cached `shard.yaml` (manifest), cached `shard-schema.yaml`, and `templates/` (merge-base cache).
- Vault-root `shard-values.yaml` with default values serialized.

Any other delta — a clone path with no install counterpart, an install path with no clone source, a static-file byte mismatch, a Tier 1 entry that leaked through, a `.shardmindignore`-excluded file that ended up installed — is a shard-design or engine bug.

Enforced by a CI E2E test. The `tests/e2e/helpers/invariant1.ts` helper encapsulates the comparison; `shardmind install --defaults` is the deterministic mode that makes the test reproducible across runs.

**Author guidance.** The smaller a shard's render-delta surface, the closer the install is to a true clone byte-for-byte. Vault-visible content (`Home.md`, `brain/*.md`, …) is best authored as static `.md` and personalized via post-install hooks; renderable templates fit naturally in hidden dotfolders (`.claude/settings.json.njk`, `.codex/config.json.njk`) where Obsidian doesn't surface the `.njk` suffix to the user. See [`docs/AUTHORING.md §5`](AUTHORING.md) for the full convention.

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
- **`.shardmind/hooks/` is source-side only.** The installed-side `.shardmind/` holds `state.json` + cached `shard.yaml` + cached `shard-schema.yaml` + `templates/` cache — not hooks. (User's `shard-values.yaml` lives at vault root, not inside `.shardmind/`.) Engine reads hook scripts from the extracted source tarball during install/update; hook scripts never get copied into the installed vault.
- **Hook timeout** stays at the existing `DEFAULT_HOOK_TIMEOUT_MS` (non-fatal on timeout).

## Update semantics — spec rules

- **Default: latest stable release.** `shardmind update` resolves via `GET /repos/:o/:r/releases?per_page=100` filtered for `prerelease: false`. Replaces the v0.1 `/releases/latest` endpoint, which 404'd for beta-only repos. Closes the [`ARCHITECTURE §10.7`](ARCHITECTURE.md) gap.
- **Prerelease opt-in.** `--include-prerelease` flag widens resolution to all releases. Explicit opt-in matches npm tag conventions; safer default. When the default-stable filter eliminates every entry but prereleases exist, `NO_RELEASES_PUBLISHED`'s hint points at this flag.
- **`--release <tag>` flag.** Pins to a specific tag (stable or prerelease). Mutually exclusive with `--include-prerelease` (pin already chose) and with ref installs (those track a moving ref). Named `--release` rather than `--version` because Pastel reserves the program-level `--version` flag for printing the package version (`shardmind --version`); a per-command `--version` would silently collide.
- **Ref-install re-resolution.** Vaults installed via `github:owner/repo#<ref>` re-fetch HEAD of the ref on every `shardmind update` — ref installs track the branch/ref. `state.json` records the user-passed `ref` and the `resolvedSha` (40-char commit hex) so status can show movement and the up-to-date short-circuit can fire on SHA equality. Enables the shard-author dev loop (install from `#main`, iterate, update to pull new commits). Ref-installed vaults reject `--release` and `--include-prerelease` as `UPDATE_FLAG_CONFLICT`; reinstalling via `shardmind install <source>@<version>` is the explicit transition off the ref.
- **Update-check cache stays stable-only.** The 24-hour cache backing `shardmind` (status) is defined as "latest stable available". `shardmind update` primes the cache only when the run resolved through the latest-stable policy — `--release`, `--include-prerelease`, and ref installs all skip the prime so the cache doesn't drift into reporting a non-stable version as "latest stable".

## Adopt semantics — `shardmind adopt <shard>`

For users who cloned before shardmind support (obsidian-mind v5.1 and earlier) and want to adopt the update engine retroactively.

Pre-conditions enforced before any walk:
- `.shardmind/state.json` must NOT exist. Adopt is for un-adopted vaults; an existing install routes through `shardmind update`.
- `shard-values.yaml` at the vault root must NOT exist. The engine writes it at adopt-finish; a pre-existing one is an inconsistent state and surfaces `VALUES_FILE_COLLISION` (same code install uses).

Phases (logical order; UI may interleave loading messages):
1. Fetch shard at target version into a temp directory.
2. Wizard collects values (same component / pipeline as install) and module selections. Wizard runs **before** classification because `.njk` templates need values to render before their output bytes can be hashed.
3. Classify each file the shard would install at the chosen module selections, comparing the rendered (or copied) bytes against the user's vault:
   - **Matches shard content exactly** → record hash, mark managed automatically. "Exactly" means byte-for-byte equality after the standard render pipeline (frontmatter normalized via `parseYaml → stringifyYaml`, see `renderer.ts`). A pristine clone with default values + clean YAML lands here for every file; non-default vaults legitimately produce `differs` for any rendered output the user's bytes don't post-render-equal. This is the same equality `drift.ts` enforces on update.
   - **Differs from shard content** → 2-way diff UI (no merge base); user marks "my modification" (record user's content hash as managed) or "use shard's version" (overwrite, record shard hash as managed). Two choices, no third "leave untracked" — adopt is the moment the file becomes managed; the user can later modify it freely and the merge engine handles it on update.
   - **Volatile templates** (carry `{# shardmind: volatile #}`) skip the prompt: user's bytes are recorded as managed without a differs comparison (volatile content is never expected to match across renders, so a prompt would be meaningless). Symmetric with install, which records volatile-template outputs the same way.
   - **Excluded modules' files** are not classified. If the user's vault contains them, they stay as user content.
   - User has the path but it's not a shard output → user-only, left unmanaged (not in `state.files`).
   - Shard has the path but the user's vault doesn't → shard-only, installed fresh and recorded as managed.
4. For every `differs` decision, apply: write shard bytes for "use shard's", leave user bytes for "my modification". `keep mine` paths still become `state.files` entries hashed at the user's bytes — adopt is the entry point into management.
5. Write `.shardmind/state.json` + cached `.shardmind/shard.yaml` + cached `.shardmind/shard-schema.yaml` + vault-root `shard-values.yaml`; cache the shard source under `.shardmind/templates/` so future `update` runs have a merge base.
6. Run post-install hook with `valuesAreDefaults` reflecting the user's values, `newFiles` = paths classified shard-only and freshly installed, `removedFiles` = [].
7. Re-hash managed files per the usual post-hook semantics.

Future `shardmind update` calls work normally — merge base is the adopt-time cache.

Reuses: drift detection (`core/drift.ts`), install-executor, values wizard, hook runtime. New surfaces: 2-way diff UI component (`AdoptDiffView`), adopt-planner, adopt-executor.

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
11. **Engine plumbing for the new ctx fields + post-hook re-hash** — split across:
    - `source/core/values-defaults.ts` (new) — pure `valuesAreDefaults(values, schema)` for Invariant 2; deep-equal user values against the would-be-default map (literal defaults + computed defaults resolved against the literal-default map).
    - `source/core/update-executor.ts` — surface `addedFiles: string[]` (paths from `UpdateAction.kind === 'add'`) and the existing `deletedFiles: string[]` on `UpdateSummary` so the update machine can wire `newFiles` / `removedFiles` without re-deriving from the plan.
    - `source/core/state.ts::rehashManagedFiles(vaultRoot, state)` (new) — parallel re-read + sha256 of every managed file; per-file ENOENT / EACCES tolerated.
    - `source/commands/hooks/{use-install-machine,use-update-machine}.ts` — build the full ctx and call `postHookRehash` (helper in `source/commands/hooks/shared.ts`) after the hook subprocess returns, on success or failure. Re-hash + `writeState` are skipped when nothing changed (common case — most hooks edit only unmanaged files).

### Registry + update

12. `source/core/registry.ts` — `github:owner/repo#<ref>` syntax (subsumes [#67](https://github.com/breferrari/shardmind/issues/67)); record resolved commit SHA for ref installs.
13. `source/core/update-check.ts` — default resolution via `/releases` filtered non-prerelease; `--include-prerelease` widens. For ref-installs, re-resolve ref HEAD on every update.
14. `source/commands/update.tsx` — add `--release <tag>` flag (named `--release` rather than `--version` because Pastel reserves the program-level `--version`); add `--include-prerelease` flag.
15. `source/runtime/types.ts` — `ShardState.ref?` + `ShardState.resolvedSha?` for ref installs.

### Adopt

16. New command: `source/commands/adopt.tsx` + `source/commands/hooks/use-adopt-machine.ts`.
17. New component: 2-way diff UI (`source/components/AdoptDiffView.tsx`) + per-file prompt flow.
18. `source/core/adopt-planner.ts` — walk existing vault, classify each file (matches-shard, differs-from-shard, user-created, shard-only), plan adoption operations.
19. `source/core/adopt-executor.ts` — apply plan; write installed-side metadata (`.shardmind/state.json` + cached `shard.yaml` + cached `shard-schema.yaml` + `.shardmind/templates/` cache) and vault-root `shard-values.yaml`; run post-install hook; re-hash managed files.

### Install non-interactive mode

20. `source/commands/install.tsx` — add `--defaults` flag that accepts all schema defaults, enables all modules + agents, skips wizard prompts. Used by Invariant 1 CI test; also useful for CI/scripting.

### Testing

21. **Invariant 1 byte-equivalence E2E test.** Clone shard repo to dir-A; run `shardmind install --defaults` to dir-B; recursively compare file trees. Expected delta: Tier 1 absent in B; engine metadata present in B (`.shardmind/state.json`, `.shardmind/shard.yaml`, `.shardmind/shard-schema.yaml`, `.shardmind/templates/`, and vault-root `shard-values.yaml`); content of all other files identical (content-hash match; modes and mtimes not compared). Any other diff fails.
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
| `shardmind eject` | Manual `rm -rf .shardmind/ shard-values.yaml` works per VISION's additive principle ("delete `.shardmind/` and `shard-values.yaml` — the vault continues to work ... ShardMind is additive, not load-bearing") | New command; orchestrates the manual delete + optional backup |
| SOUL guided creation | Obsidian-mind product feature, not a shardmind engine concern | — |

## Transition

No shard migration required — zero shards published under the v0.1 `templates/` contract. obsidian-mind v6 is the first shard under this contract.

- `examples/minimal-shard/` restructures to the flat layout during Day 1-4 build.
- obsidian-mind v6 conversion (Day 5): v5.1's structure + `.shardmind/` sidecar + any dotfolder `.njk` for config rendering.
- Research-wiki shard (Day 6): same flat layout; uses hooks for any personalization (no `rendered_files` dependency).
- `docs/ARCHITECTURE.md §3`, `docs/AUTHORING.md §2` + §7, `docs/IMPLEMENTATION.md §4.*` rewrite once this design lands in code.
- [#67](https://github.com/breferrari/shardmind/issues/67) (branch/ref install) and [#69](https://github.com/breferrari/shardmind/issues/69) (`.shardmind/` source layout) subsumed by [#70](https://github.com/breferrari/shardmind/issues/70).
