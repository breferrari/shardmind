# Operations Reference

Operational contract for wrapper scripts, CI pipelines, and enterprise deployments — the things a user running `shardmind` interactively doesn't need but a script driving it does.

See also:

- [`docs/ERRORS.md`](ERRORS.md) — every `ShardMindError` code: meaning, cause, remedy.
- [`docs/ARCHITECTURE.md §10`](ARCHITECTURE.md) — TUI behavior for each command.
- [`docs/IMPLEMENTATION.md §4.1`](IMPLEMENTATION.md) — registry module spec.

---

## Exit codes

| Code | When |
|------|------|
| `0` | Success, user cancellation, already-up-to-date, or `shardmind` status in the terminal (any phase). |
| `1` | `install`, `update` or `adopt` failed. The CLI renders the error message, code and hint on stdout, then exits non-zero so CI and scripts can branch on it. |
| `1` (validate) | `shardmind validate` found at least one error, or could not read or fetch its target. Warnings alone exit `0`. |
| `1` (`--json`) | Any `--json` document with `ok: false`, status included: the body and `$?` agree. |
| `1` (arguments) | An unknown option or an invalid argument. Nothing runs. A `--json` run answers an `ARGS_INVALID` document. |
| `1` (crash) | An unexpected error no view caught. The plain-text report goes to stderr. A `--json` run also writes a failure document, with its `stack`, to stdout. |
| `130` | Interrupted by SIGINT (Ctrl+C in a terminal, or the ETX byte `0x03` on stdin when invoked non-interactively). Any in-flight writes are rolled back and temp files cleaned up before exit. |
| `141` | A reader closed stdout early (`shardmind --json \| head`), and the run would otherwise have exited `0`. Later writes are dropped, the run finishes as it would have, then exits `141` without a stack trace, as `SIGPIPE` exits do. A run that failed or rolled back keeps its own code. |

Status in the terminal (`shardmind` / `shardmind --verbose`) deliberately stays at `0` on every phase, including when it surfaces a corrupt `state.json` or one from a newer ShardMind. It's an ambient read-only report, never a gate. The typed error code still appears in stdout, so a script that wants to assert "status ran clean" can grep for the absence of `code: ` lines. `shardmind --json` is the exception, by design (ARCHITECTURE §10.3a): a document that says `ok: false` exits `1`, so a script reading the document and one reading `$?` agree.

## JSON documents and semver

Every `--json` document carries `schemaVersion` (`1` today). What it promises:

- A consumer refuses a `schemaVersion` it does not know, rather than guess.
- Within a `schemaVersion`, things are only added. A new field, a new `classification` or `action` value, or a new `error.details` shape may appear in a minor release, so a consumer ignores what it does not know and checks the values it branches on.
- Within a `schemaVersion`, a field is never removed, renamed or retyped. A change that would break a consumer bumps it.
- Error `code`s come from the registry in [`ERRORS.md`](ERRORS.md) and are stable. A code is never reused for another meaning.
- `adopt --mode auto-merge` is experimental and outside this promise: its merge results may change in a minor release. The document's shape does not.

### Scripting idioms

```bash
# Fail fast on install error
shardmind install acme/demo --yes --values values.yaml || exit $?

# Reinstall over the existing install in the current folder (`.`),
# overwriting colliding files with no backup (#55). Without --force, an
# existing install is refused and collisions are backed up to
# <path>.shardmind-backup-<timestamp>. Without `.`, install makes a new
# folder named after the shard (#333).
shardmind install acme/demo . --yes --force --values values.yaml || exit $?

# Detect "nothing to do" separately from failure
if ! shardmind update --yes; then
  echo "update failed" >&2
  exit 1
fi
```

