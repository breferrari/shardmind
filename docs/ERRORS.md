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

**Remedy:** Check spelling, or run the command the hint gives, which takes the shard straight from GitHub: `shardmind install github:owner/repo`.

### `VERSION_NOT_FOUND`

**Meaning:** The version you asked for isn't available: the git tag `v<version>` doesn't exist on the shard's repo (HEAD on the tarball URL returns 404). A bare `owner/repo` and `github:owner/repo` fail alike, because the registry only names the repo and versions are its releases.

**Remedy:** Pick a version the repo has released, or omit `@version` to use the latest. On `shardmind update`, pin a known-good tag with `--release <version>`.

### `NO_RELEASES_PUBLISHED`

**Meaning:** GitHub's `/releases?per_page=100` returned no entries that match the prerelease policy. Two sub-cases distinguished by the hint:

- **Empty release list:** the upstream repo has zero releases. The hint suggests `@version` (if a tag exists), publishing a release, or reinstalling from a different source.
- **Only prereleases exist:** every entry in the listing has `prerelease: true` and the default-stable filter eliminated all of them. The hint suggests `--include-prerelease`.

**Remedy:** Match the hint. For ref-installed vaults this code can't fire (ref installs use `/commits/<ref>`, not `/releases`).

### `REF_NOT_FOUND`

**Meaning:** The branch / tag / SHA passed via `github:owner/repo#<ref>` (or recorded in `state.ref` for an existing ref-installed vault) couldn't be resolved. Three sub-cases:

- 404 on `/commits/<ref>` — no branch / tag / commit by that name.
- 422 on `/commits/<ref>` — a SHA prefix matched multiple commits (ambiguous).
- HEAD on `/tarball/<sha>` 404'd after a successful commit resolution — typically a force-push that orphaned the commit between the two API calls.

**Remedy:** Match the hint. For ambiguous SHAs, lengthen the prefix or use the full 40-char SHA. For deleted refs in an existing vault, reinstall via `shardmind install <source>#<new-ref>` to repoint, or via `shardmind install <source>@<version>` to switch to a tag pin.

### `REGISTRY_NETWORK`

**Meaning:** A network error talking to the registry or GitHub API.

**Typical cause:** Offline, DNS failure, GitHub status issue, or the registry index JSON is malformed.

**Remedy:** Check your connection; retry. If the registry index is what failed, run the command the hint gives: the same shard straight from GitHub, `shardmind install github:owner/repo`.

### `REGISTRY_INDEX_UNSUPPORTED`

**Meaning:** The registry index is in a newer format (`schema_version`) than this shardmind reads.

**Typical cause:** The registry moved to a new index format after this shardmind was released.

**Remedy:** Update shardmind: `npm install -g shardmind@latest`. Or run the command the hint gives, which takes the shard straight from GitHub and does not read the index: `shardmind install github:owner/repo`.

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

**Typical cause:** The URL didn't point at a tarball, GitHub served a redirect page, or the archive is corrupted. Also raised for an entry whose declared size is not a number (#32), which only a malformed or crafted archive has.

**Remedy:** Open the tarball URL in a browser to see what's actually served. Verify the tag exists.

### `SHARD_TOO_LARGE`

**Meaning:** The shard's tarball would extract to more than the size or entry-count limit, so extraction stopped before writing past it and the temporary folder was removed. The message names the limit that tripped. The limits count what the archive's entries declare, which is what extraction writes, so a small, highly compressed archive (a decompression bomb) trips them too.

**Limits:** 256 MiB of extracted bytes and 100,000 entries by default. For scale, obsidian-mind (v9.0.0) extracts to about 6.9 MB in 318 entries (measured 2026-10-04), so the defaults leave about 37x and 300x headroom.

**Remedy:** If you trust a shard that is legitimately this large, raise the limit for that run with `SHARDMIND_MAX_SHARD_SIZE` (bytes, or with a `K`/`M`/`G` suffix, e.g. `1G`) or `SHARDMIND_MAX_SHARD_ENTRIES`. Otherwise, do not install it.

### `DOWNLOAD_LIMIT_INVALID`

**Meaning:** `SHARDMIND_MAX_SHARD_SIZE` or `SHARDMIND_MAX_SHARD_ENTRIES` is set to something that is not a positive whole number (with an optional `K`/`M`/`G` suffix for the size). It is refused rather than ignored, so a typo never silently removes or changes a limit. A variable set to an empty string counts as invalid: unset it instead.

**Remedy:** Fix or unset the variable.

### `VALIDATE_TARGET_INVALID`

