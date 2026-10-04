# ShardMind Roadmap

> Living document. The phases below are the build order, each row links its issue, and the tracker holds each issue's state. A fresh session takes the next task with the `take-next` skill, which needs no context from prior conversations.
>
> Context: [`VISION.md`](VISION.md) | Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Implementation: [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) | **Contract**: [`docs/SHARD-LAYOUT.md`](docs/SHARD-LAYOUT.md) | Dev guide: [`CLAUDE.md`](CLAUDE.md)

## How work is taken

**[`.claude/skills/take-next/SKILL.md`](.claude/skills/take-next/SKILL.md)** runs the [`CLAUDE.md` Working Agreement](CLAUDE.md#working-agreement-v6-execution-standard) as one pass: one issue, from plan to merged.

- **Order is the phase number at the start of a milestone title.** `sh .claude/skills/take-next/next.sh` names the milestone to take from. There is no shelf: every open issue sits in a phase, so the loop reaches all of it.
- **Each phase below has a section whose heading matches its milestone title exactly,** and a table whose marks follow the tracker: ✅ closed, ⬜ open, 🔨 in progress.
- **`sh .claude/skills/take-next/preflight.sh` checks the record against itself:** every invariant in `docs/SHARD-LAYOUT.md` named by a test, every roadmap mark agreeing with its issue, every open issue in a milestone, and every issue mentioned here.
- **An issue filed mid-pass gets a milestone and a row** in the same pass. Out-of-scope work gets a row in the phase it belongs to, or in a new phase after the last one, with its dated reason on the issue.

The tracker moved to phases on 2026-10-03. Before that, this file was a checkbox list, kept below as [History](#history).

---

## Phase 1 — update keeps your edits

Milestone: [Phase 1](https://github.com/breferrari/shardmind/milestone/1)

An update never replaces a file the user changed, and every install gets its own QMD store. [#150](https://github.com/breferrari/shardmind/issues/150) comes first: it reports a user's edited file as kept while it overwrites it, then labels the file `managed`, so the next overwrite is reported as nothing at all. That breaks the promise Invariant 3 and the ownership model exist to keep. [#88](https://github.com/breferrari/shardmind/issues/88) closes the phase because a shard cannot rename a managed path without it (it blocks `breferrari/obsidian-mind#71`).

| | Task | Issue |
|---|---|---|
| ✅ | update silently overwrites locally-modified files while reporting "kept mine" (state.json labels user-edited files `managed`) | [#150](https://github.com/breferrari/shardmind/issues/150) |
| ✅ | List the paths an update replaced in its summary | [#153](https://github.com/breferrari/shardmind/issues/153) |
| ✅ | qmd_index not personalized on install — every vault collides on the same QMD store | [#137](https://github.com/breferrari/shardmind/issues/137) |
| ✅ | Root-command options silently shadow same-named subcommand options (`adopt --verbose` does nothing) | [#147](https://github.com/breferrari/shardmind/issues/147) |
| ✅ | v0.2: Rename migrations in shard.yaml + shardmind adopt --from-version (split into #178, #179) | [#88](https://github.com/breferrari/shardmind/issues/88) |
| ✅ | Apply shard.yaml rename migrations on update | [#178](https://github.com/breferrari/shardmind/issues/178) |
| ✅ | Add adopt --from-version to apply rename migrations | [#179](https://github.com/breferrari/shardmind/issues/179) |

## Phase 2 — collisions and binary files

Milestone: [Phase 2](https://github.com/breferrari/shardmind/milestone/2)

Pre-existing files and binary files get a deliberate path through install and update instead of the text merge.

| | Task | Issue |
|---|---|---|
| ✅ | Binary files should bypass three-way merge entirely | [#63](https://github.com/breferrari/shardmind/issues/63) |
| ✅ | Byte-identical preexisting add-collision should adopt silently | [#62](https://github.com/breferrari/shardmind/issues/62) |
| ✅ | --yes policy for preexisting add-collisions churns every update | [#61](https://github.com/breferrari/shardmind/issues/61) |
| ✅ | DiffView: distinguish preexisting add-collision from modified-file conflict | [#60](https://github.com/breferrari/shardmind/issues/60) |
| ✅ | --force flag on install for scripted collision overwrite without backup | [#55](https://github.com/breferrari/shardmind/issues/55) |
| ✅ | Refuse to write through symlinks and hard links at vault paths | [#163](https://github.com/breferrari/shardmind/issues/163) |

## Phase 3 — tests that do not flake

Milestone: [Phase 3](https://github.com/breferrari/shardmind/milestone/3)

The suite fails only on real defects, on all three operating systems.

| | Task | Issue |
|---|---|---|
| ✅ | Flaky test: merge-adversarial 10K-lines tokenize times out under parallel pressure | [#114](https://github.com/breferrari/shardmind/issues/114) |
| ✅ | Flake: hook-runner pre-throw stdout dropped under parallel CPU pressure | [#106](https://github.com/breferrari/shardmind/issues/106) |
| ✅ | E2E: bridge SIGINT delivery reliably on GH Actions Windows runner | [#57](https://github.com/breferrari/shardmind/issues/57) |
| ✅ | Fix the write-boundary A2 test flaking under load | [#175](https://github.com/breferrari/shardmind/issues/175) |
| ✅ | Stop dist/ changing while E2E tests spawn the CLI | [#176](https://github.com/breferrari/shardmind/issues/176) |
| ✅ | Read a fast-exiting CLI's last output in the PTY harness | [#177](https://github.com/breferrari/shardmind/issues/177) |
| ✅ | Retry temp-dir removal on Windows (ENOTEMPTY/EBUSY/EPERM) | [#191](https://github.com/breferrari/shardmind/issues/191) |
| ⬜ | Stop cli.test.ts update scenarios timing out on Windows CI | [#218](https://github.com/breferrari/shardmind/issues/218) |

## Phase 4 — close what already shipped

Milestone: [Phase 4](https://github.com/breferrari/shardmind/milestone/5)

Issues whose work already landed elsewhere get verified against the code and closed with the evidence. Each row is verify-and-close: confirm the work against the code or the owning repo, then close the issue with that evidence.

| | Task | Issue |
|---|---|---|
| ✅ | Command namespace prefix for discoverability | [#25](https://github.com/breferrari/shardmind/issues/25) |
| ✅ | Topic-based meeting prep command (/prep-topic) | [#26](https://github.com/breferrari/shardmind/issues/26) |
| ✅ | npm publishing setup — claim-publish retry + NPM_TOKEN | [#27](https://github.com/breferrari/shardmind/issues/27) |
| ✅ | Encode state-schema migration rules (uses v0.1 framework) | [#40](https://github.com/breferrari/shardmind/issues/40) |

## Phase 5 — engine defects and dependency drift

Milestone: [Phase 5](https://github.com/breferrari/shardmind/milestone/6)

Known defects and stale workarounds in the engine are fixed, so no user is blocked on a case the engine already half-handles.

| | Task | Issue |
|---|---|---|
| ✅ | Make the test suite independent of FORCE_COLOR | [#159](https://github.com/breferrari/shardmind/issues/159) |
| ✅ | Drop LineInterner workaround once node-diff3 ships the prototype-lookup fix | [#49](https://github.com/breferrari/shardmind/issues/49) |
| ✅ | NO_COLOR / FORCE_COLOR respect across Ink components | [#37](https://github.com/breferrari/shardmind/issues/37) |
| ✅ | Agent/headless ergonomics: non-interactive mode, JSON output, per-file plan, value detection | [#139](https://github.com/breferrari/shardmind/issues/139) |
| ✅ | Apply a shard release that only changes a file's case | [#169](https://github.com/breferrari/shardmind/issues/169) |
| ✅ | Align the RELEASE-SMOKE cancellation rows with the engine | [#155](https://github.com/breferrari/shardmind/issues/155) |
| ✅ | Apply a shard release that only changes a folder's case | [#195](https://github.com/breferrari/shardmind/issues/195) |
| ✅ | Strip non-colour terminal control sequences from rendered hook output | [#204](https://github.com/breferrari/shardmind/issues/204) |
| ⬜ | Roll back the files a failed install already wrote | [#207](https://github.com/breferrari/shardmind/issues/207) |
| ✅ | Gate a templated command or agent by its name | [#208](https://github.com/breferrari/shardmind/issues/208) |
| ✅ | Undo collision backups when a backup name cannot be found | [#209](https://github.com/breferrari/shardmind/issues/209) |
| ✅ | Decide whether update skips volatile files that install recorded as managed | [#210](https://github.com/breferrari/shardmind/issues/210) |
| ⬜ | Back up user files at the paths an _each template expands to | [#214](https://github.com/breferrari/shardmind/issues/214) |
| ⬜ | Keep the user's .shardmind/ files and empty folders when a fresh install rolls back | [#215](https://github.com/breferrari/shardmind/issues/215) |

## Phase 6 — docs match the code

Milestone: [Phase 6](https://github.com/breferrari/shardmind/milestone/7)

The implementation docs describe the modules as they are now.

| | Task | Issue |
|---|---|---|
| ✅ | IMPLEMENTATION.md §4.11a / §4.11b for install-planner + install-executor | [#64](https://github.com/breferrari/shardmind/issues/64) |
| ✅ | v0.1 docs rewrite: ARCHITECTURE §3 + AUTHORING §2 + IMPLEMENTATION §4.* / §9 per v6 layout | [#85](https://github.com/breferrari/shardmind/issues/85) |

## Phase 7 — authoring and CLI ergonomics

Milestone: [Phase 7](https://github.com/breferrari/shardmind/milestone/8)

Each authoring and CLI proposal is built, or declined with a reason that survives a check. These were deferred as polish with no user report behind them. Each pass decides build or decline under the take-next Declines rule, on evidence.

| | Task | Issue |
|---|---|---|
| ✅ | Enforce tarball size cap in downloadShard | [#32](https://github.com/breferrari/shardmind/issues/32) |
| ✅ | VaultFS abstraction with built-in rollback tracking (declined) | [#33](https://github.com/breferrari/shardmind/issues/33) |
| ⬜ | VaultFS abstraction with built-in rollback tracking | [#33](https://github.com/breferrari/shardmind/issues/33) |
| ⬜ | shardmind validate <shard> command | [#34](https://github.com/breferrari/shardmind/issues/34) |
| ⬜ | Pre-install template syntax lint | [#35](https://github.com/breferrari/shardmind/issues/35) |
| ✅ | Debug logging (SHARDMIND_DEBUG env var) (declined) | [#36](https://github.com/breferrari/shardmind/issues/36) |
| ⬜ | $EDITOR integration for DiffView conflict resolution | [#50](https://github.com/breferrari/shardmind/issues/50) |
| ⬜ | Declare & enforce external CLI tool dependencies (e.g. qmd) with version ranges at install/update | [#138](https://github.com/breferrari/shardmind/issues/138) |
| ✅ | Let a vault exclude a permanently unreadable folder from the write-boundary walk | [#190](https://github.com/breferrari/shardmind/issues/190) |
| ⬜ | Let the update prompt track a kept add-collision file per file | [#165](https://github.com/breferrari/shardmind/issues/165) |
| ⬜ | Merge files with many repeated lines in less than cubic time | [#170](https://github.com/breferrari/shardmind/issues/170) |
| ⬜ | Write --json output without terminal control codes in a TTY | [#198](https://github.com/breferrari/shardmind/issues/198) |
| ⬜ | Decide whether adopt gets --skip-hooks | [#199](https://github.com/breferrari/shardmind/issues/199) |
| ⬜ | Decide what a bare owner/repo install does while shardmind/registry is empty | [#200](https://github.com/breferrari/shardmind/issues/200) |
| ⬜ | Decide who keeps .shardmind/logs/ out of a vault's git history | [#201](https://github.com/breferrari/shardmind/issues/201) |

## Phase 8 — release and test tooling

Milestone: [Phase 8](https://github.com/breferrari/shardmind/milestone/9)

The release pipeline, dependencies and test harness are settled: built, or declined with evidence. Each pass decides build or decline under the take-next Declines rule, on evidence.

| | Task | Issue |
|---|---|---|
| ⬜ | Re-evaluate @inkjs/ui dependency at v0.2 scope freeze | [#43](https://github.com/breferrari/shardmind/issues/43) |
| ⬜ | release.yml: split into two pipelines (GitHub release before npm publish) | [#108](https://github.com/breferrari/shardmind/issues/108) |
| ⬜ | TUI testing framework — continuing-hardening tracker | [#122](https://github.com/breferrari/shardmind/issues/122) |
| ⬜ | Run the Layer 2 real-terminal tests on Windows under ConPTY | [#174](https://github.com/breferrari/shardmind/issues/174) |
| ⬜ | Reach the write-phase SIGINT rollback deterministically in E2E | [#186](https://github.com/breferrari/shardmind/issues/186) |

## Phase 9 — the second shard

Milestone: [Phase 9](https://github.com/breferrari/shardmind/milestone/10)

A second shard exists, and the features that wait on one are built or declined. #81 and #86 wait on a second shard in real use, so they follow #15 here.

| | Task | Issue |
|---|---|---|
| ⬜ | Research-wiki shard + E2E tests + npm publish | [#15](https://github.com/breferrari/shardmind/issues/15) |
| ⬜ | v0.2: Shard composition (multi-shard per vault) | [#81](https://github.com/breferrari/shardmind/issues/81) |
| ⬜ | v0.2: rendered_files opt-in for Nunjucks at vault-visible paths | [#86](https://github.com/breferrari/shardmind/issues/86) |

## Phase 10 — v0.2 contract

Milestone: [Phase 10](https://github.com/breferrari/shardmind/milestone/11)

Each v0.2 contract extension is built, or declined in the spec's out-of-scope list. A deferral goes to `docs/SHARD-LAYOUT.md §Out of scope` with its date, per the take-next Declines rule.

| | Task | Issue |
|---|---|---|
| ⬜ | v0.2: Guided file creation (guided_files schema + third install phase) | [#79](https://github.com/breferrari/shardmind/issues/79) |
| ⬜ | v0.2: Structural variants (modules.structure + vault_purpose) | [#80](https://github.com/breferrari/shardmind/issues/80) |
| ⬜ | v0.2: Dependency fetching (recursive + lock file) | [#82](https://github.com/breferrari/shardmind/issues/82) |
| ⬜ | v0.2: shardmind eject command | [#83](https://github.com/breferrari/shardmind/issues/83) |
| ⬜ | v0.2: shardmind init command for shard authors | [#84](https://github.com/breferrari/shardmind/issues/84) |
| ⬜ | v0.2: .shardmindignore negation (!pattern) support | [#87](https://github.com/breferrari/shardmind/issues/87) |

## Phase 11 — v1.0 ecosystem

Milestone: [Phase 11](https://github.com/breferrari/shardmind/milestone/12)

Each ecosystem item is built, or declined with the evidence on the issue. Each pass decides build or decline under the take-next Declines rule, on evidence.

| | Task | Issue |
|---|---|---|
| ⬜ | Finalize shardmind/registry index.json schema | [#29](https://github.com/breferrari/shardmind/issues/29) |
| ⬜ | Alternate registry configurability (GHE, private, custom URL) | [#39](https://github.com/breferrari/shardmind/issues/39) |
| ⬜ | v1.0: Hosted registry (shardmind.dev) + shard discovery + search | [#89](https://github.com/breferrari/shardmind/issues/89) |
| ⬜ | v1.0: Community — validation CI + shard listing + fork-to-shard guide | [#90](https://github.com/breferrari/shardmind/issues/90) |
| ⬜ | v1.0: Teams — managed vault templates + shared values + admin controls | [#91](https://github.com/breferrari/shardmind/issues/91) |

## Shelf (retired 2026-10-04)

The shelf was retired on 2026-10-04: every item on it moved into Phases 4 to 11. The deferral reasons are kept below as a record of why each item waited. They are history, not a build order.

| Item | Surfaced | Moved to | Why |
|---|---|---|---|
| Research-wiki shard + E2E tests + npm publish ([#15](https://github.com/breferrari/shardmind/issues/15)) | tracker restructure, 2026-10-03 | Shelf | Waits on Phase 1: a second shard on an update that can overwrite edits doubles who it can hurt. |
| Command namespace prefix for discoverability ([#25](https://github.com/breferrari/shardmind/issues/25)) | tracker restructure, 2026-10-03 | Shelf | The title reads as obsidian-mind command work, not engine work (unverified). Read it, then transfer or close it. |
| Topic-based meeting prep command (/prep-topic) ([#26](https://github.com/breferrari/shardmind/issues/26)) | tracker restructure, 2026-10-03 | Shelf | The title reads as obsidian-mind command work, not engine work (unverified). Read it, then transfer or close it. |
| npm publishing setup — claim-publish retry + NPM_TOKEN ([#27](https://github.com/breferrari/shardmind/issues/27)) | tracker restructure, 2026-10-03 | Shelf | Engine polish with no user report behind it. Comes back when one arrives. |
| Finalize shardmind/registry index.json schema ([#29](https://github.com/breferrari/shardmind/issues/29)) | tracker restructure, 2026-10-03 | Shelf | v1.0 ecosystem scope. Needs more than one shard in real use first. |
| Enforce tarball size cap in downloadShard ([#32](https://github.com/breferrari/shardmind/issues/32)) | tracker restructure, 2026-10-03 | Shelf | Engine polish with no user report behind it. Comes back when one arrives. |
| VaultFS abstraction with built-in rollback tracking ([#33](https://github.com/breferrari/shardmind/issues/33)) | tracker restructure, 2026-10-03 | Shelf | Engine polish with no user report behind it. Comes back when one arrives. |
| shardmind validate <shard> command ([#34](https://github.com/breferrari/shardmind/issues/34)) | tracker restructure, 2026-10-03 | Shelf | Engine polish with no user report behind it. Comes back when one arrives. |
| Pre-install template syntax lint ([#35](https://github.com/breferrari/shardmind/issues/35)) | tracker restructure, 2026-10-03 | Shelf | Engine polish with no user report behind it. Comes back when one arrives. |
| Debug logging (SHARDMIND_DEBUG env var) ([#36](https://github.com/breferrari/shardmind/issues/36)) | tracker restructure, 2026-10-03 | Shelf | Engine polish with no user report behind it. Comes back when one arrives. |
| NO_COLOR / FORCE_COLOR respect across Ink components ([#37](https://github.com/breferrari/shardmind/issues/37)) | tracker restructure, 2026-10-03 | Shelf | Engine polish with no user report behind it. Comes back when one arrives. |
| Alternate registry configurability (GHE, private, custom URL) ([#39](https://github.com/breferrari/shardmind/issues/39)) | tracker restructure, 2026-10-03 | Shelf | v1.0 ecosystem scope. Needs more than one shard in real use first. |
| Encode state-schema migration rules (uses v0.1 framework) ([#40](https://github.com/breferrari/shardmind/issues/40)) | tracker restructure, 2026-10-03 | Shelf | v0.2 scope. The contract grows after update keeps users' edits (Phase 1). Comes back when a shard author or user asks for it. |
| Re-evaluate @inkjs/ui dependency at v0.2 scope freeze ([#43](https://github.com/breferrari/shardmind/issues/43)) | tracker restructure, 2026-10-03 | Shelf | Engine polish with no user report behind it. Comes back when one arrives. |
| Drop LineInterner workaround once node-diff3 ships the prototype-lookup fix ([#49](https://github.com/breferrari/shardmind/issues/49)) | tracker restructure, 2026-10-03 | Shelf | Engine polish with no user report behind it. Comes back when one arrives. |
| $EDITOR integration for DiffView conflict resolution ([#50](https://github.com/breferrari/shardmind/issues/50)) | tracker restructure, 2026-10-03 | Shelf | Engine polish with no user report behind it. Comes back when one arrives. |
| IMPLEMENTATION.md §4.11a / §4.11b for install-planner + install-executor ([#64](https://github.com/breferrari/shardmind/issues/64)) | tracker restructure, 2026-10-03 | Shelf | Docs debt. Fold in when the module it documents next changes. |
| v0.2: Guided file creation (guided_files schema + third install phase) ([#79](https://github.com/breferrari/shardmind/issues/79)) | tracker restructure, 2026-10-03 | Shelf | v0.2 scope. The contract grows after update keeps users' edits (Phase 1). Comes back when a shard author or user asks for it. |
| v0.2: Structural variants (modules.structure + vault_purpose) ([#80](https://github.com/breferrari/shardmind/issues/80)) | tracker restructure, 2026-10-03 | Shelf | v0.2 scope. The contract grows after update keeps users' edits (Phase 1). Comes back when a shard author or user asks for it. |
| v0.2: Shard composition (multi-shard per vault) ([#81](https://github.com/breferrari/shardmind/issues/81)) | tracker restructure, 2026-10-03 | Shelf | v0.2 scope. The contract grows after update keeps users' edits (Phase 1). Comes back when a shard author or user asks for it. |
| v0.2: Dependency fetching (recursive + lock file) ([#82](https://github.com/breferrari/shardmind/issues/82)) | tracker restructure, 2026-10-03 | Shelf | v0.2 scope. The contract grows after update keeps users' edits (Phase 1). Comes back when a shard author or user asks for it. |
| v0.2: shardmind eject command ([#83](https://github.com/breferrari/shardmind/issues/83)) | tracker restructure, 2026-10-03 | Shelf | v0.2 scope. The contract grows after update keeps users' edits (Phase 1). Comes back when a shard author or user asks for it. |
| v0.2: shardmind init command for shard authors ([#84](https://github.com/breferrari/shardmind/issues/84)) | tracker restructure, 2026-10-03 | Shelf | v0.2 scope. The contract grows after update keeps users' edits (Phase 1). Comes back when a shard author or user asks for it. |
| v0.1 docs rewrite: ARCHITECTURE §3 + AUTHORING §2 + IMPLEMENTATION §4.* / §9 per v6 layout ([#85](https://github.com/breferrari/shardmind/issues/85)) | tracker restructure, 2026-10-03 | Shelf | Docs debt. Fold in when the module it documents next changes. |
| v0.2: rendered_files opt-in for Nunjucks at vault-visible paths ([#86](https://github.com/breferrari/shardmind/issues/86)) | tracker restructure, 2026-10-03 | Shelf | v0.2 scope. The contract grows after update keeps users' edits (Phase 1). Comes back when a shard author or user asks for it. |
| v0.2: .shardmindignore negation (!pattern) support ([#87](https://github.com/breferrari/shardmind/issues/87)) | tracker restructure, 2026-10-03 | Shelf | v0.2 scope. The contract grows after update keeps users' edits (Phase 1). Comes back when a shard author or user asks for it. |
| v1.0: Hosted registry (shardmind.dev) + shard discovery + search ([#89](https://github.com/breferrari/shardmind/issues/89)) | tracker restructure, 2026-10-03 | Shelf | v1.0 ecosystem scope. Needs more than one shard in real use first. |
| v1.0: Community — validation CI + shard listing + fork-to-shard guide ([#90](https://github.com/breferrari/shardmind/issues/90)) | tracker restructure, 2026-10-03 | Shelf | v1.0 ecosystem scope. Needs more than one shard in real use first. |
| v1.0: Teams — managed vault templates + shared values + admin controls ([#91](https://github.com/breferrari/shardmind/issues/91)) | tracker restructure, 2026-10-03 | Shelf | v1.0 ecosystem scope. Needs more than one shard in real use first. |
| release.yml: split into two pipelines (GitHub release before npm publish) ([#108](https://github.com/breferrari/shardmind/issues/108)) | tracker restructure, 2026-10-03 | Shelf | Engine polish with no user report behind it. Comes back when one arrives. |
| TUI testing framework — continuing-hardening tracker ([#122](https://github.com/breferrari/shardmind/issues/122)) | tracker restructure, 2026-10-03 | Shelf | Engine polish with no user report behind it. Comes back when one arrives. |
| Declare & enforce external CLI tool dependencies (e.g. qmd) with version ranges at install/update ([#138](https://github.com/breferrari/shardmind/issues/138)) | tracker restructure, 2026-10-03 | Shelf | Engine polish with no user report behind it. Comes back when one arrives. |
| Agent/headless ergonomics: non-interactive mode, JSON output, per-file plan, value detection ([#139](https://github.com/breferrari/shardmind/issues/139)) | tracker restructure, 2026-10-03 | Shelf | Engine polish with no user report behind it. Comes back when one arrives. |
| Make the test suite independent of FORCE_COLOR ([#159](https://github.com/breferrari/shardmind/issues/159)) | #147 pass, 2026-10-03 | Shelf | A defect in the test harness, not a product pass: CI does not set `FORCE_COLOR`, so it stays green; locally `env -u FORCE_COLOR npm test` works around it. |
| Let the update prompt track a kept add-collision file per file ([#165](https://github.com/breferrari/shardmind/issues/165)) | #61 pass, 2026-10-03 | Shelf | `--adopt-preexisting` stops the `--yes` churn #61 reported; a per-file choice is a prompt redesign with no user report behind it. |
| Apply a shard release that only changes a file's case ([#169](https://github.com/breferrari/shardmind/issues/169)) | #163 review, 2026-10-04 | Shelf | The #163 guard refuses it on macOS and Windows instead of losing the file; no shard has shipped a case-only rename. |
| Merge files with many repeated lines in less than cubic time ([#170](https://github.com/breferrari/shardmind/issues/170)) | #114 pass, 2026-10-04 | Shelf | Measured near-cubic in node-diff3 on repeated lines; a faster LCS must prove it changes no merge, and no vault has hit it. |
| Run the Layer 2 real-terminal tests on Windows under ConPTY ([#174](https://github.com/breferrari/shardmind/issues/174)) | split from #57, 2026-10-04 | Shelf | #57 covered the non-PTY SIGINT scenarios; ConPTY parity for node-pty scenarios has no Windows user report behind it. |
| Align the RELEASE-SMOKE cancellation rows with the engine ([#155](https://github.com/breferrari/shardmind/issues/155)) | v0.1.7 release smoke, 2026-10-03 | Shelf | A defect in a gate, not a product pass. Both behaviours predate 0.1.7 and the smoke table records them as deviations; the wizard exit code is a product question to decide first. |

## Pull-forward log

Items taken from the Shelf ahead of the phases. Recorded so that movement is visible.

| Item | Moved | Why |
|---|---|---|
| All 39 Shelf items | Shelf → Phases 4 to 11, 2026-10-04 | The shelf is retired. Every open issue sits in an ordered phase, so the loop reaches all of it, and a pass that judges an item not worth building declines it with evidence. |

---

## Principles

**Ship the engine, not the platform.** v0.1 has no registry server, no web UI, no accounts. The engine (install, update, merge) is the value. Everything else follows.

**Convention over configuration.** 4 values, 3 commands. The vault ships complete. Users subtract, not add.

**Prove with obsidian-mind first.** The flagship shard must be indistinguishable from a git clone before any other shard matters. If the install experience is worse than `git clone`, nothing else matters.

**The moat is the update engine.** Every feature decision should be evaluated against: "does this make upgrades better?" If not, it can wait.

**Agent-agnostic engine, agent-specific shards.** ShardMind renders templates. Shard authors decide which AIs to support. Don't couple the engine to any agent.

**Invariant 1 is law.** `shardmind install --defaults <shard>` produces a vault byte-equivalent to `git clone <shard>` (modulo Tier 1 exclusions + `.shardmind/` engine metadata + vault-root `shard-values.yaml`). If CI catches a diff, the shard or the engine is wrong.

---

## Non-Goals (Permanent)

These are not on any roadmap version. They represent scope boundaries.

- **GUI for ShardMind itself.** The CLI + TUI is the product. A web UI for managing shards adds complexity without value for the developer audience.
- **Non-Obsidian targets.** Logseq, Notion, etc. have fundamentally different file formats. Supporting them would dilute the engine.
- **AI in the engine.** ShardMind is a package manager. It doesn't read note content, classify semantically, or make AI-powered decisions. That's the shard's job (via hooks and agents). The engine is deterministic.
- **Paid tiers on ShardMind itself.** The engine is MIT. The business (if it becomes one) is managed team templates, not CLI licensing.


---

## History

The roadmap as it stood until 2026-10-03, verbatim with its headings one level down. Its checkboxes record that date. Open state lives in the phase and Shelf tables above.

### v0.1.0 — The Engine (April 2026, **shipped on npm**)

Ship the core: install, update, status. Prove that vault template upgrades work where every other tool failed. The engine surface (install / update / adopt / status / runtime / hooks) shipped as `shardmind@0.1.0` on 2026-04-26 with 862 tests covering the full v6 contract (install / update / adopt / additive principle / hook failure / adversarial). The flagship shard registry index + research-wiki shard land in **v0.1.x** (see below).

#### Milestone 1: Foundation (Day 1) — shipped

- [x] Scaffold with `create-pastel-app` ([#1](https://github.com/breferrari/shardmind/issues/1))
- [x] `source/core/manifest.ts` — parse + validate shard.yaml with zod ([#2](https://github.com/breferrari/shardmind/issues/2))
- [x] `source/core/schema.ts` — parse shard-schema.yaml, generate dynamic zod validator ([#3](https://github.com/breferrari/shardmind/issues/3))
- [x] `source/core/download.ts` — fetch GitHub tarball, extract to temp dir ([#4](https://github.com/breferrari/shardmind/issues/4))
- [x] `source/core/renderer.ts` — Nunjucks engine, frontmatter-aware split/render/recombine ([#5](https://github.com/breferrari/shardmind/issues/5))
- [x] `source/core/modules.ts` — walk template dir, classify by module, resolve file lists ([#6](https://github.com/breferrari/shardmind/issues/6))
- [x] `source/runtime/types.ts` + `runtime/index.ts` — shared types and exports ([#7](https://github.com/breferrari/shardmind/issues/7))
- [x] CI/CD — GitHub Actions for typecheck, test, build, npm publish ([#16](https://github.com/breferrari/shardmind/issues/16))
- [x] Unit tests: manifest, schema, renderer (5 fixture scenarios), modules
- [x] `shardmind --version` works

#### Milestone 2: Install Command (Day 2) — shipped

- [x] `source/core/state.ts` + `source/core/registry.ts` ([#9](https://github.com/breferrari/shardmind/issues/9))
- [x] `commands/install.tsx` — full install flow with Ink wizard ([#8](https://github.com/breferrari/shardmind/issues/8))
- [x] Integration test: install pipeline against `examples/minimal-shard` (real obsidian-mind shard verified at Milestone 5)
- [x] `ink-testing-library` component tests for ValueInput, ModuleReview, ExistingInstallGate, InstallWizard ([#38](https://github.com/breferrari/shardmind/issues/38) — pulled forward from v0.2)

#### Milestone 3: Merge Engine (Day 3) — shipped

- [x] Write all 17 merge fixture directories — fixtures before code ([#10](https://github.com/breferrari/shardmind/issues/10))
- [x] `core/drift.ts` + `core/differ.ts` — three-way merge engine ([#11](https://github.com/breferrari/shardmind/issues/11))
- [x] Iterate until all 17 scenarios pass
- [x] Add edge case fixtures: empty file (18), UTF-8 non-ASCII (19), frontmatter merge on modified ownership (20). Hash-identical behavior already covered by scenarios 01 and 05

#### Milestone 4: Update Command + Status (Day 4) — shipped

- [x] `commands/update.tsx` — upgrade flow with drift detection + DiffView ([#12](https://github.com/breferrari/shardmind/issues/12))
- [x] `commands/index.tsx` — status display + `--verbose` diagnostics ([#13](https://github.com/breferrari/shardmind/issues/13))
- [x] Integration test: install → modify files → update → verify merge behavior
- [x] E2E test: all 3 commands via CLI invocation ([#54](https://github.com/breferrari/shardmind/issues/54))

#### Milestone 4.5: v6 Layout Integration — **active** (tracked in [#70](https://github.com/breferrari/shardmind/issues/70))

Engine rework required by the v6 shard-layout contract. Must land before Milestone 5. Spec: [`docs/SHARD-LAYOUT.md`](docs/SHARD-LAYOUT.md).

- [x] Flat shard-root walk + Tier 1 exclusions + `.shardmindignore` parser ([#73](https://github.com/breferrari/shardmind/issues/73))
- [x] Schema defaults enforcement + drop `partials` field ([#74](https://github.com/breferrari/shardmind/issues/74))
- [x] `HookContext` extensions (`valuesAreDefaults`, `newFiles`, `removedFiles`) + post-hook re-hash ([#75](https://github.com/breferrari/shardmind/issues/75))
- [x] Ref installs (`github:owner/repo#<ref>`) + update semantics (`--release`, `--include-prerelease`, ref re-resolution) ([#76](https://github.com/breferrari/shardmind/issues/76))
- [x] `shardmind adopt` command (2-way diff UI + adopt-planner + adopt-executor) ([#77](https://github.com/breferrari/shardmind/issues/77))
- [x] `install --defaults` flag + **Invariant 1 byte-equivalence CI test** ([#78](https://github.com/breferrari/shardmind/issues/78))
- [x] **Contract acceptance suite** — full install / update (no-conflict + with-conflict) / adopt / additive-principle / hook-failure / adversarial scenario matrix ([#92](https://github.com/breferrari/shardmind/issues/92))

#### Milestone 5: Flagship Shard (Day 5) — shipped

- [x] obsidian-mind v6 conversion — `.shardmind/` sidecar, hooks, `.shardmindignore` ([#14](https://github.com/breferrari/shardmind/issues/14), under [#70](https://github.com/breferrari/shardmind/issues/70))
- [x] Finalize post-install hook runtime ([#30](https://github.com/breferrari/shardmind/issues/30))
- [x] Verify: `shardmind install github:breferrari/obsidian-mind` (direct mode) produces a vault byte-equivalent to git clone under Invariant 1 ([#78](https://github.com/breferrari/shardmind/issues/78))

#### Milestone 6: Ship (Day 6) — engine shipped 0.1.0; registry + second shard moved to v0.1.x

The engine artifact (`shardmind@0.1.0`) shipped on npm on 2026-04-26. The remaining Milestone 6 deliverables (research-wiki shard, registry index, fresh-machine smoke) move to the **v0.1.x stabilization track** below — they're follow-on work, not blockers for the engine being usable.

---

### v0.1.x — Stabilization (active)

The engine shipped at 0.1.0 with the v6 contract covered end-to-end against fixtures. Two consecutive 0.1.x hotfixes ([#103](https://github.com/breferrari/shardmind/issues/103) → 0.1.1, [#109](https://github.com/breferrari/shardmind/issues/109) → 0.1.2) shipped because the 870-test suite at each release measured the wrong axis: deep engine + widget coverage, zero "real user flow against the actual shard" coverage. The `--yes`/`--defaults` E2E tests bypass the wizard entirely; per-component tests verified single-mount behavior but never modeled production's iteration shape. **The two issues at the top of this list close that measurement gap before any further interactive UX work ships.**

#### 0.1.1 — Hotfix — shipped

The select-Enter bug blocked any shard whose schema had a `select` value with `default = first option` — including obsidian-mind. Mechanical fix (drop `defaultValue`, reorder options); regression test pinned the failure mode.

- [x] Wizard select stuck on Enter when default = first option ([#103](https://github.com/breferrari/shardmind/issues/103))

#### 0.1.2 — Hotfix — shipped

Iterated diff-review prompts (`shardmind adopt`, `shardmind update`) froze after the first decision because `firedRef` leaked across files when the parent advanced state without a `key` prop. Surfaced one prompt later than #103 on the same flagship adopt run. Beyond the fix, the PR extracted `useOncePerKey` into a reusable hook, codified Patterns A/B in [`docs/COMPONENTS.md`](docs/COMPONENTS.md), and added a binding `CLAUDE.md` §Testing rule that iterated-component regression tests via `rerender()` are mandatory.

- [x] Iterated diff-review menus freeze after the first decision (firedRef leaks across files) ([#109](https://github.com/breferrari/shardmind/issues/109))

#### 0.1.x — Foundation — **BLOCKING** all interactive 0.1.x work below

Two tickets stop bad releases from shipping. Both are top priority and ship before any further wizard / diff-prompt UX work.

- **TUI end-to-end testing framework** — three layers (command-level component, real-PTY, status-quo subprocess), 28 scenarios covering wizard, multi-file diff review, module review, hooks, cancellation, validation ([#111](https://github.com/breferrari/shardmind/issues/111)). All three phases shipped; parent issue closed. Continuing-hardening tracker: [#122](https://github.com/breferrari/shardmind/issues/122).
  - [x] **Phase 1** — Layer 1 command-level flow tests (22 scenarios across install / update / adopt / status), shipped under `tests/component/flows/`. Closes the regression matrix #103 and #109 fell through and unblocks the Flagship UX stabilization tickets below.
  - [x] **Phase 2** — Layer 2 real-PTY scenarios via `node-pty` + `@xterm/headless` (6 scenarios marked L2 in [#111](https://github.com/breferrari/shardmind/issues/111)'s matrix + 3 hook scenarios 26-28). Catches SIGINT delivery, ANSI rendering, raw-mode quirks that only surface under a real PTY. Shipped under `tests/e2e/tui/`; macOS + Linux only (Windows skipped — tracked via [#174](https://github.com/breferrari/shardmind/issues/174)).
  - [x] **Phase 3** — TUI testing framework extensibility validated under hostile contributor scenarios (double-dispose, late-PTY-data, wedged-child + signal-name mapping, fixture-shard mutate-throw cleanup at both layers) plus a contributor section in `docs/ARCHITECTURE.md §19.7` ("Adding a TUI scenario"). Closes the parent issue: every acceptance criterion satisfied across Phases 1+2+3. Future TUI scenarios are mechanical to add — see the contributor section.
- [x] **Pre-release manual smoke gate** — [`RELEASE-SMOKE.md`](RELEASE-SMOKE.md) checklist + binding [`CLAUDE.md` §Release Process](CLAUDE.md#release-process) rule that `npm run release:*` does not run without a completed smoke table pasted into the release tag body ([#112](https://github.com/breferrari/shardmind/issues/112)). Scope shrank with #111 closing the engine matrix in CI: the gate now covers only what fixtures can't reach — the published npm tarball, the live flagship shard, real-GitHub fetch, and Ctrl+C against the live shard. Relaxes when CI installs the npm tarball + drives a recorded flagship snapshot (see [`RELEASE-SMOKE.md §When the gate may relax`](RELEASE-SMOKE.md#when-the-gate-may-relax)).

#### 0.1.x — Parallel (ships alongside the flagship-UX track, not before it)

Demoted from "Foundation BLOCKING" on 2026-04-27 (see [#113 comment](https://github.com/breferrari/shardmind/issues/113#issuecomment-4323200504)): with [#112](https://github.com/breferrari/shardmind/issues/112) preventing broken releases from shipping, the self-update notifier is defense-in-depth, not a prerequisite. High priority but not a hard blocker on the flagship-UX track.

- [x] **Self-update notifier** — every command checks the npm registry once per 24h (cached) and prints a one-line banner when a newer `shardmind` is available. Silent on fetch failure; opt-out via `--no-update-check`, `SHARDMIND_NO_UPDATE_CHECK`, or `CI` env var. Ships in the same release window as the first flagship-UX item, but does not block its start ([#113](https://github.com/breferrari/shardmind/issues/113)).
- [x] **Release cadence policy** — three categories pinned in [`RELEASE-SMOKE.md §Release cadence`](RELEASE-SMOKE.md#release-cadence): hotfix (single-issue, same-day, branched off the previous tag); UX (2–4 issues bundled, weekly at most); foundation (own patch each, smoke-tested). Cross-referenced from [`CLAUDE.md §Release Process`](CLAUDE.md#release-process). 0.1.0/0.1.1/0.1.2 retroactively classified in `CHANGELOG.md`. v0.1.3 ships as the first patch under the policy ([#119](https://github.com/breferrari/shardmind/issues/119)).

#### 0.1.x — Hook lifecycle (breaking change)

[#102](https://github.com/breferrari/shardmind/issues/102) was previously listed as a peer to #100 (wizard scroll) and #101 (multiselect) in the flagship-UX list. It is not a peer — it deprecates the `post-install` hook (which obsidian-mind v6.0 ships with), changes Invariants 2 + 3 from comment-checked to engine-checked, requires a `docs/SHARD-LAYOUT.md` spec update, and forces every shard author to migrate. Reclassified as a single-issue release block on 2026-04-27.

- [ ] **Hook lifecycle split — bootstrap / personalize / post-update** ([#102](https://github.com/breferrari/shardmind/issues/102)). Engine + fixture + docs landed in PR (the three-slot orchestrator, detect-and-warn boundaries, engine-enforced Invariant 2, bootstrap fingerprint, legacy deprecation); issue stays open pending the release-window items below. Acceptance:
  - [x] [#121](https://github.com/breferrari/shardmind/issues/121) (engine version-compatibility check) lands first or in the same release.
  - [x] `docs/SHARD-LAYOUT.md` updated with the new lifecycle.
  - [x] `docs/AUTHORING.md` documents the migration path with a worked example.
  - [ ] obsidian-mind hook migration ships in the same release window (cross-repo coupling — see Cross-repo dependencies below).
  - [x] Deprecation period for `post-install` documented in CHANGELOG; honored for at least one minor version.

#### 0.1.x — Flagship UX stabilization (Foundation green, ready to start)

UX gaps surfaced during real obsidian-mind v6 install + adopt runs. None block the engine; each materially improves first-run experience for the flagship and any shard that triggers the same code path. **Each of these touches the wizard or a diff prompt — the exact surface where #103 / #109 lived. No release containing them ships until the smoke gate ([`RELEASE-SMOKE.md`](RELEASE-SMOKE.md), [#112](https://github.com/breferrari/shardmind/issues/112)) has been run against `breferrari/obsidian-mind`.** [#102](https://github.com/breferrari/shardmind/issues/102) was previously listed here; now its own section above (Hook lifecycle).

- [x] Wizard scroll indicator + boolean prompt consistency (Y/n typed input → selectable Yes/No) ([#100](https://github.com/breferrari/shardmind/issues/100)) — smallest item, recommended starting point.
- [x] `multiselect` value type for module-set questions ([#101](https://github.com/breferrari/shardmind/issues/101)) — pairs with #100 (shortens module list). First-class value type + scrollable widget + per-option `default` + min/max; value→module gating stays #80.
- [x] Adopt: replace step-by-step install wizard with confirm-or-override values flow ([#104](https://github.com/breferrari/shardmind/issues/104))
- [x] Adopt batch operations (keep all mine / use all theirs / auto-merge non-conflicting) ([#120](https://github.com/breferrari/shardmind/issues/120)) — pairs with #104.
- [x] Hook stderr presentation in Summary (truncate, dim, label as non-fatal) ([#105](https://github.com/breferrari/shardmind/issues/105))

#### 0.1.x — Done gate

v0.1.x ships when:
- [x] Foundation closed: [#111](https://github.com/breferrari/shardmind/issues/111) ✅, [#112](https://github.com/breferrari/shardmind/issues/112) ✅.
- [x] Parallel closed: [#113](https://github.com/breferrari/shardmind/issues/113) (self-update notifier), [#119](https://github.com/breferrari/shardmind/issues/119) (release cadence policy).
- [ ] Hook lifecycle (#102) shipped with [#121](https://github.com/breferrari/shardmind/issues/121) (version-compatibility check) and obsidian-mind hook migration in the same release window.
- [x] Flagship-UX closed: [#100](https://github.com/breferrari/shardmind/issues/100), [#101](https://github.com/breferrari/shardmind/issues/101), [#104](https://github.com/breferrari/shardmind/issues/104), [#105](https://github.com/breferrari/shardmind/issues/105), [#120](https://github.com/breferrari/shardmind/issues/120).
- [ ] Research-wiki shard ([#15](https://github.com/breferrari/shardmind/issues/15)) shipped with E2E tests + registry-mode end-to-end proof.
- [x] v6 docs polish ([#85](https://github.com/breferrari/shardmind/issues/85)) closed (superseded: SHARD-LAYOUT.md stays the contract; the stale text was rewritten with #64).
- [ ] Smoke gate green against both shards (obsidian-mind + research-wiki).

When all boxes check, cut the v0.1.x stabilization line and start v0.2.

#### 0.1.x — Cross-repo dependencies

Items where shardmind work blocks (or is blocked by) work in other repos. Track here so a planner reading either side has visibility.

- [#88](https://github.com/breferrari/shardmind/issues/88) (rename migrations + `adopt --from-version`) blocks `breferrari/obsidian-mind#71` (v6.x rename track). Until #88 ships, obsidian-mind cannot rename managed-file paths without breaking installed users. Shipped with #178 (update) and #179 (adopt).
- [#102](https://github.com/breferrari/shardmind/issues/102) (hook lifecycle split) requires obsidian-mind to migrate its hook from `post-install` to the new lifecycle, tracked at [`breferrari/obsidian-mind#75`](https://github.com/breferrari/obsidian-mind/issues/75). Both must ship in the same release window.
- [#121](https://github.com/breferrari/shardmind/issues/121) (engine version-compatibility check) precedes any shard that declares `shardmind_version` requirements. obsidian-mind should add the field as soon as #121 ships.

#### 0.1.x — Deferred from Milestone 6

Not blockers for engine use, but needed before the registry-mode flow (`shardmind install owner/repo`) works end-to-end and before a second flagship-quality shard exists.

- [ ] **Research-wiki shard + E2E tests** ([#15](https://github.com/breferrari/shardmind/issues/15)) — including the fresh-machine smoke (`npm install -g shardmind` → `shardmind install breferrari/obsidian-mind` and `shardmind install <research-wiki>`). Single tracker; covers the second-shard build, registry-mode end-to-end proof, and registry shape validation.
- [ ] Create `shardmind/registry` repo with index.json (2 shards). Schema discussion lives in #29 (closed) and is finalized as part of this work; no separate ticket.
- [x] v6 docs polish: fold remaining SHARD-LAYOUT.md content into ARCHITECTURE §3 + IMPLEMENTATION §4.5/§4.5a/§4.5b; rewrite IMPLEMENTATION §9 (Build Plan) to match the actual #70 task series ([#85](https://github.com/breferrari/shardmind/issues/85)) — partial rewrites already landed with #73. Superseded 2026-10-04: SHARD-LAYOUT.md stays as the contract preflight checks against, and the stale v6 text was rewritten with #64

---

### v0.2.0 — Composition & Polish (Q2–Q3 2026)

Deferred from v0.1 per [`docs/SHARD-LAYOUT.md §Out of scope`](docs/SHARD-LAYOUT.md#out-of-scope--deferred-to-v02) + [`VISION.md §Current Priorities`](VISION.md). Build only after v0.1 is stable and adoption signals are real. Each feature has an umbrella issue tracking its sub-tasks.

#### Core features

Ordered by cost ascending. Sizes are rough — small (≤1 PR), medium (2–4 PRs), large (5+ PRs touching multiple subsystems), anchor (multi-month, rideable releases on top).

- [x] **small** — Engine version-compatibility check on install ([#121](https://github.com/breferrari/shardmind/issues/121)). Landed in the v0.1.x #102 release window (`requires.shardmind` + `SHARDMIND_VERSION_MISMATCH`, enforced on install/update/adopt).
- [ ] **small** — `shardmind eject` command ([#83](https://github.com/breferrari/shardmind/issues/83))
- [ ] **medium** — `shardmind init` command for shard authors ([#84](https://github.com/breferrari/shardmind/issues/84))
- [ ] **medium** — Guided file creation (`guided_files` schema + third install phase) ([#79](https://github.com/breferrari/shardmind/issues/79))
- [ ] **medium** — Structural variants (`modules.structure` + `vault_purpose`) ([#80](https://github.com/breferrari/shardmind/issues/80))
- [ ] **large** — Dependency fetching (recursive + lock file) ([#82](https://github.com/breferrari/shardmind/issues/82))
- [ ] **anchor** — Shard composition (multi-shard per vault) ([#81](https://github.com/breferrari/shardmind/issues/81)). Touches state, planner, executor, conflicts, runtime, hooks. Plan the v0.2 release schedule around this; smaller items ride alongside.

#### Layout / contract extensions (deferred from v0.1)

Tracked in [`docs/SHARD-LAYOUT.md §Out of scope`](docs/SHARD-LAYOUT.md#out-of-scope--deferred-to-v02).

- [ ] `rendered_files` opt-in (Nunjucks at vault-visible paths) ([#86](https://github.com/breferrari/shardmind/issues/86))
- [ ] `.shardmindignore` negation (`!pattern`) ([#87](https://github.com/breferrari/shardmind/issues/87))
- [x] Rename migrations + `shardmind adopt --from-version` — **must ship before any obsidian-mind release that introduces path renames** ([#88](https://github.com/breferrari/shardmind/issues/88))

#### Engine polish (from v0.1 review)

Deferred items surfaced during the v0.1 polish-pass architecture audit. None are blockers for shipping v0.1; all are worth doing before v0.2 marketing.

- [x] ~~VaultFS abstraction with built-in rollback tracking~~ declined ([#33](https://github.com/breferrari/shardmind/issues/33))
- [ ] `shardmind validate <shard>` command ([#34](https://github.com/breferrari/shardmind/issues/34))
- [ ] Pre-install template syntax lint ([#35](https://github.com/breferrari/shardmind/issues/35))
- [x] ~~Debug logging (`SHARDMIND_DEBUG` env var)~~ declined ([#36](https://github.com/breferrari/shardmind/issues/36))
- [ ] `NO_COLOR` / `FORCE_COLOR` respect across Ink components ([#37](https://github.com/breferrari/shardmind/issues/37))
- [ ] Alternate registry configurability (GHE, private, custom URL) ([#39](https://github.com/breferrari/shardmind/issues/39))
- [x] Encode state-schema migration rules (uses v0.1 framework) ([#40](https://github.com/breferrari/shardmind/issues/40))
- [ ] Re-evaluate `@inkjs/ui` dependency ([#43](https://github.com/breferrari/shardmind/issues/43))
- [x] Drop `LineInterner` workaround once `node-diff3` releases the prototype-lookup fix ([#49](https://github.com/breferrari/shardmind/issues/49))
- [ ] `$EDITOR` integration for DiffView conflict resolution ([#50](https://github.com/breferrari/shardmind/issues/50))
- [x] 24h update-check cache shared between status + update ([#51](https://github.com/breferrari/shardmind/issues/51) — shipped with #13)
- [x] DiffView: distinguish preexisting add-collision from modified-file conflict ([#60](https://github.com/breferrari/shardmind/issues/60))
- [x] `--yes` policy for preexisting add-collisions ([#61](https://github.com/breferrari/shardmind/issues/61))
- [x] Byte-identical preexisting add-collision adopts silently ([#62](https://github.com/breferrari/shardmind/issues/62))
- [x] Binary files bypass three-way merge entirely ([#63](https://github.com/breferrari/shardmind/issues/63))
- [x] `docs/IMPLEMENTATION.md` §4.11a / §4.11b for install-planner + install-executor ([#64](https://github.com/breferrari/shardmind/issues/64))
- [ ] Enforce tarball size cap in `downloadShard` ([#32](https://github.com/breferrari/shardmind/issues/32))
- [x] `--force` flag on install for scripted collision overwrite without backup ([#55](https://github.com/breferrari/shardmind/issues/55))
- [ ] E2E: bridge SIGINT delivery reliably on GH Actions Windows runner ([#57](https://github.com/breferrari/shardmind/issues/57))
- [ ] Hook-runner pre-throw stdout dropped under parallel CPU pressure (test-only flake; `process.exit()` race vs piped buffer) ([#106](https://github.com/breferrari/shardmind/issues/106))
- [ ] Split `release.yml` into two pipelines — GitHub Release (reversible) before npm publish (irreversible) ([#108](https://github.com/breferrari/shardmind/issues/108))
- [ ] Flaky test: `merge-adversarial 10K-lines tokenize` times out under parallel pressure ([#114](https://github.com/breferrari/shardmind/issues/114)) — retroactive `/take-next` §4 three-condition review documented [in the issue](https://github.com/breferrari/shardmind/issues/114#issuecomment-4323200506); deciding factor is whether the fix is a timeout bump (close as fix-in-PR) or algorithmic (keep deferred). Investigate scope before next `tests/unit/` touch.

---

### v1.0.0 — Ecosystem (2026–2027)

Only after the engine is proven, the flagship shard is stable, and community shards exist. Each area has a parent umbrella issue; sub-tasks detailed as scoping begins.

#### Registry (hosted) ([#89](https://github.com/breferrari/shardmind/issues/89))

- [ ] Hosted registry (shardmind.dev) with shard discovery and search
- [ ] Shard metadata indexing from GitHub repos
- [ ] Version history and changelog display
- [ ] `shardmind search` command

#### Community ([#90](https://github.com/breferrari/shardmind/issues/90))

- [x] Shard authoring guide ([`docs/AUTHORING.md`](docs/AUTHORING.md), shipped in v0.1 polish pass)
- [ ] Shard validation CI (GitHub Action for shard authors)
- [ ] Community shard listing
- [ ] Fork-to-shard conversion guide (for obsidian-mind fork authors)

#### Teams (if demand signals appear) ([#91](https://github.com/breferrari/shardmind/issues/91))

- [ ] Managed vault templates for organizations
- [ ] Shared values with org-level defaults
- [ ] Admin controls for module enforcement
- [ ] Team sync for `brain/` namespaces

### Closed and not named above

Issues closed before 2026-10-03 that the checkbox list never linked, listed so every issue has a place in this file.

- [#47](https://github.com/breferrari/shardmind/issues/47) core/drift.ts — orphan detection (v0.2) (closed)
- [#67](https://github.com/breferrari/shardmind/issues/67) Branch/ref install: `github:owner/repo#<ref>` syntax (closed)
- [#69](https://github.com/breferrari/shardmind/issues/69) Shard-source layout: support `.shardmind/` prefix for manifest + schema + hooks (closed)
- [#132](https://github.com/breferrari/shardmind/issues/132) bug: update renders copy-origin files through Nunjucks in three-way merge (crash on literal {{, silent substitution) (closed)
- [#136](https://github.com/breferrari/shardmind/issues/136) Layer-1 flow tests flake under heavy parallel CPU load (event-loop starvation) (closed)
- [#140](https://github.com/breferrari/shardmind/issues/140) YAML files lose all comments and quoting when rendered on install (closed)
- [#144](https://github.com/breferrari/shardmind/issues/144) E2E build guard has no timeout or retry — a contended tsup build skips the whole file (closed)
