# Authoring a ShardMind shard

This guide walks through every file and concept a shard author needs. Read [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) first if you want the "why"; this document covers the "how".

## 1. What is a shard

A shard is a git repository that ShardMind installs into a user's vault. It ships four things:

1. **Templates** (`templates/`) — Nunjucks-rendered markdown, config, and settings files.
2. **Declarations** (`shard.yaml`, `shard-schema.yaml`) — identity, values, modules, signals.
3. **Resources** (`scripts/`, `utilities/`, `skills/`, `codex/`, `commands/`, `agents/`) — copied verbatim.
4. **Hooks** (`hooks/*.ts`, optional) — post-install / post-update lifecycle scripts.

Users run `shardmind install <namespace>/<shard>`. The engine downloads the tarball, prompts for values, lets the user opt out of removable modules, renders templates, writes state, and runs your hook. Users never edit your shard directly — they edit their vault, and the next `shardmind update` merges upstream changes into their customizations via three-way merge.

## 2. File layout

```
your-shard/
├── shard.yaml              # manifest — who you are
├── shard-schema.yaml       # schema — questions, modules, signals
├── templates/              # Nunjucks templates, rendered into the vault
│   ├── Home.md.njk
│   ├── CLAUDE.md.njk
│   └── brain/
│       └── North Star.md.njk
├── commands/               # Claude Code command files (copied verbatim)
│   └── reflect.md
├── agents/                 # Claude Code agent files (copied verbatim)
├── scripts/                # Utility scripts
├── utilities/              # Utility modules
├── skills/                 # Skills
├── codex/                  # Codex prompts → .codex/prompts/
├── hooks/                  # Lifecycle hooks
│   └── post-install.ts
└── README.md
```

Minimum: `shard.yaml`, `shard-schema.yaml`, and `templates/`. Everything else is optional.

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
  node: ">=18.0.0"

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
    partials: ["claude/_extras.md.njk"]
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

A module owns:
- `paths` — template directory prefixes (any `.njk` under `brain/` belongs to the `brain` module)
- `partials` — specific partial templates gated by this module
- `commands` — command file basenames (from your `commands/`) gated here
- `agents` — agent file basenames
- `bases` — base template IDs

Files under `scripts/`, `utilities/`, `skills/`, `codex/` are always copied regardless of module selection — these are framework-level.

### `signals` — LLM routing hints

Declarative "when to route where". Surfaced to agents via `shardmind/runtime`. `core: true` means always active; `module: <id>` gates on a module being included.

### `frontmatter` — per-note-type rules

Shorthand `key: [a, b]` expands to `key: { required: [a, b] }`. Optional `path_match` applies the rule only to matching paths. `global` is the catch-all.

### `migrations` — value migrations

Ordered rules applied to `shard-values.yaml` when the shard version moves forward. Four change types: `rename`, `added`, `removed`, `type_changed`. See `MigrationChange` in `source/runtime/types.ts` for the exact shape.

## 5. Templates

Files under `templates/` use [Nunjucks](https://mozilla.github.io/nunjucks/). Engine settings:

- `autoescape: false` (you're rendering Markdown, not HTML)
- `trimBlocks: true` / `lstripBlocks: true` (tidy output around `{% ... %}` tags)

### Naming

- `.njk` suffix → template, rendered; suffix is stripped. `Home.md.njk` → `Home.md`.
- No `.njk` → copy verbatim to the same relative path.
- `settings.json.njk` is the special-cased rename to `.claude/settings.json`.

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
  // ctx.vaultRoot       — absolute path to the installed vault
  // ctx.values          — the answered values
  // ctx.modules         — { moduleId: 'included' | 'excluded' }
  // ctx.shard           — { name, version }
  // ctx.previousVersion — only set on post-update
}
```

### Capabilities

Hooks **can**:
- Read / write files anywhere in `vaultRoot`
- Run shell commands (`git init`, `qmd setup`, etc.)
- Log to stdout (captured and surfaced in the install summary)
- Import `shardmind/runtime` for helpers (`loadValues`, `loadState`, `validateFrontmatter`)

Hooks **cannot**:
- Modify `.shardmind/` (engine-owned)
- Modify `shard-values.yaml` (user-owned)
- Affect the install/update flow by throwing — exceptions become warnings, not fatal errors

### Runtime status

As of v0.1, the engine **detects** hook files but **does not execute them** yet. Execution is tracked in [#30](https://github.com/breferrari/shardmind/issues/30) and lands before Milestone 5 (obsidian-mind conversion). The contract above is stable; a `post-install.ts` written today will run unchanged when the runtime ships.

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
- [ ] Hook scripts either work or are clearly scoped "coming soon" (hook execution is deferred in v0.1)
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
