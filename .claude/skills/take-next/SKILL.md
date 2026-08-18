---
name: take-next
description: Take the next task from ROADMAP.md and ship it end to end. Use when starting work with no specific task named, or when the user says "take next", "next task", "what's next and do it", or "keep going". Enforces one issue per pass, the Working Agreement gates, and a recorded trail.
---

# take-next

Take **one** task from `ROADMAP.md` and carry it to done. Not part of a task, not three tasks, not a survey of what could be done.

Ported from the vigia repo's skill of the same name, adapted to this repo's shape: selection reads roadmap checkboxes rather than milestones, and the quality gates are `CLAUDE.md §Working Agreement` — which this file references and does not restate, so the two cannot drift. The original was once lost in a machine migration because it lived in an unversioned global directory; it lives in the repo for that reason. Do not move it out.

> [!IMPORTANT]
> **Run this to the end. After the plan is approved, do not stop to ask.**
>
> The line is **what** versus **how**. What gets built is settled in the plan,
> where a question is free. Everything after is execution: where a choice is
> documented, take the documented one and say so in the report; where a choice
> is genuinely open and nobody is there, take the conservative branch and flag
> it in the report. The review instruments in step 6 are **pre-authorized by
> this invocation**, including the parallel agents they spawn.
>
> Three things still stop the pass: a finding that contradicts
> `docs/SHARD-LAYOUT.md` (spec-before-code says fix the spec first, but a
> *contradiction* needs a decision), discovering the task is really two tasks,
> and anything destructive outside the branch. Nothing else does.

## 1. Find your place

```sh
git fetch -q origin
git show origin/main:ROADMAP.md | awk '/^- \[ \]/ { print; exit }'
```

The roadmap is ordered — versions top to bottom, milestones inside them — so the first unchecked row in file order **is** the next task. Open its linked issue and read scope + acceptance before anything else. A row with no `#N` link is itself a finding: the roadmap's own header promises every item links to an issue.

**Read from `origin/main`, never the working tree.** A checkout with a topic branch active compares branch state against the live tracker; on vigia that closed an issue on the strength of a line that was not merged.

### Pre-flight: does the roadmap still agree with the tracker?

Three commands gather the state; you do the comparing:

```sh
git show origin/main:ROADMAP.md | grep -nE '^- \[[ x]\] .*#[0-9]+'
gh issue list --state all --limit 200 --json number,title,state
gh pr list --state open --json number,title,headRefName
```

Four comparisons. Any hit is a finding to fix **in this pass**, not a note:

1. **Checked-but-open** — a `[x]` row whose issue is still open. Someone shipped and did not close, or checked a box early.
2. **Unchecked-but-closed** — a `[ ]` row whose issue is closed. The work landed and the roadmap is stale; step 1 will hand the next session a finished task.
3. **Unlinked row** — a roadmap item with no issue reference. It cannot be verified done by anything but a self-report, which is the exact thing the roadmap header refuses.
4. **Orphan issue** — an open issue no roadmap row names. It is invisible to step 1 and will never be selected however long it sits.
5. **In-flight** — an open PR already references the selected issue. Another session may be mid-flight; two sessions on one task is worse than one session idle.

## 2. Load the why before touching code

**Read the repo first, in the §5 Session-hygiene order**: `CLAUDE.md`, the roadmap row, the linked issue, then the relevant `docs/SHARD-LAYOUT.md` section. The spec is authoritative over `ARCHITECTURE.md` / `IMPLEMENTATION.md` where they conflict.

Then reach outside it, through the `vigil` MCP server, for what the repo deliberately does not hold: the strategic context that cannot be public, lessons that generalise past this repo, and decisions that predate the code. `search` the decision you are about to touch; `recall` accumulated constraints — empty early, and empty is not evidence of none.

## 3. Plan it, in plan mode, before touching code

**No code before an approved plan.** The plan is the only artifact the finished work can be audited against; `/harden`'s plan-fidelity phase skips when no written plan exists, so skipping the plan silently disables the gate that catches under-delivery.

The plan must:

- **Name what it stands on** — the spec sections, recorded decisions from `search`/`recall`, and anything found that argues against the approach.
- **Name its premises** in a short ledger: what must be true, how it would be falsified, and the answer with its source — measured, read in source, or recorded. **A load-bearing premise is not allowed to stay `assumed`; go and find out.** On vigia an invariant honestly cited and applied to the wrong operation hid a 442ms→9ms path until someone pushed back twice.
- **Be diffable** — modules and signatures, the tests by name and assertion, adversarial cases per §3 of the Working Agreement, deviations from the spec named upfront, scope-outs explicit. "Fix the thing" survives any audit precisely because it promised nothing.
- **Fit one fresh context.** Could a fresh session hold the whole issue — spec sections, changed files, new tests — and still have room to reason? If honestly no, the issue is two issues: split the **issue**, give each child a complete verifiable path, and name the blocker edge. Measured on vigia: the day an oversized issue was split in three, throughput went from 2 PRs/day at ~2,900 avg additions to 11 at ~530 — same gates. The audit is a bad place to learn the scope was wrong, because by then the rounds are already paid for.
- **A wide refactor is the exception**: one mechanical change whose blast radius fans across the codebase cannot land in green slices. Sequence it expand-then-contract — new form beside old, call sites migrated in batches sized by blast radius (each its own issue, blocked by the expand), old form deleted last. Do not force that shape onto ordinary work.
- **Outlive the session.** Comment the plan on the issue before implementing; carry it into the PR body at PR time. A plan that lives only in the conversation dies at the next compaction.

## 4. Ship it

The Working Agreement is the law here and it is not restated: **§1 spec before code, §2 tests before implementation (fixtures first for merge-engine-class work), §3 adversarial cases enumerated before coding, §7 commit hygiene** — a PR is a sequence of small self-consistent commits, five is normal, one mega-commit is wrong. Two rules from the vigia port that §1–§7 do not carry:

- **The unit is the issue.** One issue, one branch, one PR (§6 says this too). If the work surfaces something in scope, fix it here; a new issue is for something genuinely out of scope, and it gets a roadmap row in the same commit that files it — an unlinked issue is invisible to step 1 forever.
- **Every deviation from the plan is a defect unless its justification was written down at the moment it was taken.** A reason produced at audit time about a choice made an hour earlier is rationalisation.

## 5. Scope the checks to the diff

```sh
git diff --name-only origin/main..HEAD | grep -vE '\.md$|^LICENSE'
```

Empty means docs-only: skip the suite. **`package.json`, `package-lock.json`, `*.yml`, `.github/workflows/**`, fixtures, and `RELEASE-SMOKE.md`-adjacent tooling are never docs**, even changed alongside markdown. Log the scope decision in the PR body so a reviewer can challenge it.

## 6. Prove it, then say so honestly

- `npm run typecheck` and `npm test` green, **naming the counts** — a green summary over a skipped scope is a lie with good manners.
- **Diff the shipment against the plan**, promise by promise, and report the result out loud including when clean. The three shapes that shipped past five clean audit rounds elsewhere: quietly narrowed, quietly collapsed, promised-and-absent.
- Then let the **diff** pick the instrument: under ~200 lines across ≤3 files, `/simplify` alone; anything larger or anything the merge engine stands on, `/harden` until dry (it runs `/simplify` as its own phase — do not run both). Pass the docs carve-out into the invocation verbatim: documentation is non-negotiable; do not shorten or fold docblocks or `Why:` notes. Tell `/harden` the plan diff above already ran so it records rather than repeats it. These instruments were codified from this repo's own M4 and post-launch sessions; running them here is not optional polish, it is the bar returning home.

## 7. PR, review, merge

§4's quality gate auto-populates the PR body from the template — check every box with evidence or justify its absence, never delete rows. Request nothing before checking whether Copilot's automatic review is already coming; answer every comment **fixed** or **declined with the spec section it would violate**. Merge preserves the commit series (§7): no squash unless the maintainer asks.

## 8. Close the loop, all four places

1. **The issue** — close with evidence: commits, test counts.
2. **`ROADMAP.md`** — check the box **in the same PR** (§4 requires it).
3. **`CHANGELOG.md`** — an `[Unreleased]` entry for anything user-visible.
4. **The vault**, through the MCP: `record_work` for what happened here; `remember` for anything that would help a different project. **This is the loop's least reliable step**: if `record_work` refuses after a couple of honest rephrasings, file the note by hand in the vault and say so in the report; after any success, read the note back — one record elsewhere returned success while writing raw markup into the note.

## 9. Report

What was taken, what shipped, the numbers, what moved on the roadmap, the review outcome (how many Copilot comments, what happened to each), the plan-fidelity result stated explicitly, and **every decision taken without asking** — one line each, the branch chosen and the one not taken. Then stop. Do not start the next task.

## Anti-patterns

- Surveying the roadmap instead of taking the first unchecked row
- Writing code before an approved plan, or a plan too vague to diff
- A checked box whose issue is open, left unfixed because "someone else's"
- Filing a follow-up issue with no roadmap row (invisible forever)
- One mega-commit (§7 exists; five commits is normal)
- Running the full suite on a markdown diff, or skipping it on a manifest diff
- Halting to ask permission for the review agents this invocation already authorized
- Finishing without `record_work`, or trusting its success without reading the note back