**Non-interactive cancellation** — when the CLI is invoked non-interactively (stdin is a pipe, not a TTY), writing the ETX byte (`0x03`, the ASCII form of Ctrl+C) to the child's stdin requests clean cancellation. The CLI re-emits SIGINT inside its own process, walks back any in-progress writes, and exits with `130`. This exists because Node's `child.kill('SIGINT')` is emulated as `TerminateProcess` on Windows — skipping every `process.on('SIGINT', ...)` handler — so a cross-platform wrapper can't rely on signalling. Wrapper scripts control the child's stdin explicitly to deliver the byte:

```javascript
import { spawn } from 'node:child_process';
const child = spawn('shardmind', ['install', 'acme/demo', '--yes', '--values', 'values.yaml'], {
  stdio: ['pipe', 'inherit', 'inherit'],
});
// Later, when you want to cancel:
child.stdin.write(Buffer.from([0x03]));
child.stdin.end();
```

The bridge lives in `source/core/cancellation.ts`; TTY invocations are unaffected (real Ctrl+C in the terminal is handled by Node's native console-signal plumbing on both platforms).

---

## Environment variables

None are required; all have sensible defaults that match the public GitHub / registry setup.

| Variable | Default | Purpose |
|----------|---------|---------|
| `GITHUB_TOKEN` | *(unset)* | Authenticates GitHub API calls. Unauthenticated requests are rate-limited to 60/hour; setting a token gets 5,000/hour. Any classic or fine-grained token with `public_repo` read access works. Set via `~/.bashrc`, shell-specific `.env`, or the CI runner's secret store. |
| `SHARDMIND_MAX_SHARD_SIZE` | `256M` | Largest a shard may extract to: bytes, or with a `K`/`M`/`G` suffix. Counted from the archive's entries before they are written, so a decompression bomb stops early (`SHARD_TOO_LARGE`). obsidian-mind v9.0.0 extracts to about 6.9 MB. An invalid value is refused (`DOWNLOAD_LIMIT_INVALID`). |
| `SHARDMIND_MAX_SHARD_ENTRIES` | `100000` | Most entries (files and folders) a shard's archive may hold. obsidian-mind v9.0.0 has 318. An invalid value is refused. |
| `SHARDMIND_GITHUB_API_BASE` | `https://api.github.com` | Route GitHub REST calls to an alternate host. Useful for GitHub Enterprise (e.g. `https://github.acme.corp/api/v3`), mirror proxies (e.g. an internal caching layer), or local testing. Surrounding whitespace and trailing slashes are stripped. |
| `SHARDMIND_REGISTRY_INDEX_URL` | `https://raw.githubusercontent.com/shardmind/registry/main/index.json` | Override the shard registry index. Only affects non-`github:` references (the `namespace/name` shorthand); `github:owner/repo` direct installs skip the registry entirely. |

All variables are read **once at CLI startup** and captured as module-level constants. Changing them mid-run has no effect — fork a new process with the desired environment instead.

### Typical deployments

**GitHub Enterprise**: point the API base at your GHE host.

```bash
export SHARDMIND_GITHUB_API_BASE=https://github.acme.corp/api/v3
export GITHUB_TOKEN=ghe_pat_xxxxxxxxxxxxxxxx
shardmind install acme/internal-shard --yes --values values.yaml
```

**Mirror / caching proxy**: point the API base at the proxy; the proxy forwards to real GitHub. The `/releases` listing, `/commits/<ref>`, tarball HEAD checks, and tarball GETs all route through the same base.

**Air-gapped**: pair `SHARDMIND_GITHUB_API_BASE` with a local HTTP server that serves tarballs and release metadata — the same interface the E2E harness stub uses (see [`tests/e2e/helpers/github-stub.ts`](../tests/e2e/helpers/github-stub.ts) for the protocol). Five endpoints cover every install / update / status path:

- `GET /repos/:owner/:repo/releases?per_page=100` → array of `{ tag_name, prerelease }` sorted by `created_at` DESC. Powers default-stable resolution + `--include-prerelease`.
- `HEAD /repos/:owner/:repo/tarball/v<version>` → 200 if the tag exists. Tag-install verify.
- `GET /repos/:owner/:repo/tarball/v<version>` → tarball bytes (gzipped tar). Tag-install download.
- `GET /repos/:owner/:repo/commits/<ref>` → `{ "sha": "<40-char hex>" }`. Powers `github:owner/repo#<ref>` ref installs and `shardmind update` re-resolution on ref-installed vaults.
- `HEAD` + `GET /repos/:owner/:repo/tarball/<sha>` (no `v` prefix) → tarball bytes addressed by commit SHA. Ref-install download.

---

## File locations

ShardMind writes only within the vault directory. No global state, no `~/.shardmind/`.

| Path | Purpose | Managed by |
|------|---------|-----------|
| `.shardmind/state.json` | Source of truth for "what was installed and when" — shard identity, version, per-file rendered hashes, module selections. | `install` writes; `update` rewrites; never hand-edit. |
| `.shardmind/shard.yaml` | Cached copy of the manifest the shard was installed from. | Written during install/update. Used by status to render identity when the shard tarball is offline. |
| `.shardmind/shard-schema.yaml` | Cached values schema. | Same lifecycle as the manifest. |
| `.shardmind/templates/` | Cached pre-render templates for three-way merge on update. | Written during install/update. Safe to delete at the cost of update fidelity. |
| `.shardmind/update-check.json` | 24-hour cache of "latest upstream version". | Written by `update` (opportunistically warms the cache) and by `shardmind` (status) when checking for new versions. Safe to delete; ShardMind rebuilds on next check. |
| `.shardmind/boundary-ignore` | Optional. Folders the `personalize` write-boundary check skips, one gitignore-style pattern per line (#190). Hook writes in a listed folder go undetected. | You. ShardMind only reads it. |
| `shard-values.yaml` | User-owned values file. The install wizard writes it once; subsequent edits are yours. | You. |
| `<vault files>` | Rendered template output — `CLAUDE.md`, `brain/`, `work/`, etc. | You and ShardMind, with drift tracked by `state.files`. |

`.shardmind-backup-<timestamp>` files appear next to any pre-existing path that collided with an install and was backed up. Safe to delete once you've verified the install.

---

## Signals

| Signal | Effect |
|--------|--------|
| `SIGINT` (POSIX) | Rolls back any in-progress writes, removes the extracted shard tempdir, exits `130`. |
| ETX (`0x03`) on stdin (non-TTY, cross-platform) | Re-emits SIGINT inside the CLI. Same rollback contract. |
| `SIGTERM` (POSIX) | Not specifically handled — Node's default terminates. Use `SIGINT` / ETX for clean cancellation. |

---

## `--json` runs

`shardmind update --json` and `shardmind adopt --json` **run** the command when `--dry-run` is absent, and write exactly one JSON document on stdout, ending in a newline, then exit (#348). With `--dry-run` they write the plan instead. The exit codes and `outcome` names below are part of the 1.0 contract.

**Never prompts.**
- **Conflicts** resolve as `--yes` resolves them, whether or not `--yes` is passed:
  - update keeps your version of each conflicting file;
  - adopt with no `--mode` keeps all your differing files;
  - adopt with `--mode` lets that mode decide.

  Each such file is listed with `conflict: { resolution, by }`, where `by` is `"json-default"` or `"mode"`, so a script can find every file it never chose.
- **Any other decision** needs the flags its dry run needs, so the real run does exactly what `--dry-run --json` with the same flags planned:
  - update's new optional modules or removed files you edited need `--yes`, else `UPDATE_JSON_NEEDS_ANSWERS`;
  - adopt's values need `--values` or `--yes`.

**Exit codes**

| Case | `ok` | Exit |
|---|---|---|
| Finished, whatever the hooks did (they are non-fatal) | `true` | 0 |
| Update with nothing to do (`upToDate: true`) | `true` | 0 |
| Refused before writing (needs answers, vault locked, bad flags, network, …) | `false` | 1 |
| Failed and rolled back, or could not roll back (`ROLLBACK_INCOMPLETE`) | `false` | 1 |
| Ctrl+C before or during the write: rolled back | `false`, `error.code: "CANCELLED"` | 130 |
| Ctrl+C during the hooks: the update or adopt is committed, the hooks were cut short | `true` | 130 |

**`result` of a real run** (`dryRun: false`):

- **`files`**: every path, sorted, each with an `outcome`, plus `shardHash` / `userHash` / `renamedFrom` / `conflict` where they apply.
- **Run details:** `backupDir` (update: the snapshot of what it replaced; adopt: `null`, since a successful adopt keeps no snapshot), `hooks` (`slot`, `outcome`: `completed` / `failed` / `skipped`; a failed hook carries `failure`, below, and its first `message` line; plus `exitCode` and `log`), `warnings` and `durationMs`.
- **update** also has `fromVersion`, `toVersion` and `counts`, and `upToDate: true` when there was nothing to do.
- **adopt** also has `mode`, `version` and `counts`.

| update `outcome` | Meaning |
|---|---|
| `written` | A new file the shard added |
| `replaced` | Your untouched file, replaced by the new version |
| `merged` | Your edits merged with the new version |
| `restored` | A file you had deleted, put back |
| `kept` | Your version kept (a conflict, or a removed file you edited) |
| `kept-untracked` | Your file at a path the new version adds, left yours and untracked |
| `deleted` | A file the new version dropped |
| `unchanged` | Nothing to do |

| hook `failure` (on a failed hook) | Meaning |
|---|---|
| `install` | shardmind's own files are missing: reinstall shardmind |
| `context` | The hook's context could not be handed over |
| `spawn` | The hook process could not start |
| `import` | The hook module could not be loaded |
| `no-default-export` | The module has no default function |
| `threw` | The hook threw or rejected |
| `exit` | The hook exited non-zero by itself |
| `killed` | A signal ended it that was not shardmind's |
| `timeout` | It ran past `timeout_ms` |
| `cancelled` | Ctrl+C stopped it |

The list is exhaustive: a failed hook always has exactly one of these.

| adopt `outcome` | Meaning |
|---|---|
| `matched` | Already the shard's bytes |
| `kept-mine` | Differed; your bytes kept |
| `used-shard` | Differed; the shard's bytes written |
| `merged` | Differed; auto-merged (experimental) |
| `updated-behind` | Still the `--from-version` release's bytes; the new release written (#325) |
| `installed` | The shard's file, new to the vault |

## Versioning

ShardMind's own version is semver-pinned. Shards are semver-pinned by their GitHub tags (the `v` prefix is stripped before parsing).

**Experimental, outside the semver promise:** `adopt --mode auto-merge` (#347). Its two-way union merge may change in a minor release. Using it prints a one-line warning on stderr.

- Latest stable: `shardmind install acme/demo` (omits `@version`; resolves the newest `prerelease: false` entry from `/releases?per_page=100`).
- Pinned tag: `shardmind install acme/demo@1.2.3` (exact tag).
- Pre-release: `shardmind install acme/demo@1.2.3-beta.1` for an explicit prerelease pin. On update, `shardmind update --include-prerelease` widens latest-resolution to all releases; `shardmind update --release 1.2.3-beta.1` pins. Beta-only repos throw `NO_RELEASES_PUBLISHED` with a `--include-prerelease` hint.
- Branch / commit: `shardmind install github:acme/demo#main` (or `#feature/foo`, `#abc1234`). Resolves via `/commits/<ref>` to a 40-char SHA, recorded in `state.resolvedSha`. Future `shardmind update` runs re-resolve the same ref so the vault tracks branch movement.

Shard migrations run during `update` when the schema's `migrations` array covers the version range — see [`docs/IMPLEMENTATION.md §4.10`](IMPLEMENTATION.md).
