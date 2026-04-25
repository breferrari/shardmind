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

## 2. File layout

The shard repo's layout *is* the installed vault's layout — no `templates/` wrapper, no separate `commands/`/`agents/`/`codex/` trees. Vault content sits at native paths in the source tree.

```
your-shard/                    ← also opens cleanly as an Obsidian vault
├── .shardmind/
│   ├── shard.yaml             ← manifest — who you are
│   ├── shard-schema.yaml      ← schema — questions, modules, signals
│   └── hooks/                 ← optional lifecycle scripts (source-side only)
│       ├── post-install.ts
│       └── post-update.ts
│
├── .shardmindignore           ← repo-only excludes (CONTRIBUTING.md, *.gif, …)
│
├── CLAUDE.md                  ← agent operating manual (verbatim copy on install)
├── AGENTS.md                  ← (optional) Codex
├── GEMINI.md                  ← (optional) Gemini CLI
├── Home.md                    ← Obsidian landing note (static or `Home.md.njk` to render)
├── brain/
│   └── North Star.md          ← static; personalize via post-install hook
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
  post-install: hooks/post-install.ts
  post-update: hooks/post-update.ts
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
| `hooks.post-install` | no | Path relative to shard root. Runs after first install. |
| `hooks.post-update` | no | Path relative to shard root. Runs after update. |

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
| `boolean` | ConfirmInput (y/n) | bool |
| `select` | Select | must be one of `options[].value` |
| `multiselect` | comma-separated text (v0.1) | array of `options[].value` |
| `list` | comma-separated text | array of strings |

`message` is the prompt text. `hint` is gray helper text. `placeholder` is shown in empty inputs.

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

`hooks/post-install.ts` (and `post-update.ts`) are TypeScript files with a default async export:

```ts
import type { HookContext } from 'shardmind/runtime';

export default async function(ctx: HookContext): Promise<void> {
  console.log(`Welcome, ${ctx.values.user_name}. Installed ${ctx.shard.name}@${ctx.shard.version}.`);
  // ctx.vaultRoot         — absolute path to the installed vault
  // ctx.values            — the answered values
  // ctx.modules           — { moduleId: 'included' | 'excluded' }
  // ctx.shard             — { name, version }
  // ctx.previousVersion   — only set on post-update
  // ctx.valuesAreDefaults — true iff every user value equals the schema default
  // ctx.newFiles          — managed paths newly added by this run
  // ctx.removedFiles      — managed paths removed by this run
}
```

### v6 invariants the hook ctx encodes

The three v6 ctx fields (`valuesAreDefaults`, `newFiles`, `removedFiles`) are how shards encode the additive-principle invariants documented in `docs/SHARD-LAYOUT.md`. Use them as gates, not as suggestions:

- **`valuesAreDefaults: true`** — every user value equals the schema default. **Hooks that modify managed files (tracked in `state.json`) must no-op in this branch.** Otherwise an `install --defaults` produces a vault that diverges from `git clone` byte-for-byte, breaking Invariant 1. Hooks that create *unmanaged* files (QMD indexes, MCP caches, `.git`) may run unconditionally — they don't enter `state.files`.

  Example pattern:
  ```ts
  if (!ctx.valuesAreDefaults) {
    await fs.writeFile(join(ctx.vaultRoot, 'brain', 'North Star.md'), personalize(ctx.values));
  }
  // QMD bootstrap runs unconditionally — it touches .qmd/, not managed paths.
  await runQmdBootstrap(ctx.vaultRoot);
  ```

  The deep-equal is strict: array order is significant. `multiselect` with schema default `[a, b]` vs user-selected `[b, a]` answers `false`. The wizard preserves option order on `--defaults` runs and on no-op multiselect submissions, so the strict rule fires only when the user genuinely re-ordered.

- **`newFiles: string[]`** — managed paths newly added by this run. Empty on clean install (every path is new — uninformative); empty on a no-op update; populated on update with paths from `UpdateAction.kind === 'add'` (excluding `overwrite`, `auto_merge`, `restore_missing`, and conflict resolutions, since those paths were already managed). Restrict your post-update hook's writes to these paths by default — clobbering an existing managed file risks overwriting the three-way-merge resolution that just ran.

- **`removedFiles: string[]`** — managed paths removed by this update (`UpdateAction.kind === 'delete'`). Empty on install. Use to maintain external state — QMD collection refs, MCP registrations — that referenced now-removed paths. The vault file is already gone by the time your hook runs.

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

After every `post-install` / `post-update` invocation — success OR failure — the engine re-hashes every managed file in `state.json` and writes the updated state. **This means a hook that legitimately edits a managed file does not produce spurious "drift" on the next `shardmind` status run.** It also means a hook that crashed mid-edit leaves `state.json` reflecting the partial bytes on disk; drift detection surfaces the discrepancy on the next status run, not silently. Hook-managed-file edits are still subject to the Invariant 2 rule above — the re-hash is what makes the rule observable, not a license to ignore it.

### Runtime environment

Hooks run in a subprocess via the bundled `tsx` TypeScript loader; your `.ts` file is transpiled on load and executed with the same Node that's running `shardmind`. No separate build step on the shard-author side.

The child process receives:
- `cwd` = `ctx.vaultRoot` (so `git init` / `qmd setup` act on the installed vault).
- The parent's environment, plus:
  - `SHARDMIND_HOOK=1` — tag for "running under shardmind" detection.
  - `SHARDMIND_HOOK_PHASE=post-install` | `post-update` — the lifecycle stage.
- `ctx` (the `HookContext` above) as the single argument to your default export.

### Timeouts

The default hook timeout is **30 seconds**. Override per-shard by adding `hooks.timeout_ms` to `shard.yaml`:

```yaml
hooks:
  post-install: hooks/post-install.ts
  timeout_ms: 60000    # 60 seconds; valid range: 1_000..600_000
```

A hook that exceeds its budget is sent `SIGTERM` (Windows: `TerminateProcess`), given a 2-second grace period to flush buffered output, then hard-killed with `SIGKILL`. The install / update itself still completes — a timed-out hook is a warning, not a rollback trigger.

### Output limits

Each stream (stdout and stderr) is captured up to **256 KB**. Beyond that the capture truncates and appends a `[… truncated, N bytes discarded]` marker. The UI's live "running-hook" view additionally caps the displayed tail at 64 KB so Ink's render buffer can't be wedged by a runaway `console.log` loop.

Ordering is preserved *within* each stream but not *across* stdout and stderr — if you need strict interleaving, funnel everything through one stream in your hook.

### Cancellation

If the user hits Ctrl+C while your hook is running, the child receives a termination signal and the parent exits 130. Install / update are **not** rolled back — state.json is already on disk when the hook fires, so a cancelled hook leaves the vault fully installed but with whatever setup your hook was still doing left incomplete.

On Windows, `SIGTERM` is emulated as `TerminateProcess`, which skips the hook's own cleanup handlers. Treat your hooks as interruptible at any line; don't rely on try/finally running to completion on Windows cancel.

## 7. Testing your shard locally

1. Clone your shard to a directory under your GitHub account.
2. Tag a pre-release: `git tag v0.0.1 && git push --tags`.
3. In an empty directory: `shardmind install github:<user>/<shard> --dry-run`. Fix anything broken.
4. Drop `--dry-run` for a real install. Inspect the resulting vault.
5. Use `scripts/smoke-install.sh` in the shardmind repo as a template for your own smoke harness.
6. Iterate. Tag new versions as you go.

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
