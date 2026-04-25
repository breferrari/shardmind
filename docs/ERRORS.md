# ShardMind error codes

Every `ShardMindError` carries a `code` (the label below), a `message` (what went wrong, with specifics), and a `hint` (what to do about it). This page catalogs every code, grouped by subsystem, with the typical cause and remedy.

If you hit a code not listed here, it's likely a new one — please open an issue so it gets documented.

---

## Registry (resolving a shard reference)

Thrown by `source/core/registry.ts`.

### `REGISTRY_INVALID_REF`

**Meaning:** The shard reference you passed to `shardmind install` doesn't match any accepted pattern.

**Typical cause:** Using uppercase letters, path separators, or forgetting the `namespace/name` form.

**Remedy:** Use `namespace/name`, `namespace/name@version`, or `github:namespace/name[@version]`. Names and namespaces must be lowercase alphanumeric + hyphens.

### `SHARD_NOT_FOUND`

**Meaning:** The shard key isn't present in the registry index.

**Typical cause:** Typo in the namespace or name, or the shard hasn't been registered yet.

**Remedy:** Check spelling, or install via direct mode: `shardmind install github:owner/repo`.

### `VERSION_NOT_FOUND`

**Meaning:** The version you asked for isn't available. For registry mode, the version isn't in the `versions[]` array. For direct mode, the git tag `v<version>` doesn't exist on the repo (HEAD on the tarball URL returns 404).

**Remedy:** Pick an available version (the error message lists them for registry mode), or omit `@version` to use the latest.

### `NO_RELEASES_PUBLISHED`

**Meaning:** Direct-mode `/releases/latest` returned 404 — the upstream repo has no published releases at all. Distinct from `VERSION_NOT_FOUND` (which fires when a specific tag is missing) so `shardmind update` can route on a stable code instead of matching message text.

**Remedy:** Specify a version explicitly with `@version` if one exists, or publish a GitHub release upstream, or reinstall from a different source.

### `REGISTRY_NETWORK`

**Meaning:** A network error talking to the registry or GitHub API.

**Typical cause:** Offline, DNS failure, GitHub status issue, or the registry index JSON is malformed.

**Remedy:** Check your connection; retry. If persistent, use direct mode (`github:owner/repo`) to bypass the registry.

### `REGISTRY_RATE_LIMITED`

**Meaning:** GitHub returned 403 with `x-ratelimit-remaining: 0`.

**Remedy:** Set `GITHUB_TOKEN` in your environment. Unauthenticated GitHub is 60 requests/hour; authenticated is 5000.

---

## Download (fetching + extracting the tarball)

Thrown by `source/core/download.ts`.

### `DOWNLOAD_HTTP_ERROR`

**Meaning:** The HTTP request to fetch the tarball failed, or the server returned a non-2xx status, or the response body was empty.

**Remedy:** Check the tarball URL in the error and your internet connection. For private repos, ensure `GITHUB_TOKEN` has repo access.

### `DOWNLOAD_INVALID_TARBALL`

**Meaning:** The downloaded bytes weren't a valid tar archive.

**Typical cause:** The URL didn't point at a tarball, GitHub served a redirect page, or the archive is corrupted.

**Remedy:** Open the tarball URL in a browser to see what's actually served. Verify the tag exists.

### `DOWNLOAD_MISSING_MANIFEST`

**Meaning:** The extracted tarball has no `shard.yaml` at its root.

**Remedy:** If you're the shard author: add `shard.yaml`. If you're installing: confirm the repo is actually a ShardMind shard.

### `DOWNLOAD_MISSING_SCHEMA`

**Meaning:** The extracted tarball has no `shard-schema.yaml` at its root.

**Remedy:** Same as above.

---

## Manifest (`shard.yaml` parsing)

Thrown by `source/core/manifest.ts`.

### `MANIFEST_NOT_FOUND`

**Meaning:** The file path passed to `parseManifest` doesn't exist.

**Remedy:** Usually an engine-internal error. If you're a shard author running tooling: check the path.

### `MANIFEST_READ_FAILED`

**Meaning:** I/O error reading `shard.yaml` (not ENOENT).

**Remedy:** Check permissions / disk health.

### `MANIFEST_INVALID_YAML`

**Meaning:** `shard.yaml` has a YAML syntax error.