**Meaning:** `shardmind validate` was given a path that is a file, or a path that does not exist, or `--values` with no file. A target spelled as a path (`./shard`, `/abs/path`, `..\\x`) is never looked up as a shard reference, so a typo gets this error instead of a registry lookup.

**Remedy:** Pass the shard's folder (the one holding `.shardmind/shard.yaml`), or a reference such as `github:owner/repo#branch`.

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

### `HOOK_SLOT_CONFLICT`

**Meaning:** `shard.yaml` declares the deprecated `hooks.post-install` slot *together with* `hooks.bootstrap` or `hooks.personalize`. The legacy combined hook and the new named slots are mutually exclusive — a manifest carrying both is a half-finished migration, not a valid configuration.

**Typical cause:** Adding `bootstrap`/`personalize` while leaving the old `post-install` line in place.

**Remedy:** Remove `hooks.post-install` once you've split it into `bootstrap` (unmanaged setup) + `personalize` (managed edits). See [`docs/AUTHORING.md §6`](AUTHORING.md) for the worked migration.

### `SHARDMIND_VERSION_MISMATCH`

**Meaning:** The shard declares `requires.shardmind` (a semver range the engine must satisfy) and the ShardMind engine you're running is too old. Install, update, and adopt all check this immediately after parsing `shard.yaml`, before any vault write — so a refused command leaves the vault untouched.

