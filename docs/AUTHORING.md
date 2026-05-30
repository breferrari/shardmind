# Authoring a ShardMind shard

This guide walks through every file and concept a shard author needs. Read [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) first if you want the "why"; this document covers the "how".

## 1. What is a shard

A shard is a git repository that ShardMind installs into a user's vault. **A shard is an Obsidian vault** — the repo opens cleanly in Obsidian without shardmind. ShardMind adds install-time personalization, safe upgrades, and modular composition on top.

A shard ships:

1. **Vault content at native paths** — `brain/`, `Home.md`, `CLAUDE.md`, `bases/`, `.claude/`, `.obsidian/`, etc. The repo's content tree is what installs.
2. **Engine metadata under `.shardmind/`** — `shard.yaml` (manifest), `shard-schema.yaml` (values + modules + signals), `hooks/*.ts` (optional, source-side only).
3. **`.shardmindignore` at the repo root** — gitignore-spec excludes for repo-only artifacts (CONTRIBUTING.md, translations, marketing media).
4. **`.njk` Nunjucks rendering** — author-explicit opt-in by suffix. Convention is to keep `.njk` to dotfolder configs (`.claude/settings.json.njk`) so the clone-UX cost stays zero, but iterator templates and any tagged vault-visible `.njk` also render.

Users run `shardmind install <namespace>/<shard>`. The engine downloads the tarball, walks the shard root applying Tier 1 exclusions + `.shardmindignore` + symlink rejection, prompts for values, lets the user opt out of removable modules, renders + copies + caches, writes `state.json`, and runs your hook. Users never edit your shard directly — they edit their vault, and the next `shardmind update` merges upstream changes into their customizations via three-way merge.

A user who already cloned your repo (typically before shardmind support existed) can run `shardmind adopt <namespace>/<shard>` instead. Adopt walks the existing vault, classifies each shard-output path against what the install would have produced, and asks the user — for any file that differs — whether to keep their version (recorded as `ownership: 'modified'`) or accept the shard's. Files matching exactly are auto-managed; files only the shard ships are installed fresh. After adopt, `shardmind update` works normally — the cache made at adopt time becomes the merge base. See `docs/SHARD-LAYOUT.md §Adopt semantics` for the full contract.

## 2. File layout

The shard repo's layout *is* the installed vault's layout — no `templates/` wrapper, no separate `commands/`/`agents/`/`codex/` trees. Vault content sits at native paths in the source tree.

```
your-shard/                    ← also opens cleanly as an Obsidian vault
├── .shardmind/
│   ├── shard.yaml             ← manifest — who you are
│   ├── shard-schema.yaml      ← schema — questions, modules, signals
│   └── hooks/                 ← optional lifecycle scripts (source-side only)
│       ├── bootstrap.ts       ← unmanaged-path setup (git init, indexes)
│       ├── personalize.ts     ← managed-file edits (skipped on a defaults install)
│       └── post-update.ts     ← additive managed-file edits on update
│
├── .shardmindignore           ← repo-only excludes (CONTRIBUTING.md, *.gif, …)
│
├── CLAUDE.md                  ← agent operating manual (verbatim copy on install)
├── AGENTS.md                  ← (optional) Codex
├── GEMINI.md                  ← (optional) Gemini CLI
├── Home.md                    ← Obsidian landing note (static or `Home.md.njk` to render)
├── brain/
│   └── North Star.md          ← static; personalize via the personalize hook
├── .claude/
│   ├── commands/reflect.md    ← `mod.commands: ["reflect"]` gates this by name
│   ├── agents/                ← `mod.agents` similarly
│   └── settings.json.njk      ← dotfolder render fixture: `{{ values.X }}` → settings.json
│
├── .obsidian/                 ← Obsidian vault-shape config (themes, plugins, etc.)
├── .mcp.json                  ← MCP server registry
│
├── scripts/                   ← vault-bundled scripts (e.g. QMD bootstrap)
└── README.md, LICENSE
```

Minimum: `.shardmind/shard.yaml` + `.shardmind/shard-schema.yaml`. Everything else is optional.

**Three testable properties** (binding contract):