**Remedy:** Fix the YAML. A YAML linter will point at the line.

### `MANIFEST_VALIDATION_FAILED`

**Meaning:** `shard.yaml` parsed as YAML but doesn't match the manifest schema (missing required field, invalid semver, invalid name, etc.).

**Remedy:** Check the error details and consult [`docs/AUTHORING.md`](AUTHORING.md) §3 or [`schemas/shard.schema.json`](../schemas/shard.schema.json).

---

## Schema (`shard-schema.yaml` parsing)

Thrown by `source/core/schema.ts`.

### `SCHEMA_NOT_FOUND`

**Meaning:** `shard-schema.yaml` doesn't exist at the expected path. In runtime context, the cache at `.shardmind/shard-schema.yaml` is missing (vault isn't initialized).

**Remedy:** If installing: the downloaded tarball is missing the file. If in a hook: run `shardmind install` first.

### `SCHEMA_READ_FAILED`

**Meaning:** I/O error reading `shard-schema.yaml`.

**Remedy:** Check permissions / disk.

### `SCHEMA_INVALID_YAML`

**Meaning:** `shard-schema.yaml` has a YAML syntax error.

**Remedy:** Fix the YAML.

### `SCHEMA_VALIDATION_FAILED`

**Meaning:** `shard-schema.yaml` parsed but doesn't match the schema schema. The error message includes the offending path (e.g., `values.user_name.options: Required`).

