# Release smoke — pre-release gate

Run BEFORE `npm run release:patch` / `:minor` / `:major` and keep the completed [Result table](#result-table) locally. After `npm run release:*` pushes the version tag and `release.yml` creates the v\<version> GitHub Release with its initial commit-list body, append the saved smoke table to that release via `gh release edit v<version> --notes-file -` or the GitHub web UI.

This gate validates the **shardmind engine** via a manual run against the production flagship shard, `breferrari/obsidian-mind`. It is not a per-shard gate — shards are tested via their own release pipelines.

## Why this gate exists

0.1.0 shipped with [#103](https://github.com/breferrari/shardmind/issues/103) (wizard select-Enter freeze). 0.1.1 shipped with [#109](https://github.com/breferrari/shardmind/issues/109) (iterated diff-review freeze). Both passed CI green; both broke the install / adopt flow on day one against `breferrari/obsidian-mind`; both were caught only by manual flagship runs after publish. The structural failure mode: the test suite measured engine + widget coverage, not "real npm tarball installs the live flagship from real GitHub". This gate covers what fixtures by definition cannot reach — the published artifact, the live flagship shard, the real GitHub fetch.

[#111](https://github.com/breferrari/shardmind/issues/111) (TUI testing framework, all phases shipped) closes the engine matrix in CI. This gate stays in place at reduced scope: published-artifact + live-flagship + real-GitHub. It relaxes further only when one of those surfaces lands in automation, or when the maintainer accepts the residual risk for a specific release.

## Setup

```bash
# From the shardmind repo root, on the release branch with the version bump
# committed but BEFORE running npm run release:*.
rm -rf node_modules
npm ci
npm run typecheck
npm test
npm run build

# Pack the tarball that npm publish would upload, install it into an
# isolated prefix, and export $SHARDMIND_CLI for every scenario below.
# This catches packaging / `bin` wiring / `files` field regressions that
# running dist/cli.js directly would miss.
TARBALL="$PWD/$(npm pack 2>/dev/null | tail -n1)"
SHARDMIND_PREFIX=$(mktemp -d)
npm install -g --prefix "$SHARDMIND_PREFIX" --silent "$TARBALL"
export SHARDMIND_CLI="$SHARDMIND_PREFIX/bin/shardmind"
test -x "$SHARDMIND_CLI"
```

Record the local test count (e.g. `932`) for the result table.

## Flagship adopt smoke (>= 5 differing files)

A fresh clone of `obsidian-mind` against itself produces 0 `differs`. The recipe seeds five small modifications at known-managed paths so the diff review iterates >= 5 times. Paths chosen for content-stability across recent `obsidian-mind` versions; if any path has been removed upstream, swap to another file under `brain/` or repo root and note the swap in the result row.

```bash
# Scratch dir outside the shardmind repo
SCRATCH=$(mktemp -d)
cd "$SCRATCH"
git clone --depth 1 https://github.com/breferrari/obsidian-mind.git
cd obsidian-mind

# Seed 5 user-side modifications. Fail closed if a path was renamed
# upstream — `>>` would silently create the file and skew the diff count.
for f in Home.md "brain/North Star.md" "brain/Patterns.md" CLAUDE.md AGENTS.md; do
  test -f "$f" || {
    printf 'Expected existing file missing: %s\n' "$f" >&2
    printf 'Swap to another file under brain/ or repo root and note the swap in the result row.\n' >&2
    exit 1
  }
  printf '\n\n<!-- release-smoke marker -->\n' >> "$f"
done

"$SHARDMIND_CLI" adopt github:breferrari/obsidian-mind
```

Walk through the wizard. Then, in the diff-review phase, observe:

- **Counter advances**: header reads `(1 of N)`, `(2 of N)`, … `(5 of N)` where N >= 5. The counter incrementing on Enter is the #109 regression check.
- **Each prompt accepts a choice**: pick `keep_mine` on the first 4 differs and `use_shard` on the 5th. Both branches must fire — pinning that the per-iteration `useOncePerKey` guard re-arms across files.
- **Summary frame renders** the three count lines: "N matched the shard exactly (managed silently)" for the unmodified files, "4 kept your version (recorded as managed)" for the `keep_mine` decisions, "1 switched to the shard's version" for the `use_shard` decision. The post-install hook section surfaces (completed or non-fatal warning, both shapes are acceptable).
- **Vault state is consistent**: `.shardmind/state.json` exists, `shard-values.yaml` exists, the four `keep_mine` files still contain the `release-smoke marker`, the one `use_shard` file no longer does.

## Flagship install smoke (fresh dir)

```bash
INSTALL_DIR=$(mktemp -d)
cd "$INSTALL_DIR"
"$SHARDMIND_CLI" install github:breferrari/obsidian-mind
```

- **Wizard advances on every value prompt**, including the select with `default = first option` (the #103 regression check). Pressing Enter on the default-focused option must advance — not freeze.
- **Module multiselect** accepts arrow + space + Enter; live file count updates as modules toggle.
- **Computed-default preview** renders in the summary frame before the confirm screen (values computed from entered module selections).
- **Confirm screen → Install** progresses through phases `installing` (with per-file labels rolling through the history) → `running-hook` → `summary` without a stuck label. Pre-wizard the loader shows `loading` with messages like `Resolving …` / `Downloading …` / `Parsing manifest and schema…`.
- **Vault content matches**: `Home.md` exists with rendered values; `.shardmind/state.json` exists; `shard-values.yaml` records the entered values.
- **`SHARDMIND_CLI` is the packed tarball**, not a global `shardmind` from a previous install — confirm with `realpath "$SHARDMIND_CLI"` resolving under `$SHARDMIND_PREFIX`.

## Cancellation smoke

```bash
CANCEL_DIR=$(mktemp -d)
cd "$CANCEL_DIR"
"$SHARDMIND_CLI" install github:breferrari/obsidian-mind
# At the first wizard prompt, press Ctrl+C.
```

- Process exits with status 130 (SIGINT) within ~1s.
- `.shardmind/` does not exist; `shard-values.yaml` does not exist; no `*.shardmind-backup-*` files; no managed-path content. The dir is exactly as it was pre-run modulo the empty mktemp shell.
- Repeat with Ctrl+C during the `running-hook` phase (post-confirm, after the wizard). The rollback widens: addedPaths files are deleted, partial YAML writes are reverted. Check post-run state matches pre-run (empty directory modulo the mktemp shell).

## Result table

Save the filled-in section locally. After `release.yml` publishes the v\<version> GitHub Release, append the saved section to that release's notes. Tick each row only after running its block above against `$SHARDMIND_CLI` from the same SHA being tagged.

```markdown
### Release smoke — flagship `breferrari/obsidian-mind`

| Step | Result |
| ---- | ------ |
| Setup (npm ci + typecheck + test (NNN passing) + build) | OK / FAIL |
| Flagship adopt — >= 5 differing files iterate cleanly | OK / FAIL |
| Flagship install — wizard → install → summary | OK / FAIL |
| Cancellation — Ctrl+C at wizard + during hook | OK / FAIL |

Cut from `git rev-parse HEAD = <sha>` at `<ISO-8601 timestamp>`.
shardmind built locally against Node `<node --version>`.
obsidian-mind clone HEAD: `<sha>` from `https://github.com/breferrari/obsidian-mind`.
```

## When the gate may relax

Track via [#112](https://github.com/breferrari/shardmind/issues/112) and any follow-up issue. Relaxation criteria, in order from cheapest to most ambitious:

1. **CI installs the npm tarball.** A workflow that runs `npm pack`, then `npm install -g ./shardmind-<v>.tgz`, then drives a non-interactive `install --yes` against a recorded `obsidian-mind` snapshot would close the published-artifact surface. The cancellation + iterated-diff surfaces stay manual until a real-flagship live-fetch job exists.
2. **CI fetches the live flagship.** A nightly (not per-PR — the flake surface against the live network is wide) job that drives Layer 2 PTY scenarios against `github.com/breferrari/obsidian-mind` HEAD. Closes the live-shard + real-GitHub surfaces.
3. **Cancellation Layer 2 nightly.** The Ctrl+C scenarios are already covered under PTY in #111 Phase 2 (scenario 18); the gap is that cancellation against the live flagship hasn't been exercised under a real PTY, only against fixture shards.

Until at least (1) lands, this gate runs before every `npm run release:*`.

## Release cadence

Three releases shipped in 12 hours on launch day under hotfix pressure (`0.1.0 → 0.1.1 → 0.1.2`). With this gate now requiring a real-flagship run before each `npm publish`, cadence is bounded by smoke-run wall-clock time. Without a documented policy, the next batch of v0.1.x work risks either over-fragmenting (5 patches in a week, each requiring smoke) or under-batching (one patch per quarter, all changes intermingled).

Scope: this policy applies to **v0.1.x patches only**. Minors / majors are renegotiated per-track when 0.1.x stabilizes.

Three release categories:

- **Hotfix** — any user-blocking bug that breaks `install` / `update` / `adopt` against a real shard ([#103](https://github.com/breferrari/shardmind/issues/103) and [#109](https://github.com/breferrari/shardmind/issues/109) are the canonical examples). Single-issue patch. Ship same-day after smoke. **Branches off the previous released tag**, not `main` HEAD, so unreleased UX work in `[Unreleased]` doesn't tag along under a hotfix label. Cherry-pick the fix onto the patch branch; merge back to `main` after the tag is cut.
- **UX** — improvements without user-blocking bugs (current backlog: [#100](https://github.com/breferrari/shardmind/issues/100), [#101](https://github.com/breferrari/shardmind/issues/101), [#104](https://github.com/breferrari/shardmind/issues/104), [#105](https://github.com/breferrari/shardmind/issues/105), [#120](https://github.com/breferrari/shardmind/issues/120)). Bundle 2–4 related issues per patch. Ship weekly at most. Bundling boundary: items that share the same surface (wizard, diff prompts, summary frame) bundle naturally; items touching different surfaces bundle only if the smoke + Copilot-review overhead would otherwise dominate the per-issue cost.
- **Foundation** — release / observability / lifecycle infrastructure (current examples: [#102](https://github.com/breferrari/shardmind/issues/102) hook lifecycle, [#119](https://github.com/breferrari/shardmind/issues/119) this policy, [#121](https://github.com/breferrari/shardmind/issues/121) engine-version-compat). Own patch each, smoke-tested. Foundation releases without user-blocking bugs still smoke; cadence is orthogonal to the gate.

Hybrid releases: a release containing a hotfix dominates. UX items already in `[Unreleased]` park until the hotfix tag ships, then re-bundle on top of `main`. This prevents UX items shipping under a hotfix tag with insufficient review surface.

The "weekly at most" UX rate is a recommendation, not a hard cap — the smoke-run wall-clock cost (~10 min once setup is hot) is the real bound. If two UX bundles would each cost their own smoke, bundle further.

[`CLAUDE.md` §Release Process](CLAUDE.md#release-process) cross-references this section as the binding cadence rule.