1. The shard repo at HEAD opens cleanly as a vault in Obsidian with no preparation.
2. `shardmind install --defaults <shard>` produces a vault byte-equivalent to `git clone <shard>` (modulo Tier 1 exclusions + `.shardmind/` engine metadata + vault-root `shard-values.yaml`).
3. Deleting `.shardmind/` on either side leaves a working vault.

See [`docs/SHARD-LAYOUT.md`](../docs/SHARD-LAYOUT.md) for the full v6 layout contract.

## 3. `shard.yaml` — the manifest

Identity + metadata. Validated by [`schemas/shard.schema.json`](../schemas/shard.schema.json).

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/breferrari/shardmind/main/schemas/shard.schema.json

apiVersion: v1
name: obsidian-mind
namespace: breferrari
version: 3.5.0
description: "AI-augmented vault template for research and engineering"
persona: "Knowledge workers who think in Markdown"
license: MIT
homepage: https://github.com/breferrari/obsidian-mind

requires:
  node: ">=22.0.0"

hooks:
  bootstrap:
    script: .shardmind/hooks/bootstrap.ts
    fingerprint: "qmd-v1"
  personalize: .shardmind/hooks/personalize.ts
  post-update: .shardmind/hooks/post-update.ts
```

### Field reference

| Field | Required | Notes |
|---|---|---|
| `apiVersion` | yes | Always `v1` in v0.x. |
| `name` | yes | Lowercase alphanumeric + hyphens. By convention matches your repo name. |
| `namespace` | yes | Usually your GitHub username. Lowercase alphanumeric + hyphens. |
| `version` | yes | Valid semver. Release tag must be `v<version>` (e.g., `v3.5.0`). |
| `description` | no | One line shown in the install header. |
| `persona` | no | Shown in the header as "for <persona>". |
| `license` | no | SPDX identifier. |
| `homepage` | no | URL. |
| `requires.obsidian` | no | Semver range. Advisory only in v0.1. |
| `requires.node` | no | Semver range. Applied when hooks run. |
| `dependencies` | no | Array of `{ name, namespace, version }`. Vendored in v0.1 (pre-install manually); auto-fetched in v0.2+. |
| `hooks.bootstrap` | no | Path string, or `{ script, fingerprint? }`. Unmanaged-path setup. Runs on install/adopt + on update when `fingerprint` changes. See §6. |
| `hooks.personalize` | no | Path relative to shard root. Managed-file edits. Runs on install/adopt only; skipped when values are defaults. See §6. |
| `hooks.post-update` | no | Path relative to shard root. Additive managed-file edits on update (`ctx.newFiles`). See §6. |
| `hooks.post-install` | no | **Deprecated** — legacy combined hook. Mutually exclusive with the slots above (`HOOK_SLOT_CONFLICT`). Honored until ≥0.3.0; migrate to `bootstrap` + `personalize`. |
| `hooks.timeout_ms` | no | Per-slot timeout in ms. Default 30000; range 1000–600000. |

## 4. `shard-schema.yaml` — the schema

Declares questions, module toggles, signals, frontmatter rules, and migrations. Validated by [`schemas/shard-schema.schema.json`](../schemas/shard-schema.schema.json).

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/breferrari/shardmind/main/schemas/shard-schema.schema.json

schema_version: 1

values:
  user_name:
    type: string
    required: true
    message: "Your name"
    group: setup

  vault_purpose:
    type: select
    required: true
    message: "How will you use this vault?"
    options:
      - { value: engineering, label: "Engineering" }
      - { value: research,    label: "Research" }
      - { value: general,     label: "General" }
    group: setup

  qmd_enabled:
    type: boolean
    message: "Enable QMD semantic search?"
    default: "{{ vault_purpose == 'engineering' }}"
    group: setup

groups:
  - id: setup
    label: "Quick Setup"

modules:
  brain:
    label: "Goals, memories, patterns"
    paths: ["brain/"]
    removable: false

  extras:
    label: "Optional features"
    paths: ["extras/"]
    commands: ["reflect"]
    removable: true

signals:
  - id: DECISION
    description: "A choice was made"
    routes_to: "brain/"
    core: true

frontmatter:
  global: [date, description, tags]
  brain-note:
    required: [date, description]
    path_match: "brain/*.md"

migrations: []
```

### `values` — the wizard

Each entry becomes one prompt. Supported `type`s:

| Type | Wizard UI | Validator |
|---|---|---|
| `string` | TextInput | any string; `required` blocks empty |
| `number` | TextInput | finite number; honors `min` / `max` |
| `boolean` | Select (Yes / No) | bool |
| `select` | Select | must be one of `options[].value` |
| `multiselect` | scrollable multi-select (↑↓ navigate, space toggles, Enter submits) | array of `options[].value`; honors `min` / `max` (array length) |
| `list` | comma-separated text | array of strings |

`message` is the prompt text. `hint` is gray helper text. `placeholder` is shown in empty inputs.

#### `multiselect` — pick a set

Ask one checkbox question instead of N booleans (e.g. "Which agents do you use?"). Each option may carry `default: true` to seed the initial selection; `min` / `max` bound how many the user may choose.

```yaml
agents:
  type: multiselect
  message: "Which agents do you use?"
  options:
    - { value: claude, label: "Claude Code", default: true,  description: "Full hook + skill + command support" }
    - { value: codex,  label: "Codex CLI",   default: false, description: "AGENTS.md + .codex/ hooks" }
    - { value: gemini, label: "Gemini CLI" }
  min: 1
  group: setup
```

Default rules:
- Declare the default selection EITHER per-option (`default: true`) OR with a top-level `default` array — **never both** (`SCHEMA_VALIDATION_FAILED`). The engine normalizes per-option flags into the canonical top-level array internally.
- Per-option `default` is multiselect-only; on any other `type` it throws `SCHEMA_VALIDATION_FAILED`.
- A multiselect with no per-option flags and no top-level `default` defaults to an empty selection (`[]`) — multiselect is exempt from the "every value declares a `default`" rule.
- A top-level `default` may be a literal array or a computed `{{ … }}` expression (see Computed defaults below).
- `min` / `max` bound the selected count, and **the default must satisfy them** — a `min: 1` multiselect must default to at least one selection (a `--defaults` install must produce a valid vault, so an out-of-range default is rejected at parse). `min` cannot exceed the number of options. (Computed defaults resolve at install time, so their length isn't checked at parse.)

Templates read the result with Nunjucks membership: `{% if 'codex' in values.agents %}…{% endif %}`. (Gating *which modules install* on a multiselect value is a separate feature — [#80](https://github.com/breferrari/shardmind/issues/80), v0.2.)

**Reserved names** (cannot be used as value keys — they shadow the render context):
`shard`, `install_date`, `year`, `included_modules`, `values`. Using any of these throws `SCHEMA_RESERVED_NAME` at install.

#### Computed defaults

A `default` string starting with `{{` is evaluated as a Nunjucks expression after all non-computed values have been answered. The evaluation context is the collected values.

```yaml
qmd_enabled:
  type: boolean
  default: "{{ vault_purpose == 'engineering' }}"
```

Coercion rules:
- `string` / `select` → raw rendered output
- `boolean` → expression must render exactly `"true"` or `"false"`
- `number` → must render a finite number
- `multiselect` / `list` → must render a JSON array (use Nunjucks `dump`: `"{{ ['a', 'b'] | dump }}"`)

Errors surface at install time as `COMPUTED_DEFAULT_FAILED` or `COMPUTED_DEFAULT_INVALID` with the key named.

### `groups` — wizard sections

Every value's `group` must reference a declared group `id`. Groups drive wizard section titles.

### `modules` — optional feature sets

Users see non-removable modules as locked "always included"; removable modules are checkboxes with label + file count + live install total.

A module owns (priority order: paths > bases > per-name):
- `paths` — directory prefixes (any file under `brain/` belongs to the `brain` module).
- `bases` — base template IDs (matches `bases/<id>.base.njk` from the shard root).
- `commands` — basenames matched only when the file's parent directory is `commands` (case-insensitive, any depth) — typically `.claude/commands/<name>.<ext>`.
- `agents` — basenames matched the same way for `agents` parent dirs.

Files outside any module's `paths` / `bases` / per-name claim are always copied regardless of module selection — these are framework-level (e.g. agent operating manuals at the vault root, scripts in any non-claimed directory).

### `signals` — LLM routing hints

Declarative "when to route where". Surfaced to agents via `shardmind/runtime`. `core: true` means always active; `module: <id>` gates on a module being included.

### `frontmatter` — per-note-type rules

Shorthand `key: [a, b]` expands to `key: { required: [a, b] }`. Optional `path_match` applies the rule only to matching paths. `global` is the catch-all.

`path_match` uses shell-glob semantics: `*` matches within a single path segment (stops at `/`), `**` crosses segments. So `brain/*.md` matches `brain/Goals.md` but not `brain/sub/deep/Goals.md`; use `brain/**.md` if you want every `.md` under `brain/` regardless of depth. Regex metacharacters inside the glob (`.`, `[`, `(`, etc.) are treated as literals.

### `migrations` — value migrations

Ordered rules applied to `shard-values.yaml` when the shard version moves forward. Four change types: `rename`, `added`, `removed`, `type_changed`. See `MigrationChange` in `source/runtime/types.ts` for the exact shape.

## 5. Templates

Any file ending in `.njk` anywhere in the shard root is rendered with [Nunjucks](https://mozilla.github.io/nunjucks/). Engine settings:

- `autoescape: false` (you're rendering Markdown, not HTML)
- `trimBlocks: true` / `lstripBlocks: true` (tidy output around `{% ... %}` tags)

### Naming

- `.njk` suffix → template, rendered; suffix is stripped. `Home.md.njk` → `Home.md`, `.claude/settings.json.njk` → `.claude/settings.json`.
- No `.njk` → copy verbatim to the same relative path.
- Author convention: keep `.njk` to dotfolder configs (`.claude/settings.json.njk`, `.mcp.json.njk`) so the clone-UX cost stays zero. Iterator templates (`<dir>/_each.<ext>.njk`) and any explicitly-tagged vault-visible `.njk` also render — the engine doesn't restrict by location.
- **Why the dotfolder convention matters for Invariant 1.** Renderable templates render to bytes that legitimately differ from the source (`install_date`, value substitution); the [Invariant 1](SHARD-LAYOUT.md#invariant-1--install---defaults-is-clone-equivalent) helper enforces presence-at-mapped-path for `.njk` and byte-equivalence for static files. The smaller a shard's render-delta surface, the closer `install --defaults` is to a true `git clone`. Vault-visible content authored as static `.md` + `personalize`-hook personalization keeps the surface small.

### Frontmatter-aware rendering

If a template starts with `---\n...yaml...\n---\n`, frontmatter is:
1. Rendered as its own Nunjucks pass
2. Parsed as YAML
3. Re-serialized with safe escaping (lineWidth 0, trim trailing newline)

The body after the second `---` is rendered in a second pass. This gives you escape-safety on YAML-embedded expressions without manual quoting.

### Render context

Every template has access to:

| Key | Type | Value |
|---|---|---|
| `values` | object | Merged user answers (after computed defaults resolved) |
| `included_modules` | string[] | IDs of modules the user kept |
| `shard` | `{ name, version }` | From `shard.yaml` |
| `install_date` | string | ISO-8601 UTC, set once at install |
| `year` | string | `YYYY` |

Values are spread into the top level too. `{{ user_name }}` works the same as `{{ values.user_name }}`.

### The volatile marker

A template whose first non-whitespace content is `{# shardmind: volatile #}` renders as a volatile file. `shardmind update` skips overwriting volatile files even when the template changed — useful for LLM-maintained indexes, daily notes, wiki-style TOCs. The marker is stripped from the output.

```
{# shardmind: volatile #}
# Daily Index

{% for note in daily_notes %}
- [[{{ note }}]]
{% endfor %}
```

### `_each` templates

A template whose output path contains `_each` renders once per entry of a list-typed value. The rendered filename uses the item's `slug` or `name` field for the path segment that replaces `_each`.

## 6. Hooks

Hooks are TypeScript files with a default async export, declared under `hooks:` in `shard.yaml`. There are three named slots, each with a distinct lifecycle and an engine-enforced write boundary:

```yaml
hooks:
  bootstrap:
    script: .shardmind/hooks/bootstrap.ts
    fingerprint: "qmd-v1"      # optional — see "Re-running bootstrap" below
  personalize: .shardmind/hooks/personalize.ts
  post-update: .shardmind/hooks/post-update.ts
  timeout_ms: 30000            # optional, applies to every slot
```

| Slot | Runs on | May write | The engine… |
|------|---------|-----------|-------------|
| `bootstrap` | first install + adopt; on update iff `fingerprint` changed | **unmanaged** paths only (`.qmd/`, `.git/`, caches) | always runs it; warns if it writes a managed file |
| `personalize` | first install + adopt **only** | **managed** files only | **does not call it at all** when the user accepted every default; warns if it creates an unmanaged file |
| `post-update` | updates | **managed** files in `ctx.newFiles` only | additive-only by convention (Invariant 3); not write-boundary-checked |

Each is a default async export taking a slot-specific context:

```ts
import type { BootstrapContext } from 'shardmind/runtime';

export default async function (ctx: BootstrapContext): Promise<void> {
  // ctx.slot            — 'bootstrap'
  // ctx.vaultRoot       — absolute path to the installed vault
  // ctx.values          — the answered values
  // ctx.modules         — { moduleId: 'included' | 'excluded' }
  // ctx.shard           — { name, version }
  // ctx.previousVersion — set only on an update re-bootstrap
  await runQmdBootstrap(ctx.vaultRoot);   // touches .qmd/ — unmanaged. Fine.
}
```

### What changed from `post-install` (and why)

The old single `post-install` hook bundled three jobs with different lifecycles — unmanaged setup, managed-file personalization, and one-time conversions — and you had to hand-gate the personalization on `ctx.valuesAreDefaults` to keep Invariant 1. That gate is now the engine's job. The slots make each job's contract explicit and machine-checked:

- **You no longer write `if (!ctx.valuesAreDefaults) …`.** The engine simply doesn't invoke `personalize` on a defaults install. `PersonalizeContext` has no `valuesAreDefaults` field — if your `personalize` hook runs, values are non-default by construction.
- **The write boundary is checked.** If `bootstrap` edits a managed file or `personalize` creates an unmanaged one, the engine surfaces a non-fatal warning naming the paths (it does not undo the write). This catches a mis-placed responsibility during your dev loop instead of silently breaking Invariant 1 in the field.

### Per-slot context

- **`BootstrapContext`** → `{ slot: 'bootstrap', vaultRoot, values, modules, shard, previousVersion? }`. No `valuesAreDefaults`, no file lists.
- **`PersonalizeContext`** → `{ slot: 'personalize', vaultRoot, values, modules, shard }`. Write only managed files (e.g. `brain/North Star.md`). Runs only with non-default values.
- **`PostUpdateContext`** → `{ slot: 'post-update', vaultRoot, values, modules, shard, previousVersion, newFiles, removedFiles }`.
  - **`newFiles: string[]`** — managed paths added this update (`UpdateAction.kind === 'add'`; excludes `overwrite`, `auto_merge`, `restore_missing`, conflict resolutions). Restrict writes to these — clobbering an existing managed file risks overwriting the three-way-merge resolution that just ran.
  - **`removedFiles: string[]`** — managed paths deleted this update. The vault file is already gone; use this to clean up external state (QMD refs, MCP registrations) that pointed at it.

### Re-running bootstrap on update

`bootstrap` is for unmanaged artifacts that don't change often. By default it runs once (install/adopt) and never re-runs on update. If a new version changes an artifact's schema — say the QMD index format — add or bump `hooks.bootstrap.fingerprint`. The engine records the fingerprint in `state.json` at each successful bootstrap and re-runs `bootstrap` on update whenever the manifest's fingerprint differs from the recorded one. The string is opaque to the engine (compared with `!==`); use anything stable per artifact version (`"qmd-v1"`, `"index-2026.01"`).

### Worked migration: splitting an old `post-install.ts`

Old combined hook:

```ts
// hooks/post-install.ts  (deprecated)
export default async function (ctx: HookContext): Promise<void> {
  await ensureGitRepo(ctx.vaultRoot);              // unmanaged — .git/
  await bootstrapQmd(ctx.vaultRoot, ctx.values);   // unmanaged — .qmd/
  if (!ctx.valuesAreDefaults) {                    // hand-gated managed edit
    await personalizeNorthStar(ctx.vaultRoot, ctx.values);
  }
}
```

splits into:

```ts
// hooks/bootstrap.ts
export default async function (ctx: BootstrapContext): Promise<void> {
  await ensureGitRepo(ctx.vaultRoot);
  await bootstrapQmd(ctx.vaultRoot, ctx.values);
}

// hooks/personalize.ts  — no value gate; engine skips this hook on a defaults install
export default async function (ctx: PersonalizeContext): Promise<void> {
  await personalizeNorthStar(ctx.vaultRoot, ctx.values);
}
```

and the manifest moves from `hooks.post-install: hooks/post-install.ts` to the three-slot form above. Declaring `post-install` alongside `bootstrap`/`personalize` is rejected at parse time (`HOOK_SLOT_CONFLICT`) — finish the migration in one step. The legacy slot is honored until at least 0.3.0; migrate before then.

### Capabilities

Hooks **can**:
- Read / write files anywhere in `vaultRoot`
- Run shell commands (`git init`, `qmd setup`, etc.)
- Log to stdout AND stderr (both captured and surfaced in the install summary as separate labeled blocks)
- Import `shardmind/runtime` for helpers (`loadValues`, `loadState`, `validateFrontmatter`)

Hooks **cannot**:
- Modify `.shardmind/` (engine-owned)
- Modify `shard-values.yaml` (user-owned)
- Affect the install/update flow by throwing — exceptions become warnings, not fatal errors

### Post-hook re-hash

After the hook phase exits — success OR failure — the engine re-hashes every managed file in `state.json` and writes the updated state. **This means a hook that legitimately edits a managed file (a `personalize` or `post-update` write) does not produce spurious "drift" on the next `shardmind` status run.**

A consequence to know: `state.json` reflects whatever bytes are on disk *after* the hook exits. If a hook crashes mid-write, the partial bytes get hashed and adopted as the new managed hash — drift detection won't flag them as drift, because state-matches-disk by construction. If you need atomicity (the file is either fully-written or untouched), use `fs.rename` from a temp file inside your hook; don't rely on the engine to detect partial writes.

The re-hash is also where the engine detects a `bootstrap` that wrote a managed file (a boundary violation): the file's hash changed but `bootstrap` had no business touching it. That surfaces as a `HOOK_BOOTSTRAP_MANAGED_WRITE` warning — the edit stays on disk, but you've put it in the wrong slot.

### Runtime environment

Hooks run in a subprocess via the bundled `tsx` TypeScript loader; your `.ts` file is transpiled on load and executed with the same Node that's running `shardmind`. No separate build step on the shard-author side.

The child process receives:
- `cwd` = `ctx.vaultRoot` (so `git init` / `qmd setup` act on the installed vault).
- The parent's environment, plus:
  - `SHARDMIND_HOOK=1` — tag for "running under shardmind" detection.
  - `SHARDMIND_HOOK_PHASE=bootstrap` | `personalize` | `post-update` (or `post-install` for a legacy hook) — the slot currently running.
- `ctx` (the slot-specific context above) as the single argument to your default export.

### Timeouts

The default hook timeout is **30 seconds**. Override per-shard by adding `hooks.timeout_ms` to `shard.yaml`:

```yaml
hooks:
  bootstrap: .shardmind/hooks/bootstrap.ts
  timeout_ms: 60000    # 60 seconds; valid range: 1_000..600_000; applies to every slot
```

A hook that exceeds its budget is sent `SIGTERM` (Windows: `TerminateProcess`), given a 2-second grace period to flush buffered output, then hard-killed with `SIGKILL`. The install / update itself still completes — a timed-out hook is a warning, not a rollback trigger.

### Output limits

Each stream (stdout and stderr) is captured up to **256 KB**. Beyond that the capture truncates and appends a `[… truncated, N bytes discarded]` marker. The UI's live "running-hook" view additionally caps the displayed tail at 64 KB so Ink's render buffer can't be wedged by a runaway `console.log` loop.

Ordering is preserved *within* each stream but not *across* stdout and stderr — if you need strict interleaving, funnel everything through one stream in your hook.

### Cancellation

If the user hits Ctrl+C while your hook is running, the child receives a termination signal and the parent exits 130. Install / update are **not** rolled back — state.json is already on disk when the hook fires, so a cancelled hook leaves the vault fully installed but with whatever setup your hook was still doing left incomplete.

On Windows, `SIGTERM` is emulated as `TerminateProcess`, which skips the hook's own cleanup handlers. Treat your hooks as interruptible at any line; don't rely on try/finally running to completion on Windows cancel.

## 7. Testing your shard locally

The fastest dev loop avoids cutting a tag for every change. Install from a branch or commit SHA via the `#<ref>` syntax, iterate, push, and re-install.

1. Push your work-in-progress to a branch on your GitHub account (default branch is fine; a feature branch is fine).
2. In an empty directory: `shardmind install github:<user>/<shard>#<branch> --dry-run`. Fix anything broken.
3. Drop `--dry-run` for a real install. Inspect the resulting vault.
4. **Iterate**. After each push, run `shardmind update` from the same vault — the engine re-resolves the branch HEAD, fetches the new commit's tarball, and three-way-merges your local edits with the upstream changes.
5. Use `scripts/smoke-install.sh` in the shardmind repo as a template for your own smoke harness.

When you're ready to publish a stable release, tag it (`git tag v6.0.0 && git push --tags`) and re-install via `shardmind install github:<user>/<shard>` (no `#<ref>` — the latest stable release wins).

### `#<ref>` syntax

| Form                                  | Resolves to                                |
|---------------------------------------|--------------------------------------------|
| `github:user/shard#main`              | Branch HEAD; tracks movement on `update`.  |
| `github:user/shard#feature/foo`       | Branch with `/` in the name (URL-encoded). |
| `github:user/shard#v1.0.0`            | Tag (any tag, prerelease included).        |
| `github:user/shard#abc1234`           | Commit SHA prefix (≥ 7 chars).             |
| `github:user/shard#abc12…40chars…`    | Full commit SHA.                           |

`#<ref>` is mutually exclusive with `@<version>`. Registry-mode refs (`user/shard#main` without `github:`) are rejected — the registry index has no per-branch metadata.

### Update flags

| Flag                       | Effect                                                                                  |
|----------------------------|-----------------------------------------------------------------------------------------|
| (none)                     | Fetch `/releases?per_page=100`; pick latest non-prerelease after client-side filtering. |
| `--release <tag>`          | Pin to a specific release tag (stable or prerelease).                                   |
| `--include-prerelease`     | Same `/releases?per_page=100` lookup, but latest-resolution includes prereleases.       |

Ref-installed vaults (`state.ref` set) re-resolve the tracked ref on every `update` and accept neither `--release` nor `--include-prerelease` — both reject as `UPDATE_FLAG_CONFLICT`. To switch a ref-installed vault to a tag pin, reinstall via `shardmind install <source>@<version>`.

## 8. Publishing checklist

Before tagging a release:

- [ ] `shard.yaml` `version` matches the git tag (`v` prefix on the tag, no prefix in the file)
- [ ] Install completes cleanly with `--dry-run` against a representative values file
- [ ] Every value in `shard-schema.yaml` has a clear `message`
- [ ] Computed defaults work against at least two realistic answer sets
- [ ] Removable modules produce no files when excluded
- [ ] Hook scripts complete within their `hooks.timeout_ms` budget on a cold machine (or within 30 s if unset)
- [ ] README in your shard repo explains: what it installs, who it's for, how to upgrade

## 9. Common errors

See [`docs/ERRORS.md`](ERRORS.md) for the full catalog. The authoring-side ones you'll hit most:

- `SCHEMA_RESERVED_NAME` — you named a value `shard`, `install_date`, `year`, `included_modules`, or `values`.
- `SCHEMA_VALIDATION_FAILED` — a value's `group` doesn't match any group ID, or a select/multiselect is missing `options`.
- `COMPUTED_DEFAULT_INVALID` — your `{{ expression }}` didn't produce the expected type.
- `RENDER_FAILED` — Nunjucks error. Check for `{% ... %}` without matching `{% end... %}` and references to undefined values.

## Further reading

- [`README.md`](../README.md) — user perspective
- [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) — why the engine is shaped this way
- [`docs/IMPLEMENTATION.md`](IMPLEMENTATION.md) — module-level specs
- [`examples/minimal-shard/`](../examples/minimal-shard/) — a working shard to crib from