**Common causes:**
- A value's `group` references a non-existent group
- A `select` or `multiselect` value is missing `options`
- `schema_version` isn't `1`
- A value is missing the required `default` field (v6 contract — every value must declare a `default`; the `default` key must be present, and may hold an empty/falsey literal like `""`, `false`, `0`, or `[]` matching the value's `type`)
- A literal `default` doesn't match the value's `type` (e.g., `type: number, default: "x"`, or `default: null` — null is not a value type and is rejected)
- A `select` `default` is not one of `options[].value` (or `multiselect` default contains values outside the option set)

**Remedy:** Consult [`docs/AUTHORING.md`](AUTHORING.md) §4 or [`schemas/shard-schema.schema.json`](../schemas/shard-schema.schema.json).

### `SCHEMA_RESERVED_NAME`

**Meaning:** A value key in `shard-schema.yaml` collides with the render context: `shard`, `install_date`, `year`, `included_modules`, or `values`.

**Remedy:** Rename the value. These keys are provided by the engine; using them would silently shadow the context at render time.

---

## State (`.shardmind/state.json`)

Thrown by `source/core/state.ts` and `source/runtime/state.ts`.

### `STATE_READ_FAILED`

**Meaning:** Generic I/O failure reading `state.json` (not ENOENT — missing file returns `null`, it doesn't throw).

**Remedy:** Check `.shardmind/` permissions.

### `STATE_CORRUPT`

**Meaning:** `state.json` is not valid JSON, or is missing the `schema_version` field.

**Remedy:** Engine-owned file shouldn't be corrupted by normal use. If you hand-edited it or had a disk event, the simplest fix is `rm -rf .shardmind/` and reinstall (your `shard-values.yaml` is preserved).

### `STATE_UNSUPPORTED_VERSION`

**Meaning:** `state.json` uses a schema version this engine doesn't know how to read, and no migration rule handles the jump.

**Typical cause:** A newer version of shardmind wrote the state, then you downgraded. Or a future version added shape that v0.1 can't read.

**Remedy:** Upgrade shardmind (`npm install -g shardmind@latest`). In v0.2+, migrations will handle forward compatibility.

### `STATE_CACHE_MISSING_TEMPLATES`

**Meaning:** During install, the shard's `templates/` directory wasn't found in the extracted tarball.

**Remedy:** Shard author issue — add a `templates/` directory.

### `VAULT_NOT_FOUND`

**Meaning:** `resolveVaultRoot` (used by hook scripts via `shardmind/runtime`) searched up from `process.cwd()` and found no `.shardmind/` directory.

**Remedy:** Run your script from inside a ShardMind vault. Run `shardmind install` to create one if needed.

---

## Values (`shard-values.yaml`)

### `VALUES_NOT_FOUND`

**Meaning (runtime):** `shard-values.yaml` doesn't exist when a hook tries to load it.

**Remedy:** Run `shardmind install` first.

### `VALUES_READ_FAILED`

**Meaning:** I/O failure reading `shard-values.yaml`.

**Remedy:** Check permissions.

### `VALUES_INVALID`

**Meaning (runtime):** `shard-values.yaml` parsed as YAML but isn't a mapping at the top level.

**Remedy:** Ensure the file is `key: value` entries; not a list, not a scalar.

### `VALUES_FILE_READ_FAILED`

**Meaning:** `--values <file>` pointed at a file that couldn't be read.

**Remedy:** Check the path and permissions.

### `VALUES_FILE_INVALID`

**Meaning:** `--values <file>` is not valid YAML, or not a mapping at the top level.

**Remedy:** Ensure it's `{ key: value }` entries matching your shard's schema value IDs.

### `VALUES_FILE_COLLISION`

**Meaning:** Install tried to write `shard-values.yaml` but the file already exists. The `ExistingInstallGate` normally catches this earlier; this is a last-defense check.

**Remedy:** Move or remove the existing `shard-values.yaml` before re-running `install`. If `.shardmind/state.json` is also present, `shardmind update` is the right command (it'll upgrade the current install in place); without state.json, `update` throws `UPDATE_NO_INSTALL` so `install` is the only path.

### `VALUES_MISSING`

**Meaning:** Running with `--yes` but the `--values` file doesn't include every required value.

**Remedy:** Provide the missing keys in your `--values` file, or drop `--yes` to answer interactively.

---

## Computed defaults

Thrown by `source/core/install-planner.ts:resolveComputedDefaults`.

### `COMPUTED_DEFAULT_FAILED`

**Meaning:** A `{{ expression }}` in `shard-schema.yaml` threw during Nunjucks rendering.

**Remedy:** Shard author issue — check the expression syntax and that every referenced variable exists.

### `COMPUTED_DEFAULT_INVALID`

**Meaning:** The expression rendered, but the output couldn't be coerced into the declared value type (boolean needs `true`/`false`, number needs a finite number, list/multiselect needs a JSON array).

**Remedy:** See [`docs/AUTHORING.md`](AUTHORING.md) §4 for the coercion rules. For arrays, use Nunjucks' `dump` filter: `"{{ ['a', 'b'] | dump }}"`.

---

## Collisions + backups

Thrown by `source/core/install-planner.ts` and `source/core/install-executor.ts`.

### `COLLISION_CHECK_FAILED`

**Meaning:** `fsp.stat` on a planned output path threw something other than ENOENT.

**Remedy:** Usually permissions. Check the file referenced in the error.

### `BACKUP_FAILED`

**Meaning:** `fsp.rename` failed while backing up a colliding path, OR 1000+ backups with the same timestamp already exist (shouldn't happen).

**Remedy:** Check permissions at the path referenced in the error. Clean up stale `*.shardmind-backup-*` backup paths if you somehow have a thousand of them.

---

## Render

Thrown by `source/core/renderer.ts` and wrapped in `source/core/install-executor.ts`.

### `RENDER_FAILED`

**Meaning:** Nunjucks threw while rendering a template. The output path is in the message; the original error is in the hint.

**Typical cause:** `{% ... %}` without matching `{% end... %}`, or a reference to a value that isn't defined.

**Remedy:** Shard author issue. Check the template at the reported path.

### `RENDER_FRONTMATTER_ERROR`

**Meaning:** The frontmatter section of a template rendered, but the result isn't parseable as YAML.

**Typical cause:** Unquoted value with special characters (colons in a string need quoting).

**Remedy:** Wrap the problematic value in quotes in the template.

### `RENDER_TEMPLATE_ERROR`

**Meaning:** Low-level Nunjucks render error (more granular than `RENDER_FAILED` in some paths).

**Remedy:** Same as `RENDER_FAILED`.

### `RENDER_ITERATOR_ERROR`

**Meaning:** A template with `_each` in its name expects a list-typed value in the render context, but `values.<iterator>` isn't an array.

**Remedy:** Ensure the named value in `shard-values.yaml` is a list.

---

## Update / merge

### `MERGE_FAILED`

**Meaning:** The three-way merge engine (`source/core/differ.ts`) threw while applying `node-diff3` to a modified file. Rare — usually a symptom of a file the merge engine can't handle.

**Remedy:** Re-run with `--verbose` for the full trace and file an issue at github.com/breferrari/shardmind/issues. Workaround: delete or rename the file to break it out of the update plan, then re-run `shardmind update`.

### `UPDATE_NO_INSTALL`

**Meaning:** `shardmind update` was invoked in a directory that has no `.shardmind/state.json`.

**Remedy:** Run `shardmind install <shard>` first, then retry.

### `UPDATE_SOURCE_MISMATCH`

**Meaning:** `state.source` in `.shardmind/state.json` doesn't parse as a valid shard reference (`namespace/name` or `github:namespace/name`). Usually a hand-edit or partial corruption of `state.json`.

**Remedy:** Reinstall the shard to regenerate a coherent `state.json`.

### `UPDATE_CACHE_MISSING`

**Meaning:** One of three drift-between-inputs failures during `shardmind update`:

1. The cached schema (`.shardmind/shard-schema.yaml`) is missing or corrupt, so the migration plan can't be computed.
2. Drift reports a file as `modified` but `state.files` doesn't record it — state and drift disagree.
3. A file that was present at drift-detection time vanished before the merge planner reached it (user or another process deleted it mid-update).

**Remedy:** (1) Re-run `shardmind install <source>` to regenerate `.shardmind/`. (2) / (3) Re-run `shardmind update` — drift detection picks up the current shape on the next pass.

### `UPDATE_WRITE_FAILED`

**Meaning:** A write during the update executor failed (mkdir + writeFile on a planned output path). Typically filesystem-level (permissions, disk-full, antivirus lock). May also surface as the code on a wrapped rollback-incomplete error when the update failed AND the snapshot couldn't restore every file.

**Remedy:** Check filesystem permissions on the vault directory and the mentioned path; retry. If partial-rollback also failed, the error message lists paths the snapshot couldn't restore — those files still exist under `.shardmind/backups/update-*/files/`.

### `MIGRATION_INVALID_VERSION`

**Meaning:** `applyMigrations` was handed a `currentVersion` or `targetVersion` that doesn't parse as semver.

**Remedy:** Engine bug — open an issue. Both versions come from parsed `state.json` or fresh `shard.yaml` and should always be valid semver.

### `MIGRATION_TRANSFORM_FAILED`

**Meaning:** Reserved for the v0.2 sandboxed-transform path. Currently `migrator.ts` catches `type_changed` transform exceptions and records a warning (best-effort posture), so this code is declared but not thrown in v0.1.

**Remedy:** N/A in v0.1. When the sandboxed evaluator lands (v0.2), this code will surface if a transform crashes and the command layer will distinguish it from "transform returned the wrong shape."

## Update-check cache (status + update)

### `UPDATE_CHECK_FAILED`

**Meaning:** Internal — the 4-second fetch budget for the background "what's the latest version?" lookup expired. Surfaced only from paths that treat update-check as fatal; the status command maps it to an `unknown` update result.

**Remedy:** Usually transient network pressure. The cache (when present) still answers subsequent runs; re-try later.

### `UPDATE_CHECK_CACHE_CORRUPT`

**Meaning:** The cached `.shardmind/update-check.json` couldn't be parsed or was the wrong shape. The cache is self-healed on sight (deleted + re-fetched) and the verbose status surfaces this once as an info warning.

**Remedy:** Automatic. No user action needed.

---

## Maintenance

If you're a shard author and hit a code that feels authoring-side, the specifically author-facing ones are:
- `SCHEMA_RESERVED_NAME`, `SCHEMA_VALIDATION_FAILED`
- `COMPUTED_DEFAULT_FAILED`, `COMPUTED_DEFAULT_INVALID`
- `RENDER_FAILED`, `RENDER_FRONTMATTER_ERROR`, `RENDER_ITERATOR_ERROR`
- `DOWNLOAD_MISSING_MANIFEST`, `DOWNLOAD_MISSING_SCHEMA`

If you're an end user, the most common ones you'll see are:
- `SHARD_NOT_FOUND`, `VERSION_NOT_FOUND`, `REGISTRY_NETWORK`
- `VALUES_MISSING`, `VALUES_FILE_COLLISION`
- `VAULT_NOT_FOUND` (if running a hook script outside a vault)

Engine-internal codes (`STATE_*`, `BACKUP_FAILED`, `COLLISION_CHECK_FAILED`) shouldn't happen in normal use; open an issue if you hit one.