**Typical cause:** Installing a shard built against a newer engine feature (e.g. the post-#102 hook lifecycle) with an older globally-installed `shardmind`.

**Remedy:** Upgrade the engine — `npm i -g shardmind@latest` — then retry. (Shard authors: the range lives at `requires.shardmind`; absent means no check. See [`docs/AUTHORING.md §3`](AUTHORING.md).)

### `EXTERNAL_TOOL_UNMET`

**Meaning:** The shard declares a command-line tool it needs (`external_tools` in `shard.yaml`), and a required one is missing or outside its version range. Install, adopt, and an update that installs a new version run each declared tool's version command after the values are final and before any vault write, so a refused command leaves the vault untouched. The message names every unmet tool and why: not found on `PATH`, exited non-zero, timed out, printed no version, or the version found and the range it misses (#138). Optional tools that are unmet are listed too, but do not cause the refusal on their own.

**Typical cause:** A tool installed long ago and never updated, or one never installed on this machine.

**Remedy:** Run the install command in the hint, `npm i -g <package>@"<range>"`, which installs a version inside the range the shard declares, then retry. If the shard gates the tool on a value (`when:`), turning that value off skips the check. Shard authors: see [`SHARD-LAYOUT.md §External tools`](SHARD-LAYOUT.md#external-tools).

### `EXTERNAL_TOOL_WHEN_INVALID`

**Meaning:** A tool in `external_tools` has a `when:` key that does not name a `boolean` value in `shard-schema.yaml`. `shardmind validate` reports it as an error, and install refuses with `INSTALL_SHARD_INVALID` listing it (#138).

**Remedy:** Shard author: point `when:` at a boolean value the schema declares, or remove it to check the tool on every install.

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
- A `multiselect` declares both a per-option `default: true` and a top-level `default` (ambiguous — pick one)
- A per-option `default` appears on a non-`multiselect` value (per-option `default` is multiselect-only; a `select` declares its default via the value's top-level `default`)
- A `multiselect` default selects fewer than `min` or more than `max`, or `min` exceeds the option count (a `--defaults` install must produce a valid vault, so an unsatisfiable constraint or out-of-range default is rejected at parse)
- A `multiselect` `min`/`max` is fractional or negative (they bound the selected count, so must be non-negative integers — unlike `number`-type `min`/`max`)

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

### `STATE_CACHE_MISSING_MANIFEST`

**Meaning:** While caching the shard source as the merge base (install, update or adopt), `.shardmind/shard.yaml` wasn't found in the extracted shard. Replaces the pre-v6 `STATE_CACHE_MISSING_TEMPLATES`; there is no top-level `templates/` directory any more.

**Remedy:** Shard author issue — commit `.shardmind/shard.yaml` at the shard root (see [`SHARD-LAYOUT.md`](SHARD-LAYOUT.md)). Normally `DOWNLOAD_MISSING_MANIFEST` catches this first.

### `VAULT_NOT_FOUND`

**Meaning:** `resolveVaultRoot` (used by hook scripts via `shardmind/runtime`) searched up from `process.cwd()` and found no `.shardmind/` directory.

**Remedy:** Run your script from inside a ShardMind vault. Run `shardmind install` to create one if needed.

### `VAULT_PATH_UNSAFE`

**Meaning:** A path that `install`, `update` or `adopt` would write or delete is not a plain file or folder inside the vault, so writing through it could change something outside the vault or somewhere other than the path recorded (#163). The engine checks every path before it touches any, and refuses the whole run, dry runs included. The message lists each path with its reason:

- `symlink`: the path is a symbolic link, dangling or not. Writing would follow it.
- `symlinked-folder`: a folder on the way to the path is a symbolic link, so the write would land wherever it points.
- `hard-link`: the file has another hard link, so rewriting it in place would change the other copy too.
- `case-mismatch`: on a case-folding filesystem (macOS, Windows), a folder or file exists only under a different case, so the write would land in it while the engine recorded the shard's casing. An update that renames a file by case alone (#169) is not refused for that file's own two spellings.

**Remedy:** Replace the link with a regular file or folder (copy its content in), remove it, or rename the folder to the shard's casing, then run the command again.

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

**Meaning:** A non-interactive run couldn't supply every required value. Two ways to get here: `--yes`, where a required value has no usable default; or a headless `--values` run whose file is incomplete.

**Remedy:** Provide the missing keys in your `--values` file. Under `--yes` you can instead drop the flag to answer interactively — that is not an option in a headless run, so the hint adapts to which case you hit.

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

**Meaning:** A vault path the command would touch could not be inspected: `fsp.stat` on a planned install output, or the `lstat` / folder listing the vault path guard runs before install, update and adopt (#163), threw something other than "not found". A folder that cannot be listed only skips the case check; this code is for a path that cannot be looked at at all.

**Remedy:** Usually permissions, or a file held by another program (antivirus, a sync client). Check the path in the error, then run the command again.

### `BACKUP_FAILED`

**Meaning:** `fsp.rename` failed while moving a colliding path aside, OR 1000+ backups with the same timestamp already exist (shouldn't happen). The install's rollback puts the earlier moves back; if it cannot, the install fails with `ROLLBACK_INCOMPLETE` instead, naming where each one still is (#301).

**Remedy:** Check permissions at the path referenced in the error. Clean up stale `*.shardmind-backup-*` backup paths if you somehow have a thousand of them.

### `INSTALL_WRITE_FAILED`

**Meaning:** A write during the install executor failed: the `mkdir` and write of a planned output, or the `shard-values.yaml` write (#301). Typically filesystem-level (permissions, a full disk, an antivirus lock). Also thrown before the write when a file appeared at a planned output after the install was planned: the install moved the paths it planned to replace out of the way, and would otherwise overwrite one it never saw. Nothing is overwritten, and the install rolls back. When the rollback could not restore every file, the install fails with `ROLLBACK_INCOMPLETE` instead, naming this code in its message (#247).

**Remedy:** For a file that appeared after planning, run `shardmind install` again: it plans around the file, and offers to back it up. Otherwise check permissions on the vault directory and the mentioned path, and retry. When the cause is an environmental errno (a full disk, a locked or read-only file, a permission refusal), the hint is that errno's own ("The disk is full…", #225), and the errno is kept as the error's `cause`.

### `CANCELLED`

**Meaning:** An install, update or adopt was cancelled with Ctrl+C while it was writing (#249). Thrown by `throwIfCancelled` in `source/core/run-cancel.ts`, which each executor calls before every write, so the run stops between two writes and is then rolled back once. The process exits 130.

**Remedy:** None needed: the vault is as it was before the run. If the rollback could not put everything back, the list printed on exit names what is left (`ROLLBACK_INCOMPLETE`). A Ctrl+C after the run's last check, just before `state.json`, lets it finish instead, and the exit says so.

### `ROLLBACK_INCOMPLETE`

**Meaning:** An install, update or adopt failed, and rolling it back could not put every file back (#247). Thrown by `source/core/rollback-report.ts` for all three commands. The message starts with the original failure and its code, then lists each path the rollback could not restore or remove, with the reason and, when there is one, where that file's backup is: a `*.shardmind-backup-*` path for install, a file under `.shardmind/backups/update-*/` or `.shardmind/backups/adopt-*/files/` for update and adopt. The adopt snapshot is kept when a restore from it failed. The exit code is 1, and `--json` carries the same message.

A Ctrl+C rollback that could not restore everything prints the same list to stderr and still exits 130.

**Remedy:** Fix what the reason names (usually permissions, or a file held by another program), then copy each listed backup back to its path by hand before running shardmind again.

---

## Arguments

### `ARGS_INVALID`

**Meaning:** A `--json` run that runs without the terminal UI (§4.29 in IMPLEMENTATION.md: the status command, then adopt and update) was given arguments its command does not accept: an unknown flag, a flag without its value, a value outside a flag's choices, or a missing argument (#302). The message is the one the same command prints without `--json`. The run writes this as its failure document and exits 1.

**Remedy:** Fix the arguments; `shardmind <command> --help` lists them.

## Install command flags

Thrown by `source/commands/hooks/use-install-machine.ts` during boot-time pre-flight, before any network call.

### `INSTALL_FLAG_CONFLICT`

**Meaning:** Two install flags would resolve through different policies and the engine refuses to silently pick one. Currently rejected: `--defaults` + `--values <file>` — `--defaults` uses schema defaults for every value; `--values` would override them.

**Remedy:** Drop one of the two flags. Use `--values` for non-default scripted installs; use `--defaults` for the deterministic Invariant 1 mode.

### `INSTALL_DEFAULTS_OVER_EXISTING`

**Meaning:** `shardmind install --defaults` was invoked in a directory that already contains `.shardmind/state.json`. `--defaults` is the deterministic CI / non-TTY mode; the existing-install gate requires interactive input it can't provide, so the engine errors before any network call.

**Remedy:** Run `shardmind update` to upgrade the existing install in place, or add `--force` to reinstall from scratch (#55). `--force` answers the gate with Reinstall and replaces your files at the shard's paths without a backup; the old install is kept until the new one succeeds, and restored if it fails.

### `INSTALL_DESTINATION_NOT_EMPTY`

**Meaning:** `shardmind install <shard> [folder]` installs into a new folder named after the shard, or `[folder]` (#333). That folder already exists and is not empty, or a file sits at its path or at one of its parent levels. Refused before any download or prompt: installing a vault over an unrelated folder's content is never what the default meant. Also raised at write time when the folder appeared after the install planned (another run took the name).

**Remedy:** Give another folder name as the second argument (`shardmind install <shard> my-vault`). To install into that folder as it is, `cd` into it and run `shardmind install <shard> .`, which keeps the in-place behaviour, collision review included; `.` names the current folder, so running it from the parent would install there. If the folder is already a shardmind vault, `shardmind update` inside it upgrades it. Also raised when the destination's drive or share does not exist.

### `INSTALL_INSIDE_VAULT`

**Meaning:** `shardmind install <shard>` with no folder argument installs into a new folder named after the shard (#333). It was run from inside an existing vault: the current folder, or a folder above it, holds `.shardmind/state.json` (a shardmind vault) or `.obsidian/` (an Obsidian vault). A second vault nested inside the first is almost never what was meant (#337). Refused before any download or prompt; the message names the vault found.

**Remedy:** To install into a new folder anyway, name it: `shardmind install <shard> my-vault` (a folder argument skips the check). To install into the current folder in place, as before #333, use `.`: `shardmind install <shard> .`, which keeps the existing-install gate and collision review. To upgrade the vault you are in, run `shardmind update`.

### `JSON_REQUIRES_DRY_RUN`

**Meaning:** `--json` was passed without `--dry-run` on `adopt` or `update`. The JSON surface is currently the **plan** surface: the document is emitted at the dry-run decision point, before any conflict prompt. A decision the dry run itself would ask about fails with `UPDATE_JSON_NEEDS_ANSWERS` on update and `ADOPT_NON_INTERACTIVE_WITHOUT_VALUES` on adopt.

Allowing it on a real run would render no UI (the command renders nothing under `--json`) and emit no document, so the process would sit at a prompt nobody can answer and exit 0 — a silent no-op reporting success. The engine refuses instead.

**Remedy:** Add `--dry-run` to get the machine-readable plan, or drop `--json` to execute with the normal interface.

### `INSTALL_NON_INTERACTIVE_WITHOUT_VALUES`

**Meaning:** `shardmind install` ran without an interactive terminal (piped stdin, CI, an agent harness) and without any way to answer the wizard. There is nothing to prompt with, and nothing to prompt from.

The engine refuses rather than falling back to schema defaults, because a silently-defaulted install records values nobody chose — `user_name: ""` lands in `shard-values.yaml` looking exactly like a deliberate answer.

**Remedy:** Pass `--values <file>` to supply answers, or `--yes` / `--defaults` to accept schema defaults deliberately. `--values` alone is sufficient without a TTY: the answers are already on disk, so the wizard is skipped rather than rendered.

### `ADOPT_NON_INTERACTIVE_WITHOUT_VALUES`

**Meaning:** `shardmind adopt` ran without an interactive terminal and without `--values`. Same rule as `INSTALL_NON_INTERACTIVE_WITHOUT_VALUES`: the engine refuses rather than recording schema defaults nobody chose over a vault that already has real content.

**Remedy:** Pass `--values <file>` to supply answers, or `--yes` to accept schema defaults deliberately. `--values` alone is sufficient without a TTY.

### `INSTALL_SHARD_INVALID`

**Meaning:** Before asking anything, install checks the downloaded shard the way `shardmind validate` does: every module included, every template rendered with the schema defaults, or with your `--values` over them (a `--values` answer the schema rejects is left to the wizard, and the shard is checked with the defaults instead). At least one check failed, so the install stopped before the wizard and before any write to the vault. The message lists every problem with its code and the file it is about. A template that fails here is a bug in the shard, even when it sits in a module you meant to leave out.

**Remedy:** Shard author: run `shardmind validate` on the shard (with the same `--values` file, if one was passed) and fix what it reports. User: a template that fails only with your `--values` answers is still the shard's to fix, since the schema accepted them; report the problem to the shard's author, or install an earlier version of the shard (`owner/repo@<version>`).

### `INSTALL_GATE_NON_INTERACTIVE`

**Meaning:** The target directory is already shardmind-managed, so the install needs an answer from the existing-install gate, and there is no interactive terminal to ask for one. `--yes` does **not** answer this gate — overwriting a managed vault is not a default the engine assumes on your behalf.

**Remedy:** Run `shardmind update` to upgrade the existing install in place, or add `--force` to reinstall from scratch (#55). `--force` answers the gate with Reinstall and replaces your files at the shard's paths without a backup; the old install is kept until the new one succeeds, and restored if it fails.

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

### `RENDER_ITERATOR_NAME_CLASH`

**Meaning:** Two items of an `_each` template's list name the same file: identical, differing only in case, or equal after sanitizing (`Bob/Ops` and `Bob-Ops`). The second would overwrite the first, and on a case-insensitive filesystem the vault would track two names for one file. Refused before anything is written, in install, update and adopt (#234).

**Remedy:** Give each item a name that differs by more than case or by characters a file name cannot hold, or a `slug` or `name` if it has neither. The list is usually the user's own: a `list` value typed at the wizard, or `values.<key>` in `shard-values.yaml`. The message names the value, both items and the file. A vault installed before #234 with such a list can't update until `shard-values.yaml` is fixed.


### `OUTPUT_PATH_CLASH`

**Meaning:** Two shard outputs name the same vault file, identically or differing only in case or Unicode form: a static file and a template, two templates, or an `_each` expansion and either (#240). One write would overwrite the other, and on macOS or Windows the vault would track two names for one file. Refused before anything is written, by install, update and adopt; `shardmind validate` reports it before any user installs. The message names both sources.

**Remedy:** Rename one of the two files in the shard, or (for an `_each` expansion) the list item the file is named after.

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

### `UPDATE_FLAG_CONFLICT`

**Meaning:** Two or more update flags / states would resolve through different policies. Three rejected combinations:

- `--release <v>` + `--include-prerelease` — `--release` already pins a specific tag; the widen flag can't change which tag is picked.
- `--release <v>` on a ref-installed vault (`state.ref` set) — the vault tracks a moving ref by definition; pinning a tag silently abandons that policy.
- `--include-prerelease` on a ref-installed vault — the widen flag tunes `/releases` filtering, which ref installs don't use (they re-resolve `/commits/<ref>` instead).

**Remedy:** Drop the conflicting flag. To switch a ref-installed vault to a tag pin, reinstall via `shardmind install <source>@<version>` (the explicit transition).

### `UPDATE_JSON_NEEDS_ANSWERS`

**Meaning:** `shardmind update --dry-run --json` reached decisions the update would ask you about, and `--json` cannot ask. The message names every pending decision, with every path (a JSON document is never capped) (#230):

- **new optional modules**: the new version adds a removable module your install has never chosen;
- **removed files you edited**: the new version drops files you modified;
- **new required values**: the new schema requires values your `shard-values.yaml` lacks. Every value declares a default today, so this is unreachable with a valid schema.

The run writes this as its one JSON failure document and exits 1, instead of writing nothing.

**Remedy:** Add `--yes`, which includes new optional modules and keeps removed files you edited. For new required values, add them to `shard-values.yaml`; `--yes` cannot supply them either (`VALUES_MISSING`). Or run without `--json` to choose interactively.

### `UPDATE_CACHE_MISSING`

**Meaning:** One of three drift-between-inputs failures during `shardmind update`:

1. The cached schema (`.shardmind/shard-schema.yaml`) is missing or corrupt, so the migration plan can't be computed.
2. Drift reports a file as `modified` but `state.files` doesn't record it — state and drift disagree.
3. A file that was present at drift-detection time vanished before the merge planner reached it (user or another process deleted it mid-update).

**Remedy:** (1) Re-run `shardmind install <source>` to regenerate `.shardmind/`. (2) / (3) Re-run `shardmind update` — drift detection picks up the current shape on the next pass.

### `UPDATE_WRITE_FAILED`

**Meaning:** A write during the update executor failed (mkdir + writeFile on a planned output path). Typically filesystem-level (permissions, disk-full, antivirus lock). When the rollback that follows could not restore every file, the update fails with `ROLLBACK_INCOMPLETE` instead, naming this code in its message (#247). Also thrown before any write when the run's snapshot folder under `.shardmind/backups/` cannot be created: the folder isn't writable, or a thousand `update-<timestamp>` names are already taken (#248). Nothing was snapshotted or written then, and no folder made on the way is left (#269); clean up old `update-*` folders or fix the permissions and retry. Also thrown, before anything is snapshotted or written, as the `Missing update resolution for <path>` invariant assertion when a conflict reaches the executor without a decision (#292).

**Remedy:** Check filesystem permissions on the vault directory and the mentioned path; retry. A rollback that could not restore everything is `ROLLBACK_INCOMPLETE`. When the cause is an environmental errno (a full disk, a locked or read-only file, a permission refusal), the hint is that errno's own ("The disk is full…", #225), and the errno is kept as the error's `cause` (#313). For the missing-resolution case, that's a state-machine bug — open an issue.

### `MIGRATION_INVALID_VERSION`

**Meaning:** `applyMigrations` was handed a `currentVersion` or `targetVersion` that doesn't parse as semver.

**Remedy:** Engine bug — open an issue. Both versions come from parsed `state.json` or fresh `shard.yaml` and should always be valid semver.

### `MIGRATION_TRANSFORM_FAILED`

**Meaning:** Reserved for the v0.2 sandboxed-transform path. Currently `migrator.ts` catches `type_changed` transform exceptions and records a warning (best-effort posture), so this code is declared but not thrown in v0.1.

**Remedy:** N/A in v0.1. When the sandboxed evaluator lands (v0.2), this code will surface if a transform crashes and the command layer will distinguish it from "transform returned the wrong shape."

## Adopt

Thrown by `source/core/adopt-executor.ts` (and surfaced through `source/commands/hooks/use-adopt-machine.ts`).

### `ADOPT_FROM_VERSION_INVALID`

**Meaning:** `shardmind adopt --from-version <v>` was given a `<v>` that is not a semver version (#179). The flag names the release the vault was cloned from, so the engine can apply the shard's rename migrations since then.

**Remedy:** Pass the version as `MAJOR.MINOR.PATCH` (e.g. `--from-version 5.1.0`), the one in the cloned repo's `shard.yaml` or its release tag without the `v`. Omit the flag if the clone already uses the shard's current paths.

### `ADOPT_EXISTING_INSTALL`

**Meaning:** `shardmind adopt` was invoked in a directory that already contains `.shardmind/state.json`. Adopt is for un-managed vaults (typically pre-shardmind clones); a managed vault routes through `shardmind update` instead.

**Remedy:** Use `shardmind update` to upgrade an existing install. To force re-adoption, remove `.shardmind/state.json` (and `shard-values.yaml`) first — note that this discards the existing merge-base cache, so subsequent updates will see the user's current bytes as the new base.

### `ADOPT_WRITE_FAILED`

**Meaning:** A write during the adopt executor failed (mkdir + writeFile on a planned output, or the `shard-values.yaml` write at finish). Surfaces both for engine-side write failures and for the `Missing adopt resolution for <path>` invariant assertion when a `differs` classification reaches the executor without a `keep_mine` / `use_shard` decision. Also thrown before any write when the run's snapshot folder under `.shardmind/backups/` cannot be created: the folder isn't writable, or a thousand `adopt-<timestamp>` names are already taken (#248). Nothing was snapshotted or written then, and no folder made on the way is left (#269); clean up old `adopt-*` folders or fix the permissions and retry.

**Remedy:** For filesystem-level failures, check permissions on the vault directory and the mentioned path. When the cause is an environmental errno (a full disk, a locked or read-only file, a permission refusal), the hint is that errno's own ("The disk is full…", #225), and the errno is kept as the error's `cause` (#313). The snapshot-rollback restored any user content the executor had snapshotted before the failure; newly-written shard-only files were erased. If it could not restore a file, the adopt fails with `ROLLBACK_INCOMPLETE` instead (#247). For the missing-resolution case, that's a state-machine bug — open an issue.

`VALUES_FILE_COLLISION` is also reachable from adopt: a vault containing `shard-values.yaml` without `.shardmind/state.json` is a partial-adoption inconsistent state. The hint asks the user to move the stray file aside before re-running.

## Vault lock

### `VAULT_LOCKED`

**Meaning:** Another shardmind run (`install`, `update` or `adopt`) is working on this vault, and holds `.shardmind.lock` at the vault root (#253). Two runs at once would overwrite each other's state and undo each other's work, so the second is refused. The message names the command, its PID and when it started. It is also raised when the lock file can't be read, or comes from another computer (a synced vault). An empty lock gets its own message, "An empty .shardmind.lock was left by a crashed run; delete it if no shardmind is running": a run writes its lock in an instant, so an empty one is a run killed between creating and writing it, and it is never taken over automatically.

**Remedy:** Wait for the other run to finish, then run again. If no shardmind process is running (it crashed or was killed on another computer, or the lock file was committed or synced into the vault), `.shardmind.lock`, and `.shardmind.lock.takeover` if it is there, are safe to delete. A stale lock left on this computer by a run that is no longer alive is taken over automatically.

## Walk + `.shardmindignore`

Thrown by `source/core/modules.ts::walkShardSource` and `source/core/shardmindignore.ts::loadShardmindignore` during the install / update walk over the extracted shard. Pre-write — these never leave a partial vault behind because they fire before any `runInstall` / `runUpdate` mutation. On install, the pre-install check (#35) walks first, so one of these arrives as a line in `INSTALL_SHARD_INVALID`'s list, with its own code.

### `WALK_SYMLINK_REJECTED`

**Meaning:** The walker found a symbolic link inside the shard source. Symlinks anywhere in a shard are a Tier 1 exclusion per [`docs/SHARD-LAYOUT.md §File disposition`](SHARD-LAYOUT.md) — security baseline, an untrusted shard could symlink outside the install target. The error names the offending path.

**Remedy:** Shard authors: replace the symlink with a regular file or remove the entry. End users: report the issue to the shard author; do not attempt to install a shard that ships symlinks.

### `WALK_INVALID_ENTRY`

**Meaning:** The walker hit a directory entry that isn't a regular file, directory, or symbolic link (sockets, FIFOs, block / character devices). Same Tier 1 boundary as symlinks: shards must ship structured-content files only.

**Remedy:** Same as `WALK_SYMLINK_REJECTED` — the shard source is malformed; remove the offending entry or report upstream.

### `SHARDMINDIGNORE_READ_FAILED`

**Meaning:** Reading the shard-root `.shardmindignore` failed for a reason other than "file is absent" (ENOENT is silently treated as an empty ignore set, which is the default). Typically a permissions or I/O error.

**Remedy:** Check filesystem permissions on the shard's extracted temp directory; re-run the install. Persistent failures are usually a corrupt download — clearing `.shardmind/templates/` (for installed vaults) and re-running update forces a fresh fetch.

## Update-check cache (status + update)

### `UPDATE_CHECK_FAILED`

**Meaning:** Internal — the 4-second fetch budget for the background "what's the latest version?" lookup expired. Surfaced only from paths that treat update-check as fatal; the status command maps it to an `unknown` update result.

**Remedy:** Usually transient network pressure. The cache (when present) still answers subsequent runs; re-try later.

### `UPDATE_CHECK_CACHE_CORRUPT`

**Meaning:** The cached `.shardmind/update-check.json` couldn't be parsed or was the wrong shape. The cache is self-healed on sight (deleted + re-fetched) and the verbose status surfaces this once as an info warning.

**Remedy:** Automatic. No user action needed.

---

## Hook lifecycle (non-fatal warnings)

These are **not** thrown `ShardMindError`s — they don't appear in the `ErrorCode` union and never abort an install/update. The engine surfaces them as warnings in the command Summary (yellow `StatusMessage`), the same non-fatal posture as a hook that exits non-zero (Helm semantics). They turn the hook write-boundary conventions into machine-checked signals a shard author sees during their dev loop. The bytes a misbehaving hook wrote are left in place; the warning tells the author the work belongs in a different slot. See [`docs/SHARD-LAYOUT.md §Hook lifecycle`](SHARD-LAYOUT.md) and [`docs/AUTHORING.md §6`](AUTHORING.md).

### `HOOK_BOOTSTRAP_MANAGED_WRITE`

**Meaning:** The `bootstrap` hook modified one or more **managed** files (tracked in `state.json`). `bootstrap` may write only unmanaged paths (`.qmd/`, `.git/`, caches). Detected via the post-hook re-hash: a managed file whose hash changed during bootstrap. The warning names the paths.

**Typical cause:** Managed-file personalization left in `bootstrap.ts` after the split from `post-install`; it belongs in `personalize.ts`.

**Remedy:** Move the managed-file edit to the `personalize` hook. The install/update still succeeded and the file's current bytes are recorded in `state.json`.

### `HOOK_PERSONALIZE_UNMANAGED_CREATE`

**Meaning:** The `personalize` hook created one or more **unmanaged** files (paths not in `state.json`). `personalize` may only edit managed files. Detected via a path-only vault snapshot taken before and after the hook (install/adopt only). The warning names the paths. Scope: *creation* only — modifying or deleting an already-present unmanaged file isn't flagged (the path set is unchanged), since the check avoids content-hashing the whole vault.

**Typical cause:** Artifact/index generation left in `personalize.ts`; it belongs in `bootstrap.ts`.

**Remedy:** Move the artifact creation to the `bootstrap` hook, which is permitted to write unmanaged paths and can re-run on update via a `fingerprint` bump.

### `HOOK_BOUNDARY_INCOMPLETE`

**Meaning:** The vault walk behind the `personalize` check could not read one or more folders, so the check may have missed files the hook created. The warning names the folders (`.` is the vault root). A folder that was busy or permission-denied was read a second time before it was reported. When the hook also created files, those are reported as `HOOK_PERSONALIZE_UNMANAGED_CREATE` with the unreadable folders listed alongside.

**Typical cause:** A virus scanner or search indexer holding a freshly written folder on Windows, or a folder without read permission.

**Remedy:** None needed for the install, which succeeded. If it recurs, check the named folders' permissions, or exclude the vault from real-time scanning while you develop the shard. A folder that is unreadable for good can be listed in `.shardmind/boundary-ignore` (#190): the walk then skips it, and does not see what `personalize` creates there.

### `HOOK_BOUNDARY_IGNORE_INVALID`

**Meaning:** `.shardmind/boundary-ignore`, the vault owner's list of folders the `personalize` boundary walk skips, was not applied. It could not be read, or it would switch the whole check off: it matches every name at the vault root (`*`, `**`), or it excludes every folder the vault root holds (`*/`, `/*/`, a list naming each one). The check ran without it.

**Remedy:** Fix the file: list the folders you mean by name (`.cache/`, `scratch/`), one per line. The check cannot be switched off as a whole.

### `HOOK_POST_INSTALL_DEPRECATED`

**Meaning:** The shard declares the deprecated combined `hooks.post-install` slot. It still runs (once, on install/adopt, with the legacy context and no boundary enforcement), but the slot is on a deprecation path.

**Typical cause:** A shard authored before the `bootstrap` / `personalize` split.

**Remedy:** Split `post-install.ts` into `bootstrap.ts` (unmanaged setup) + `personalize.ts` (managed edits) and update `shard.yaml`. Honored for at least one minor release (deprecated in 0.2.0; removed no earlier than 0.3.0). Worked example in [`docs/AUTHORING.md §6`](AUTHORING.md).

---

## Maintenance

If you're a shard author and hit a code that feels authoring-side, the specifically author-facing ones are:
- `SCHEMA_RESERVED_NAME`, `SCHEMA_VALIDATION_FAILED`
- `COMPUTED_DEFAULT_FAILED`, `COMPUTED_DEFAULT_INVALID`
- `RENDER_FAILED`, `RENDER_FRONTMATTER_ERROR`, `RENDER_ITERATOR_ERROR`, `RENDER_ITERATOR_NAME_CLASH`, `OUTPUT_PATH_CLASH`
- `DOWNLOAD_MISSING_MANIFEST`, `DOWNLOAD_MISSING_SCHEMA`
- `HOOK_SLOT_CONFLICT` (thrown), plus the non-fatal hook warnings `HOOK_BOOTSTRAP_MANAGED_WRITE`, `HOOK_PERSONALIZE_UNMANAGED_CREATE`, `HOOK_BOUNDARY_INCOMPLETE`, `HOOK_BOUNDARY_IGNORE_INVALID`, `HOOK_POST_INSTALL_DEPRECATED`

If you're an end user, the most common ones you'll see are:
- `SHARD_NOT_FOUND`, `VERSION_NOT_FOUND`, `REGISTRY_NETWORK`
- `VALUES_MISSING`, `VALUES_FILE_COLLISION`
- `VAULT_NOT_FOUND` (if running a hook script outside a vault)

Engine-internal codes (`STATE_*`, `BACKUP_FAILED`) shouldn't happen in normal use; open an issue if you hit one. `COLLISION_CHECK_FAILED` usually means a permissions problem on the path it names.
