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
| `0` | Success, user cancellation, already-up-to-date, or `shardmind` status (any phase). |
| `1` | `install` or `update` failed — the CLI renders the error message, code, and hint on stdout, then exits non-zero so CI / scripts can branch on it. |
| `130` | Interrupted by SIGINT (Ctrl+C in a terminal, or the ETX byte `0x03` on stdin when invoked non-interactively). Any in-flight writes are rolled back and temp files cleaned up before exit. |

Status (`shardmind` / `shardmind --verbose`) deliberately stays at `0` on every phase — including when it surfaces a corrupt `state.json`. It's an ambient read-only report, never a gate. The typed error code still appears in stdout, so a script that wants to assert "status ran clean" can grep for the absence of `code: ` lines rather than reading the exit code.

### Scripting idioms

```bash
# Fail fast on install error
shardmind install acme/demo --yes --values values.yaml || exit $?

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
| `SHARDMIND_GITHUB_API_BASE` | `https://api.github.com` | Route GitHub REST calls to an alternate host. Useful for GitHub Enterprise (e.g. `https://github.acme.corp/api/v3`), mirror proxies (e.g. an internal caching layer), or local testing. Trailing slashes are trimmed. |
| `SHARDMIND_REGISTRY_INDEX_URL` | `https://raw.githubusercontent.com/shardmind/registry/main/index.json` | Override the shard registry index. Only affects non-`github:` references (the `namespace/name` shorthand); `github:owner/repo` direct installs skip the registry entirely. |

All variables are read **once at CLI startup** and captured as module-level constants. Changing them mid-run has no effect — fork a new process with the desired environment instead.

### Typical deployments

**GitHub Enterprise**: point the API base at your GHE host.

```bash
export SHARDMIND_GITHUB_API_BASE=https://github.acme.corp/api/v3
export GITHUB_TOKEN=ghe_pat_xxxxxxxxxxxxxxxx
shardmind install acme/internal-shard --yes --values values.yaml
```

**Mirror / caching proxy**: point the API base at the proxy; the proxy forwards to real GitHub. Tarball GETs, HEAD checks, and `releases/latest` all route through the same base.

**Air-gapped**: pair `SHARDMIND_GITHUB_API_BASE` with a local HTTP server that serves tarballs and release metadata — the same interface the E2E harness stub uses (see [`tests/e2e/helpers/github-stub.ts`](../tests/e2e/helpers/github-stub.ts) for the protocol). Three endpoints are enough:

- `GET /repos/:owner/:repo/releases/latest` → `{ "tag_name": "v<version>" }`
- `HEAD /repos/:owner/:repo/tarball/v<version>` → 200 if the tag exists
- `GET /repos/:owner/:repo/tarball/v<version>` → the tarball bytes (gzipped tar)

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

## Versioning

ShardMind's own version is semver-pinned. Shards are semver-pinned by their GitHub tags (the `v` prefix is stripped before parsing).

- Latest version: `shardmind install acme/demo` (omits `@version`; resolves via `releases/latest`).
- Pinned: `shardmind install acme/demo@1.2.3` (exact tag).
- Pre-release: pre-release tags work if GitHub exposes them via `releases/latest`; otherwise pin explicitly.

Shard migrations run during `update` when the schema's `migrations` array covers the version range — see [`docs/IMPLEMENTATION.md §4.10`](IMPLEMENTATION.md).
