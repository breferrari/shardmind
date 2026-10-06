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
│       ├── bootstrap.ts              ← optional, non-fatal; unmanaged-path setup (git init, indexes)
│       ├── personalize.ts            ← optional, non-fatal; managed-file edits (engine skips when values are defaults)
│       └── post-update.ts            ← optional, non-fatal; additive managed-file edits on update
│
├── .shardmindignore                  ← at repo root; gitignore semantics, negation included (#87)
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
│   ├── templates/                    ← cached source files; merge base for three-way merge on update
│   └── logs/                         ← full output of a crashed or verbose hook (<slot>.log); written
│                                       on demand so the Summary can truncate on screen and point here
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

The installed-side path constants are authoritative in [`source/runtime/vault-paths.ts`](../source/runtime/vault-paths.ts): `STATE_FILE`, `CACHED_MANIFEST`, `CACHED_SCHEMA`, `CACHED_TEMPLATES`, `HOOK_LOGS_DIR` all live under `.shardmind/`; `VALUES_FILE` lives at vault root. Everything under `.shardmind/` (including `logs/`) is engine metadata and is excluded from the Invariant 1 byte-equivalence comparison.

## Personalization model

Three mechanisms.

1. **Module / agent selection.** Wizard values gate which files ship. Default wizard state is **all modules enabled, all agent files shipped** — per VISION's "ships complete" posture and Invariant 1. User deselects what they don't want.

2. **`.njk` Nunjucks rendering** (author-explicit opt-in by suffix). Any file ending in `.njk` is rendered with user values and the suffix is stripped on install. Author convention is to keep `.njk` to **dotfolder configs** the user doesn't see — `.claude/settings.json.njk`, `.mcp.json.njk` — so the clone-UX cost stays zero. The engine doesn't enforce that convention because iterator templates (`<dir>/_each.<ext>.njk`) and other legitimate uses produce vault-visible output. Vault-visible `{{ values.X }}` *without* the `.njk` suffix is the deferred `rendered_files` opt-in tracked under [#86](https://github.com/breferrari/shardmind/issues/86). The three-way merge on `update` honors the same split: copy-origin (non-`.njk`) files are merged on their raw bytes and are **never** re-rendered, so a literal `{{` in a script or test fixture neither crashes the merge nor gets substituted ([#132](https://github.com/breferrari/shardmind/issues/132)).

3. **Lifecycle hooks.** Shard-author TypeScript split across three named slots with engine-enforced write boundaries — `bootstrap` (unmanaged-path setup: QMD bootstrap, `git init`), `personalize` (managed-file edits like `brain/North Star.md`, only when the user supplied non-default values), `post-update` (additive managed-file edits on update). Bound by Invariants 2 + 3 + 4 below. See [§Hook lifecycle](#hook-lifecycle-state-and-re-hash-semantics).

## Installation invariants

Four hard rules the engine + authors uphold. Enforced by CI.

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

**Author guidance.** The smaller a shard's render-delta surface, the closer the install is to a true clone byte-for-byte. Vault-visible content (`Home.md`, `brain/*.md`, …) is best authored as static `.md` and personalized via the `personalize` hook; renderable templates fit naturally in hidden dotfolders (`.claude/settings.json.njk`, `.codex/config.json.njk`) where Obsidian doesn't surface the `.njk` suffix to the user. See [`docs/AUTHORING.md §5`](AUTHORING.md) for the full convention.

### Invariant 2 — Default-value installs touch no managed files (engine-enforced)

A `--defaults` install must stay byte-equivalent to clone, so **no hook may edit a managed file when the user accepted every default**. As of the hook lifecycle split this is *engine-enforced*, not hook-checked: the engine computes `valuesAreDefaults` (deep-equal each user value against its schema default) and, when true, **does not invoke the `personalize` hook at all**. The `personalize` slot is the only hook permitted to write managed files, and it runs solely on first install/adopt with non-default values — so a defaults install has no code path that can mutate a managed file. Authors no longer write `if (!ctx.valuesAreDefaults) …`; the gate moved into the engine. (Legacy `post-install` hooks keep the old self-check — see [§Hook lifecycle](#hook-lifecycle-state-and-re-hash-semantics).)

### Invariant 3 — Post-update hooks are additive-only by default

The `post-update` hook receives `ctx.newFiles: string[]` — managed files added in this update. By default, hook writes are restricted to those paths. Writing to any other managed file risks clobbering user edits or the three-way-merge resolution that just ran. This remains a convention (engine-provided `newFiles`, as today) rather than a write-boundary check — unlike `bootstrap` and `personalize`, which are detected (see [§Hook lifecycle](#hook-lifecycle-state-and-re-hash-semantics)).

### Invariant 4 — Bootstrap re-runs only on fingerprint change

The `bootstrap` hook runs on every fresh install/adopt. On *update* it re-runs **iff** the manifest's `hooks.bootstrap.fingerprint` differs from the value recorded in `state.json` at the last successful bootstrap (`state.bootstrap_fingerprint`). A shard with no `fingerprint` never re-bootstraps on update; bumping the fingerprint (`"qmd-v1"` → `"qmd-v2"`) forces every installed vault to re-run `bootstrap` on its next update. This lets a shard rebuild unmanaged artifacts (search indexes, caches) when their schema changes, without overloading `post-update` (which is additive-only over managed files) and without a one-shot migration. The engine compares the raw fingerprint strings (`!==`); it does not hash them.

## Values, schema, and modules — spec rules

- **Every value has a default.** `shard-schema.yaml` validator rejects values without a `default` field. Makes Invariant 1 testable. Since v0.1 is the first contract, no migration cost. Authors model "required" behavior via non-empty defaults or hook validation.
- **Default wizard state = all modules + all agents selected.** User deselects. Preserves Invariant 1 under default install.
- **Agent selection is modeled as module gating.** Shard declares `agents` in `shard.yaml`; each agent is a module with file patterns. Uniform mechanism; no per-agent engine code.
- **Module deselection = file-path gating, not section pruning.** Files under deselected module paths don't install. CLAUDE.md / AGENTS.md / GEMINI.md stay whole. Per VISION: "empty folders cost nothing; unused commands sit silently."

## Hook lifecycle, state, and re-hash semantics

### Three named slots

The single `post-install` hook is split into three slots, each with a contract the engine enforces. Declared under `hooks:` in `shard.yaml`:

```yaml
hooks:
  bootstrap:
    script: .shardmind/hooks/bootstrap.ts
    fingerprint: "qmd-v1"          # optional; bumping it re-runs bootstrap on update (Invariant 4)
  personalize: .shardmind/hooks/personalize.ts
  post-update: .shardmind/hooks/post-update.ts
  timeout_ms: 30000                # optional, applies to every slot
```

`bootstrap` may also be the bare string form (`bootstrap: .shardmind/hooks/bootstrap.ts`) when no fingerprint is needed.

| Slot | Runs on | May write | Gate |
|------|---------|-----------|------|
| `bootstrap` | first install + adopt; on update iff `fingerprint` changed (Invariant 4) | **unmanaged** paths only (`.qmd/`, `.git/`, MCP caches) | always (no value gate) |
| `personalize` | first install + adopt **only** | **managed** files only (tracked in `state.json`) | engine skips it entirely when `valuesAreDefaults` (Invariant 2) |
| `post-update` | updates | **managed** files in `ctx.newFiles` only | Invariant 3 |

On a fresh install/adopt, slots fire in order: **`bootstrap` then `personalize`** (infrastructure before content). On update, **`bootstrap` (if its fingerprint changed) then `post-update`**.

### Write-boundary enforcement (detect-and-warn)

A hook is an ordinary Node subprocess with full filesystem access; the engine cannot *prevent* an out-of-boundary write. Instead it **detects** one and surfaces a **non-fatal warning** — the install/update still succeeds, and the bytes the hook wrote are left in place (consistent with the non-fatal Helm contract: whatever a hook did, stays). The engine snapshots before each boundary-checked slot and diffs after:

- **`bootstrap` wrote a managed file** → `HOOK_BOOTSTRAP_MANAGED_WRITE` warning naming the paths. Detection folds into the post-hook re-hash: a tracked file whose bytes changed between the pre-hook snapshot and the end of bootstrap is a violation. The comparison is against the snapshot, not against `rendered_hash`, so a file the user edited before the update is not mistaken for a bootstrap write. Move the edit to `personalize`.
- **`personalize` created an unmanaged file** → `HOOK_PERSONALIZE_UNMANAGED_CREATE` warning. Detection is a path-only vault walk (ignore-filtered + Tier-1-filtered) before and after; install/adopt only. Scoped to *creation* — a `personalize` that modifies or deletes an already-present unmanaged file (e.g. bootstrap's `.qmd/` artifacts) is not detected, because the path set is unchanged and the check avoids content-hashing the whole vault. Move the artifact creation to `bootstrap`.
- **The walk could not read a folder** → `HOOK_BOUNDARY_INCOMPLETE` warning naming the folders (`.` is the vault root, shown as "the vault root"). A folder that vanished counts as empty. A busy or permission-denied folder (`EBUSY` / `EPERM` / `EACCES`, typical of a Windows scanner holding it) is read once more after 50 ms; a folder that still cannot be read is reported, never treated as empty, because an empty read would make the check say nothing was created. When the hook also created files, the creation warning lists the unreadable folders with them. A path under a folder that could not be read before the hook is not counted as created.
- **The vault owner can exclude folders from that walk** (#190) in `.shardmind/boundary-ignore`, a file they own: one gitignore-style pattern per line, matched as `.shardmindignore` is, negation included (#87). An excluded folder is never read, so it never makes the check incomplete. The cost is the user's explicit trade: whatever `personalize` creates in an excluded folder goes undetected. A missing file excludes nothing. A file that cannot be read or parsed, or that would switch the check off, is not applied. Switching off is judged by outcome, so every spelling is caught: the file matches every name at the vault root (`*`, `**`), or it excludes every folder the vault root holds (`*/`, `/*/`, a list naming each one). Such a file is not applied: the check runs without it and warns `HOOK_BOUNDARY_IGNORE_INVALID`. The shard never ships this file and updates never touch it (`.shardmind/` is Tier 1).

These are warnings, not thrown errors — see [`docs/ERRORS.md §Hook lifecycle (non-fatal warnings)`](ERRORS.md). They turn yesterday's comment-checked conventions into machine-checked signals an author sees during their dev loop.

### Re-hash + state

- **Hooks run after the state.json write.** Unchanged.
- **`rendered_hash` is the engine's baseline, never the user's bytes.** It records what the engine produced for a file (a render or a copy), or what a hook wrote over a file the engine owned. Drift reads "disk equals `rendered_hash`" as "engine-owned and unchanged", so a user's bytes recorded there make their edit look engine-owned, and the next update overwrites it silently (#150). Every writer of `state.files` keeps to this rule: install, update (`overwrite` / `add` / `restore_missing` / `auto_merge` / every conflict resolution), adopt (every resolution), and the re-hash below.
- **Engine re-hashes after the hook phase exits — success OR failure — against a snapshot taken before the first slot runs.** A tracked file whose bytes moved during the hook phase was written by a hook; if it was engine-owned when the phase began (snapshot equals `rendered_hash`, or the file was absent), its new bytes become the baseline. A file the user had already edited before the phase began is never re-baselined, whether or not a hook touched it, and neither is one that could not be read when the snapshot was taken (locked, permission-denied): it may hold the user's edit. State.json reflects what hooks did even if a hook partially failed (non-fatal contract preserved). Parallel hash compute; bounded cost; skipped when no slot runs. This is what makes a legitimate `personalize` edit produce zero spurious drift on the next status run.
- **`state.bootstrap_fingerprint`** records the manifest's `hooks.bootstrap.fingerprint` (raw string) at the last successful bootstrap. Drives the Invariant 4 re-run decision on update. Absent if the shard never declared one. Bumps `state.json` `schema_version` to 2 (additive; forward-migrated by `state-migrator.ts`).

### Per-slot `HookContext`

The ctx is slotted — each hook receives only the fields meaningful to it (`source/runtime/types.ts`):

- **`bootstrap`** → `{ slot, vaultRoot, values, modules, shard, previousVersion? }`. No `valuesAreDefaults` (it always runs); no file lists. `previousVersion` set only on an update re-bootstrap.
- **`personalize`** → `{ slot, vaultRoot, values, modules, shard }`. No `valuesAreDefaults` — the engine already enforced the gate; if `personalize` runs at all, values are non-default.
- **`post-update`** → `{ slot, vaultRoot, values, modules, shard, previousVersion, newFiles, removedFiles }`. `newFiles` = managed paths added (`UpdateAction.kind === 'add'`); `removedFiles` = managed paths deleted. Use `removedFiles` to maintain external state (QMD collection refs, MCP registrations) that referenced now-gone paths.

### Other rules

- **`.shardmind/hooks/` is source-side only.** The installed-side `.shardmind/` holds `state.json` + cached `shard.yaml` + cached `shard-schema.yaml` + `templates/` cache — not hooks. (User's `shard-values.yaml` lives at vault root, not inside `.shardmind/`.) Engine reads hook scripts from the extracted source tarball during install/update; hook scripts never get copied into the installed vault.
- **Hook timeout** stays at the existing `DEFAULT_HOOK_TIMEOUT_MS` (non-fatal on timeout); `hooks.timeout_ms` applies per slot.

### Legacy `post-install` (deprecated)

A shard declaring the old `hooks.post-install` slot keeps working: the engine runs it **once** on install/adopt with the **legacy combined context** (the old flat `HookContext`, including `valuesAreDefaults` so existing `if (!ctx.valuesAreDefaults)` self-gating still fires) and **no write-boundary enforcement** (the old contract had none). Each run surfaces a `HOOK_POST_INSTALL_DEPRECATED` warning. Legacy `post-update` continues unchanged.

Declaring `post-install` *together with* `bootstrap` or `personalize` is rejected at parse time (`HOOK_SLOT_CONFLICT`) — a half-migrated manifest is a mistake, not a merge. The legacy slot is honored for at least one minor release (deprecated in 0.2.0; removed no earlier than 0.3.0). Migration guide: [`docs/AUTHORING.md §6`](AUTHORING.md).

## Update semantics — spec rules

- **Default: latest stable release.** `shardmind update` resolves via `GET /repos/:o/:r/releases?per_page=100` filtered for `prerelease: false`. Replaces the v0.1 `/releases/latest` endpoint, which 404'd for beta-only repos. Closes the [`ARCHITECTURE §10.7`](ARCHITECTURE.md) gap.
- **Prerelease opt-in.** `--include-prerelease` flag widens resolution to all releases. Explicit opt-in matches npm tag conventions; safer default. When the default-stable filter eliminates every entry but prereleases exist, `NO_RELEASES_PUBLISHED`'s hint points at this flag.
- **`--release <tag>` flag.** Pins to a specific tag (stable or prerelease). Mutually exclusive with `--include-prerelease` (pin already chose) and with ref installs (those track a moving ref). Named `--release` rather than `--version` because `shardmind --version` prints the package version; a per-command `--version` would read as that, and before options became positional (#147) it collided with it outright.
- **Ref-install re-resolution.** Vaults installed via `github:owner/repo#<ref>` re-fetch HEAD of the ref on every `shardmind update` — ref installs track the branch/ref. `state.json` records the user-passed `ref` and the `resolvedSha` (40-char commit hex) so status can show movement and the up-to-date short-circuit can fire on SHA equality. Enables the shard-author dev loop (install from `#main`, iterate, update to pull new commits). Ref-installed vaults reject `--release` and `--include-prerelease` as `UPDATE_FLAG_CONFLICT`; reinstalling via `shardmind install <source>@<version>` is the explicit transition off the ref.
- **Update-check cache stays stable-only.** The 24-hour cache backing `shardmind` (status) is defined as "latest stable available". `shardmind update` primes the cache only when the run resolved through the latest-stable policy — `--release`, `--include-prerelease`, and ref installs all skip the prime so the cache doesn't drift into reporting a non-stable version as "latest stable".
- **An update never silently replaces a file the user edited.** A tracked file goes to the three-way merge (skip / auto-merge / conflict) when any of these holds: its bytes differ from `rendered_hash`; its recorded ownership is `modified` (sticky, so an entry recorded under the pre-#150 rule, with the user's hash under a `modified` label, is still merged); or it is a copy-origin file whose recorded hash differs from the cached old source bytes (exact for copies, so a pre-#150 `managed` entry holding the user's hash is caught before it is overwritten). Only a file that passes all three is overwritten — or, when the new shard drops its path, deleted — silently; one that fails is merged, or kept as user content when the shard dropped it. Rendered `.njk` files get no cached-source check, because a render depends on per-run context (`install_date`, `year`, `shard.version`) and cannot be reproduced to prove a baseline. One consequence: a hook's edit to a rendered file is recorded as its baseline, so the next update whose new render differs from that baseline overwrites it — personalization belongs in copy-origin files (as obsidian-mind's is) when it must survive updates. A modified file the merge leaves as it is records the new render as its baseline. A file whose bytes equal the new render records `managed`.
- **Update reads volatility from the templates** (#210). A file whose template carries `{# shardmind: volatile #}` in the cached old shard or in the new one is skipped: never re-rendered, merged, overwritten or restored, whatever `state.json` records (install and adopt record it `managed`). A volatile file the new release no longer ships is kept as the user's and untracked. A template that turns volatile in a release is skipped from that release on; one that stops being volatile is updated as a managed file again from the release after, since the installed template still carries the marker.

## Adopt semantics — `shardmind adopt <shard>`

For users who cloned before shardmind support (obsidian-mind v5.1 and earlier) and want to adopt the update engine retroactively.

Pre-conditions enforced before any walk:
- `.shardmind/state.json` must NOT exist. Adopt is for un-adopted vaults; an existing install routes through `shardmind update`.
- `shard-values.yaml` at the vault root must NOT exist. The engine writes it at adopt-finish; a pre-existing one is an inconsistent state and surfaces `VALUES_FILE_COLLISION` (same code install uses).

Phases (logical order; UI may interleave loading messages):
1. Fetch shard at target version into a temp directory.
2. Collect values via the `AdoptValuesGate` confirm-or-override page (#104) and module selections — same value pipeline as install. Runs **before** classification because `.njk` templates need values to render before their output bytes can be hashed.
3. Classify each file the shard would install at the chosen module selections, comparing the rendered (or copied) bytes against the user's vault:
   - **Matches shard content exactly** → record hash, mark managed automatically. "Exactly" means byte-for-byte equality after the standard render pipeline (frontmatter normalized via `parseYaml → stringifyYaml`, see `renderer.ts`). A pristine clone with default values + clean YAML lands here for every file; non-default vaults legitimately produce `differs` for any rendered output the user's bytes don't post-render-equal. This is the same equality `drift.ts` enforces on update.
   - **Differs from shard content** → resolved per a batch mode (#120). When ≥1 file differs and neither `--mode` nor `--yes` is set, `AdoptModePicker` prompts once for the whole set: **keep all mine** / **use all theirs** / **auto-merge (best-effort)** / **decide per file**. Each `differs` file ends as one of: `keep_mine` (keep the user's bytes, record the shard's hash, ownership `modified`), `use_shard` (overwrite, ownership `managed`), or `merged` (write union bytes, record the shard's hash, ownership `modified`). The recorded hash is always the shard's (the baseline rule in [§Re-hash + state](#re-hash--state)), so the first update sees the user's bytes as an edit and three-way merges them against the adopt-time cache. There is no "leave untracked" outcome — adopt is the moment the file becomes managed; the merge engine handles later edits on update. **Auto-merge** is a two-way *union* merge (`core/adopt-merge.ts`): adopt has no merge base, so it keeps common + each side's unique lines, sends overlapping replacements to the per-file prompt, **does not apply shard deletions**, and can duplicate non-adjacent edits — merged files are flagged "review recommended". Non-interactive auto-merge keeps-mine on conflicts.
   - **Behind the target** (`--from-version <X>`, #325): the user's bytes equal the base release X's render, with the values this adopt run resolves, so the user never changed the file; it differs from the shard only because the shard moved on. It takes the target's bytes and is recorded managed, in every mode, never prompted: what update does for an unedited file. When the values differ from the ones the vault was cloned with, the base render does not match and the file stays an ordinary `differs`. A base release that cannot be fetched leaves the run as it was before #325, with a warning.
   - **Volatile templates** (carry `{# shardmind: volatile #}`) skip the prompt: user's bytes are recorded as managed without a differs comparison (volatile content is never expected to match across renders, so a prompt would be meaningless). Symmetric with install, which records volatile-template outputs the same way.
   - **Excluded modules' files** are not classified. If the user's vault contains them, they stay as user content.
   - User has the path but it's not a shard output → user-only, left unmanaged (not in `state.files`).
   - Shard has the path but the user's vault doesn't → shard-only, installed fresh and recorded as managed.
4. For every `differs` decision, apply: write shard bytes for `use_shard`, union bytes for `merged`, leave user bytes for `keep_mine`. All three become `state.files` entries, each recorded at the shard's hash (ownership `managed` for `use_shard`, `modified` for the other two) — adopt is the entry point into management.
5. Write `.shardmind/state.json` + cached `.shardmind/shard.yaml` + cached `.shardmind/shard-schema.yaml` + vault-root `shard-values.yaml`; cache the shard source under `.shardmind/templates/` so future `update` runs have a merge base.
6. Run the install-side hook slots via the orchestrator: `bootstrap` (always), then `personalize` (managed edits) unless the engine skips it because values are defaults (Invariant 2). `newFiles` = paths classified shard-only and freshly installed, `removedFiles` = [].
7. Re-hash managed files per the usual post-hook semantics.

Future `shardmind update` calls work normally — merge base is the adopt-time cache.

Reuses: drift detection (`core/drift.ts`), install-executor, value collection (`AdoptValuesGate` confirm page → `InstallWizard` on override, #104), hook runtime. New surfaces: batch mode picker (`AdoptModePicker`, #120), two-way union merge (`core/adopt-merge.ts`, #120), 2-way diff UI component (`AdoptDiffView`), adopt-planner, adopt-executor.

## Naming decisions

| Thing | Name | Rationale |
|-------|------|-----------|
| Engine metadata dir | `.shardmind/` on both sides | Mirror; same semantics source ↔ installed |
| Exclusion file | `.shardmindignore` at repo root | `.gitignore` convention; more discoverable than nested |
| Ignore-file semantics | gitignore semantics, negation included (#87) | An author can re-include one file a broader pattern excludes (`*.gif`, then `!onboarding.gif`) |
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
- `.shardmind.lock`, `.shardmind.lock.takeover` — the engine's run lock at the vault root and its takeover guard (#253); a shard that ships one would collide with it
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
6. New parser: `.shardmindignore` glob matcher (gitignore semantics; negation since #87).
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
    - **Superseded by the #102 hook lifecycle split.** Re-hash + `writeState` now live in `source/core/hook-orchestrator.ts` (`runHooks`), which the three command machines call after building a `HookRunPlan`; the standalone `postHookRehash` helper was removed. Re-hash + `writeState` are still skipped when nothing changed. See §Hook lifecycle and IMPLEMENTATION.md §4.16a.

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

## External tools

A shard that needs a command-line tool at runtime declares it, with the version range it needs, so an install or update refuses (or warns) when the tool is missing or too old instead of failing in subtle ways later (#138). In `shard.yaml`:

```yaml
external_tools:
  qmd:
    package: "@tobilu/qmd"
    version: ">=2.5.0"
    command: qmd
    args: ["--version"]
    optional: true
    when: qmd_enabled
```

| Field | Rule |
|-------|------|
| key (`qmd`) | The tool's name in messages. Same pattern as `command`. |
| `package` | The npm package to install it from, used only in the install hint. An npm package name: `^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$`. |
| `version` | A non-empty semver range, validated at parse time as `requires.shardmind` is. |
| `command` | The executable to run, by name only: `^[a-z0-9][a-z0-9._-]*$`. No path, no whitespace, no shell metacharacter. |
| `args` | Optional, default `["--version"]`. Each argument matches `^[A-Za-z0-9._=-]+$`: no whitespace and none of `& \| < > ^ % " !` or any other shell metacharacter. |
| `optional` | Optional, default `false`. `true`: an unmet tool is a warning and the run continues. `false`: an unmet tool refuses the run. |
| `when` | Optional. The key of a `boolean` value in `shard-schema.yaml`. When that value is `false`, the tool is not checked. A key the schema does not declare as a boolean is an error in `shardmind validate` and at install (`EXTERNAL_TOOL_WHEN_INVALID`); where it is not caught, the tool is checked, never skipped. |

**When it is checked.** An install, an adopt, and an update that installs a new version check every declared tool after the values are final and before anything is written. An update that is already up to date checks nothing. A dry run never runs a tool: its summary says "external tools not checked (dry run)". `shardmind validate` never runs one either: it checks only the declaration. No shard-supplied command runs in a dry run or in `validate`.

**How it is checked.** The engine finds `command` in the absolute directories on `PATH` (on Windows as a `.com`, `.exe`, `.bat` or `.cmd` file) and runs it with `args` and no shell, for at most 5 seconds. It then reads the version from standard output: the first full `x.y.z`, so a year or a banner before it does not count, or else the first number. A tool that prints its version only on standard error is read as printing none. The tool is:
- met when that version satisfies `version` (a prerelease above the floor counts, as for `requires.shardmind`);
- unmet otherwise, with the reason named: not found on `PATH`, exited non-zero, timed out, printed no version, or the version found and the range it misses.

A tool whose check cannot finish is never treated as met.

On Windows, npm installs a global tool as a `.cmd` file, which Node will not start without `cmd.exe`. Such a file is run as `cmd.exe /d /s /c ""<path>" <args>"`, where `<path>` is the absolute path found on `PATH`. The patterns above keep shard text out of `cmd.exe`'s parser, and a found path that contains `% " ^ & | < > !` is not run (unmet, reason named).

**What happens.** A required tool that is unmet refuses the run with `EXTERNAL_TOOL_UNMET`, naming every unmet tool and its reason. The hint installs a version inside the declared range: `npm i -g <package>@"<range>"`. An optional tool that is unmet does not stop the run: the summary lists it under "External tools" with the same hint. The engine never installs a tool itself.

## Rename migrations

A shard release that moves a file declares it, so an update carries the user's edits to the new path instead of leaving them at the old one and adding the new file fresh (#178). In `shard.yaml`:

```yaml
migrations:
  - from: "5.1.0"
    to: "6.1.0"
    renames:
      "brain/philosophy.md": "brain/manifesto.md"
```

A rename applies to an update from installed version I to target T when `I < to ≤ T`; renames chain in `to` order (a→b at 6.1, then b→c at 6.2, gives a→c). It is skipped, and the update behaves as it would without it (the old file removed or kept, the new one added), when the old path is not tracked or the new shard still ships it, the new path is already tracked (even by a file another rename moves away in the same update) or not produced by the new shard (an excluded module), anything already sits at the new path on disk, or two old paths chain to the same new path. Paths are written as they are tracked: no `./`, empty or `.` segments, no trailing slash, nothing under `.shardmind/` or `.git/`.

A renamed file is planned at its new path as the old one would have been at the same path: managed → overwritten (or moved, if unchanged); modified → three-way merged against the old path's cached template, or moved with the user's bytes when the shard did not change it, or offered in the conflict prompt (Keep mine moves the user's bytes); volatile → moved; missing → restored at the new path. The old path is deleted after the writes. A missing `migrations` field is a no-op. Not a removed file: a renamed file is never offered in the removed-files prompt.

**A case-only change is a rename of its own** (#169). A release that only changes a file name's case (`Foo.md` in one release, `foo.md` in the next, same folder) needs no `migrations` entry: the update pairs a tracked file the new shard no longer ships with the one new, untracked path in the same folder whose name differs from it only in case (or only in Unicode normalization, which macOS folds the same way), and applies the pair as a rename. The pairing is unambiguous or it does not happen: a second new path or a second old file that folds to the same name (`foo.md` and `FOO.md`) leaves the update as it would be without it. A declared rename of the old path, or into the new one, wins. It applies on every filesystem, so the user's edits follow the file to its new name on Linux too. On a case-folding filesystem (macOS, Windows) the new path resolves to the old file: that counts as free, the vault path guard does not read the pair's own names as a `case-mismatch`, and the file is renamed in place through a temporary name in the same folder instead of written and then deleted, which would delete what was just written. A user who already renamed the file to the new case is covered the same way.

**A folder's case is paired the same way** (#195). The paired paths may also differ in the case of their folders (`Notes/Foo.md` → `notes/Foo.md`), under the same rule: exactly two paths fold together, one tracked and no longer shipped, one shipped and untracked. A folder whose case changes moves as a whole or not at all: if any tracked or shipped path still spells the folder the old way, every pair under it is dropped and the update is refused as before. On a case-folding filesystem the folder itself is renamed in place, old spelling → a temporary name → new spelling, shallowest folder first and before any file is written, so files the user keeps in it move with it, since it is one folder; a rollback, including Ctrl+C, puts the folder back under its old spelling. On a case-sensitive filesystem (Linux) the old and new folders are two folders: the paired files move into the new one, as any rename does, the user's own files stay under the old spelling, and the old folder is removed only once it is empty, never while it holds anything. A tracked file the release drops is removed or kept as the user's as usual; kept, it stays in its folder, so on a case-folding filesystem it is under the new spelling.

**On adopt** (#179): `shardmind adopt <shard> --from-version <v>` applies the rename chain from `<v>` to the shard's version, for a vault cloned from release `<v>` before the engine managed it. A renamed file whose new path is absent from the vault, and whose old path exists there and is not produced by the shard, is compared at the new path against the shard's output. It then moves: a match or Keep mine carries the user's file to the new path; Use the shard's or a merge writes the new path and deletes the old one. Something already at the new path, two renames into one path, or an old path the shard still ships leaves the rename out. A `--from-version` that is not semver is refused (`ADOPT_FROM_VERSION_INVALID`); a version no migration applies to is a no-op. Without the flag, adopt is unchanged.

## Out of scope — deferred to v0.2

Criterion: **obsidian-mind v6 does not need these to install, configure, or upgrade cleanly.** Each is a clean additive extension — deferring doesn't force retroactive design changes.

Nothing from the original v0.2 list is still deferred: `.shardmindignore` negation was built (#87), and the rest was declined on 2026-10-05, below. A new deferral goes here with its date.

**Declined** (dated; reopen if the reason stops holding):

- A shared `VaultFS` with built-in rollback for install and update (#33), declined 2026-10-04. The two rollbacks are different models: install restores collision backups and removes created paths; update restores a snapshot of touched paths and replays a case-rename journal and a created-folders record. One LIFO undo would express neither without becoming a second copy of both.
- A `SHARDMIND_DEBUG` log of every phase, fetch and write (#36), declined 2026-10-04. No debugging pain has been reported; an install's failure stays on screen with its code and hint, `--json` and the hook logs already record runs, and a log of every fetch and write adds a redaction surface. The real gap, an unexpected error shown without its stack, is #225.
- A `--skip-hooks` flag on adopt, install or update (#199), declined 2026-10-05. Hooks are non-fatal and their failures are reported. The case that prompted it was a shard bug (#137, fixed), and a skipped bootstrap would re-run on the next update (Invariant 4).
- Several shards in one vault (#81), declined 2026-10-05. There is one shard and no request. The cost is a second dimension in state, drift and every pipeline. One vault, one shard.
- Nunjucks at vault-visible paths (`rendered_files`, #86), declined 2026-10-05. Post-install hooks personalise visible files, as obsidian-mind's do, and a clone stays byte-identical to a defaults install without a render step.
- Guided file creation at install (#79), declined 2026-10-05. A product feature of the shard (its agent walks the user through it), not the engine's.
- Folder shapes per purpose inside one shard (#80), declined 2026-10-05. Different purposes are different shards, and modules cover optional parts.
- Fetching a shard's dependencies (#82), declined 2026-10-05. Shards vendor what they need. A resolver and a lock file add a supply-chain surface no shard has asked for.
- `shardmind eject` (#83), declined 2026-10-05. Deleting `.shardmind/` and `shard-values.yaml` leaves a working vault, and the README says so.
- `shardmind init` (#84), declined 2026-10-05. Copy `examples/minimal-shard/`, and `shardmind validate` checks the result.
- Named registries in a user config with `--registry` (#39), declined 2026-10-05. `SHARDMIND_REGISTRY_INDEX_URL` points at another index (docs/OPERATIONS.md), and `github:owner/repo` bypasses the registry.
- A published GitHub Action and a separate community listing (#90), declined 2026-10-05. `npx shardmind validate --json` is the CI step, and the registry index is the listing.
- Team and organisation management (#91), declined 2026-10-05. No team has asked, and the roadmap made it conditional on demand. Reopen on the first real request.

## Transition

No shard migration required — zero shards published under the v0.1 `templates/` contract. obsidian-mind v6 is the first shard under this contract.

- `examples/minimal-shard/` restructures to the flat layout during Day 1-4 build.
- obsidian-mind v6 conversion (Day 5): v5.1's structure + `.shardmind/` sidecar + any dotfolder `.njk` for config rendering.
- Research-wiki shard (Day 6): same flat layout; uses hooks for any personalization (no `rendered_files` dependency).
- `docs/ARCHITECTURE.md §3`, `docs/AUTHORING.md §2` + §7, `docs/IMPLEMENTATION.md §4.*` rewrite once this design lands in code.
- [#67](https://github.com/breferrari/shardmind/issues/67) (branch/ref install) and [#69](https://github.com/breferrari/shardmind/issues/69) (`.shardmind/` source layout) subsumed by [#70](https://github.com/breferrari/shardmind/issues/70).
