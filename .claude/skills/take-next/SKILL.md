---
name: take-next
description: Take the next task from ROADMAP.md and ship it end to end. Use when starting work with no specific task named, or when the user says "take next", "next task", "what's next and do it", or "keep going". Enforces one task per pass, a failing test per behavior, and a recorded trail.
---

# take-next

Take **one** task from `ROADMAP.md` and carry it to merged. Do not take part of a task, several tasks, or a survey of possible work.

This skill runs the [`CLAUDE.md` Working Agreement](../../../CLAUDE.md#working-agreement-v6-execution-standard) as a pass: spec before code, tests before implementation, adversarial cases enumerated, the quality gate, session hygiene and commit hygiene. Where this file and `CLAUDE.md` disagree, `CLAUDE.md` wins and this file is wrong. Fix it in the pass that finds it.

Ported from vigia's `take-next` on 2026-10-03. The mechanism (milestone order, pre-flight, the stops) is vigia's. The stack, the spec and the gates are ShardMind's.

**`unattended-loop`** in the arguments: read [`unattended-loop.md`](unattended-loop.md) first.

> [!IMPORTANT]
> **Run this to the end. Plan approval in step 3 is the one routine stop.**
>
> The reader often starts the skill and leaves it alone. If a step waits for an answer, the pass stalls until the reader replies, often hours later, with the work done and nothing merged. So split **what** from **how**. Step 3 settles what gets built, and a question costs nothing there. Everything after step 3 is execution, and this file answers execution questions:
>
> - **The tools are pre-authorized.** The request to run this skill is also the request to run `/simplify`, `/two-axis-review`, `/code-review` and the agents that they start.
> - **Apply review findings without asking.** Fix each finding that is worth a fix. In the PR body, list each finding that you skip, with a one-line reason. In a core area (step 6), if you cannot name why a finding is wrong, fix it. A finding that declines or narrows what the reader asked for is stop 4 below. Do not apply it as a fix.
> - **A documented choice wins.** Take it and name it in the report. A documented refusal is a reason with a date. Make sure that the reason is still true (step 3).
> - **An open choice goes to the branch that delivers what was asked.** Finish the pass and put the question in the report. Do not build less to be safe. A missing feature gives the reader nothing to review. The reader can reject an extra feature in review.
>
> Four things stop the pass, and all four are about *what*:
>
> 1. A finding contradicts the spec, `docs/SHARD-LAYOUT.md` (step 4).
> 2. The task is two tasks (step 3).
> 3. An action is destructive outside this branch. A release is one: this skill never runs `npm run release:*` (step 7).
> 4. You conclude that something the reader asked for must be declined or narrowed. Plan approval does not cover this. A decline inside a long plan is easy to miss, and approval of the plan is not approval of the decline. Ask the question in its own message, and wait.
>
> **An unattended session may add. It may not subtract.**
>
> Step 3 is a real stop. Present the plan and wait. Do not approve it yourself. If nobody answers, that is not approval. Do not offer "ship it as is" as an option.

## 1. Find the task

```sh
sh .claude/skills/take-next/next.sh            # the milestone to take from, then its open issues
sh .claude/skills/take-next/next.sh --ranked   # every eligible milestone in take order
sh .claude/skills/take-next/preflight.sh       # does the record still agree with the tracker
```

`next.sh` selects the earliest eligible milestone:

- **Order is the phase number at the start of the title.** Due dates are null, and a null sort returns API order. A title without `Phase <n>` sorts last and does not disappear. So a renamed milestone goes last, silently. Pre-flight comparison 5 finds this.
- **A description that starts with `Shelf:` is never selected.** A shelf stays open and is never next. Take from a shelf only as a deliberate choice. First, read its dated reason for the deferral again.
- **A milestone with no open issues is skipped.** Thus a finished phase that is still open is never selected. An empty answer means that the rest is shelved, finished, or empty. Find out which before you act.
- **A phase inserted before Phase N gets a fractional number,** `Phase 1.5 — …`: the order reads the integer, so 1.5 sorts with 1 and before 2, and its `## Phase 1.5` section must match the milestone title exactly.

After you edit `next.sh`, `preflight.sh` or these rules, run `sh .claude/skills/take-next/selftest.sh`. When you finish the last issue in a milestone, close the milestone.

`ROADMAP.md` declares the next task and links every issue, open or closed. The tracker holds the state of each issue. If the two disagree, fix the roadmap in the same pass.

### Pre-flight

`preflight.sh` reads `docs/SHARD-LAYOUT.md`, `ROADMAP.md` and `tests/` from `origin/main`, not from the working tree. It fetches the whole board and exits non-zero on any hit in comparisons 1 to 7. Fix each of those hits in this pass. Comparison 8 is advisory: read it and act as it says.

First, the script makes sure that the whole board arrived. A truncated fetch hides real drift from 2, 4 and 6. Then it runs these comparisons:

1. Each invariant that `docs/SHARD-LAYOUT.md` declares (`### Invariant <n>`) is named by a test under `tests/`. An invariant with no test that names it is a promise nothing checks.
2. No issue title names an invariant that the spec no longer declares.
3. The mark on each roadmap row agrees with the state of its issue, and the issue exists.
4. Each open issue has a milestone, or `next.sh` never sees it.
5. The answer from `next.sh` agrees with the section order in the roadmap. Each open milestone with work, except the Shelf, has a `## Phase <n>` section.
6. Each issue, open or closed, has a roadmap mention.
7. Given an issue number, no worktree, branch or plan comment names it.
8. Open shelf rows whose reason cites a closed issue, retired invariant or closed phase. Reread each reason.

A false positive means that the check is wrong: fix it, never skip it. A command in this file can stop doing what the file says. Fix it in the pass that finds it. That is a correction, not instrument work, so the Shelf rule in step 4 does not apply.

Take the **topmost unstarted row** in the `ROADMAP.md` section of that phase. If a later task blocks it, say so and take the blocker. Then run `preflight.sh <n>`: another session can hold a ⬜ row.

### Declines

A decline costs more than a build, because a missing feature gives the reader nothing to review.

- Reach a decline early. Whether the reason holds is a question of fact. After you know the reason, more time only adds words that defend the decline.
- A decline has a higher bar than a build: its reason must survive a check. A bad build is visible in review. A bad refusal is not visible, and no gate can find a feature that nobody built.
- If the reader asked for the thing, build it. "Possible, affordable, but I prefer another design" is a preference, not a reason.
- A deferral goes in the spec's own out-of-scope list (`docs/SHARD-LAYOUT.md §Out of scope`, or `VISION.md`'s non-goals for a permanent one), in the fewest words that evidence can prove false, with its date. The evidence goes on the issue.

### A question inside a build issue

An issue is a build unless the reader says it is a ruling. If a build issue contains a question, answer it in the report, not in the spec. If the answer changes the contract, that change is the spec-first commit of step 4, made in the open.

## 2. Load the context

Read the issue first. For a design or UX task, next find how other tools solve the problem. Then read, in the order `CLAUDE.md §Session hygiene` gives: the `docs/SHARD-LAYOUT.md` sections that the issue touches (authoritative where the docs conflict), then the module specs in `docs/ARCHITECTURE.md` and `docs/IMPLEMENTATION.md`, then the commits that changed those sections. This order keeps the record from limiting the options.

Then query `vigil` for the three things that the repo does not hold:

- Private context, for example why ShardMind exists and which shard depends on what.
- Lessons from other projects, for example a merge-engine landmine or a Windows rename trap.
- History from before the code.

Know which of the three you need. Use `search` for the decision that you will change. `recall` is often empty, and an empty result means nothing. Strategic context can leak into public text that you write with it in mind. The commit guard does not find that leak.

## 3. Plan, and wait for approval

Enter plan mode. Do not write code before a person approves the plan. Step 6 compares the shipped work with this plan.

The plan contains these parts:

- **What it rests on.** List the decisions by title, from the spec, `CLAUDE.md §Key Architectural Decisions` and `vigil`. List each fact that argues against the approach, and why you continue. If the record is empty, write "nothing recorded". That empty result is a finding.
- **Premises.** For each premise, write what must be true, how it can be false, and the answer with its source. The source is one of: *measured*, *read in the dependency's source* (`node_modules/`), *checked against the world*, *recorded in the spec*, or *assumed*. A premise that the plan depends on must not stay *assumed*. Settle it before you present the plan: read the source, write a probe, reproduce, or search the web. For facts about other libraries and platforms, use the world as the source, not memory. Settle premises in dependency order. Finding facts is your job, not the reader's job. Only product decisions go to the reader, in the plan. A decline is the exception, because it is stop 4.
- **A bug is reproduced before it is planned.** For a defect, the plan names the failing test that reproduces it, and you have watched it fail. A bug report's root-cause analysis is a premise like any other: confirm it in the code.
- **Checks on the record.** Quote the words of each invariant that you cite and make sure that they apply to this case. Quote each refusal that you cite, with its date, and mark it checked or not checked. A reason about something missing ("no API for this") becomes false fastest. If the reason is false, the question is open again. Do not find a new reason for the same conclusion.
- **Adversarial cases** (`CLAUDE.md §Working Agreement §3`). List them. Each one gets a test.
- **Promises you can diff.** List the files, signatures and error codes (`docs/ERRORS.md`). List the tests by name, with what each test asserts. List each deviation from the spec with its reason, and list what is out of scope. "Fix the thing" promises nothing and passes every check. Size the list to the diff.

**One fresh context must hold the work.** The context must hold the issue, the spec sections, the changed files and the new tests, and have room to think. If it cannot, split the issue into child issues. Each child needs a full path through spec, code and gates. Mark which child blocks which. A split is stop 2. Show the split in the plan, and file the child issues after the reader approves. For a wide mechanical refactor, use expand then contract: add the new form, move the call sites in batches, then delete the old form.

Before you write code, post the approved plan as a comment on the issue, starting with the word `Plan`. When you take a deviation, write it and its reason at that time. A reason that you write at review time does not count.

## 4. Build

- **Runners: `CLAUDE.md §Build, Test, and Development Commands`.** `npm ci` in a fresh worktree, never `npm install` unless the pass adds a dependency (then the lockfile discipline there applies).
- **One issue, one branch, one worktree, one PR** (`CLAUDE.md §PR hygiene`). Work in a worktree, not in the main checkout, which stays on `main` so `origin/main` and the tree agree. First, find a free `../shardmind.*` worktree whose `node_modules` is warm, and make sure that no other session uses it. Then run `git -C <dir> checkout -B issue-<n>-<slug> origin/main`. If none is free, add one with `git worktree add ../shardmind.<n> -b issue-<n>-<slug> origin/main`. After the merge, remove the worktree that you added.
- **Spec first.** If the spec is silent or wrong on a decision you need, change `docs/SHARD-LAYOUT.md` (or the module spec) in its own commit before the code.
- **Write the failing test first** for each behavior and each adversarial case. Watch it fail, then make it pass. Merge-engine work (`drift.ts`, `differ.ts`, `renderer.ts`) writes **fixtures first**, under `tests/fixtures/merge/`.
- **Commit in steps** (`CLAUDE.md §Commit hygiene`): typecheck and the relevant tests green at every commit, conventional prefixes, the issue tag in the first commit.
- **Open a draft PR early** with `gh pr create --draft`. Copilot skips drafts, so a push costs nothing.
- **A long run** (a soak, a matrix reproduction) needs a comment on its issue when it starts: what runs, where the output goes, and when it ends.
- **Add no dependency that the spec does not name.** Propose it in the spec first, in its own commit.
- **If reality contradicts the spec, stop (stop 1).** Say which one you think is wrong, and wait. After the reader answers, change that one in its own commit. If reality contradicts the plan, decide which is wrong. If the plan is wrong, write the deviation and its reason on the issue at that time, then correct the plan comment. Step 6 then compares against the plan as it is now.
- **Each issue that you file gets a milestone and a roadmap row.** Fix in-scope findings in this PR. Do not move an in-scope finding to a new issue to close the PR. An out-of-scope finding goes to the Shelf: a row in the Shelf table of `ROADMAP.md`, its dated reason in the Deferral shelf table, and `gh issue create --title "..." --body-file f.md --milestone "Shelf"`. A defect in a gate, a check, a skill or a workflow also goes to the Shelf. If that work blocks a product pass, do it, and make it as small as the blockage.

## 5. Scope the checks

A docs-only diff (`*.md`, `docs/`, `.claude/skills/`) runs `npm run typecheck` only; a skill diff also runs `selftest.sh`. Anything under `source/`, `tests/`, `schemas/`, `scripts/`, `package*.json` or the build config is code: `npm run typecheck`, `npm test` and `npm run build`. In the PR body, write which scope you chose.

## 6. Review and prove

**The kind of change decides the review.** The core areas are the merge engine (`drift.ts`, `differ.ts`), ownership and `state.json`, the install, update and adopt pipelines, the hook orchestrator, and the four invariants. Work there runs the full sequence below. Ink component work that touches none of them (layout, prompts, colour) runs `/simplify` and puts the rendered frame in the PR. Docs-only diffs and small code diffs are the exceptions at the end of this step. The rule goes one way only: a UI change that touches a core area runs the full sequence for that part.

**Before the review, diff the result against the plan.** Mark each promise delivered or not delivered. In this pass, fix each quietly narrowed scope, each dropped case and each unused definition. If a deviation has no reason written when you took it, remove the deviation: make the code match the plan.

The full sequence, in order. Apply what each step finds:

1. `/simplify`.
2. `/two-axis-review` against `origin/main`. The Spec axis compares the diff with the issue, the plan comment and `docs/SHARD-LAYOUT.md`. Act only on what `/simplify` did not find.
3. `/code-review high`.
4. **Mutation check.** For each new test that guards a fix, remove the fix and watch the test fail. Commit first, then mutate, then restore with `git checkout -- <file>` and confirm `git status` is clean: a revert over uncommitted work destroys it.

Run each tool once. A new review always finds something new, so a loop until clean never ends. Docs-only diffs run `/simplify` and `/two-axis-review`, at any size. A small code diff runs `/simplify` and the mutation check. Small means under ~200 lines in 3 files or fewer, outside the core areas. If the reader asks for `/harden`, run it. A code change committed after `/code-review` gets one `/code-review` of that change.

Give each agent a brief. Add every measurement that the reviewer needs to the brief. The brief also says: *Read the code. Do not run builds or tests. If a measurement is missing, name it and I will run it.* Review agents run on Sonnet.

Then prove the result: for a code diff, report `npm run typecheck`, `npm test` (with the counts) and `npm run build` green. If the diff touches install, update or adopt, also run the Invariant 1 E2E test by name and report it. State each failure plainly.

## 7. Mark ready and merge

The PR body follows `.github/PULL_REQUEST_TEMPLATE.md`: every quality-gate box checked or justified, the adversarial cases listed. A user-visible change adds its line to `CHANGELOG.md` under `## [Unreleased]` on the branch. **This skill never releases.** Tagging runs `RELEASE-SMOKE.md` first and is the reader's call (`CLAUDE.md §Release Process`).

Before `gh pr ready`, name the commit each step 6 review read; a later code commit is reviewed first. `gh pr ready` starts the Copilot review. Copilot has a quota, so mark the PR ready once, after the local suite is green and the plan diff is clean.

```sh
t=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh pr ready <n>
gh run list --branch <branch> --workflow CI --created ">=$t" --limit 1 --json databaseId,headSha --jq '.[0]'
gh run watch <id> --exit-status
gh run view <id> --json conclusion --jq .conclusion
```

Watch the run, not `gh pr checks`. List only the runs that started after the ready call. If the list is empty, the run is not in the queue yet: list again. The `headSha` of the run must be the head of the PR. Use `conclusion` as the gate, because `gh run watch` can exit 0 on a failed run. After each fix push, watch the new run the same way. The matrix is three operating systems: a Windows-only failure is a failure.

Then read the Copilot review, which nothing else watches:

```sh
gh api repos/{owner}/{repo}/pulls/<n>/reviews --jq '.[] | select(.user.login == "copilot-pull-request-reviewer[bot]") | "\(.state)\n\(.body)"'
gh api repos/{owner}/{repo}/pulls/<n>/comments --jq '.[] | select(.user.login == "Copilot") | "\(.path):\(.line)\n\(.body)\n"'
```

When the PR becomes ready, Copilot reviews it automatically. A manual request spends a second unit of quota. After the first ready run ends, wait up to fifteen minutes for the review. If none arrives, continue and say so in the report. Reply to every comment: fix it, or reply with the spec section or invariant that the fix breaks. A comment without a reply reads as agreement. Put all fixes in one push. If you must do more than fix review comments, run `gh pr ready <n> --undo` first.

When the latest run is green on the PR head and every comment has a reply, merge with `gh pr merge <n> --squash --delete-branch`. Under a worktree, the local branch delete fails after the merge, so read the PR state before you try again.

## 8. Close the loop

Do items 2 and 3 on the branch before step 7, so that they merge with the PR. Do items 1 and 4 after the merge.

1. **Issue.** Close it with the commit, the test count and the numbers. If an outside reporter filed it, thank them and say which release will carry it (or that none is cut yet).
2. **`ROADMAP.md`.** Change the mark of the row. Add a row for each issue that this pass filed or closed. If this pass moved an issue to the Shelf, add its rows to the Shelf and Deferral shelf tables. If it took an issue from the Shelf, add a line to the Pull-forward log.
3. **Spec.** If the contract changed, change it in its own commit on the branch.
4. **Vault.** Use `record_work` for what happened. Use `remember` for a lesson that helps another project. Read each write back.

## 9. Report

1. **First line.** Write what a ShardMind user can do now that was not possible before. If nothing changed, write "nothing yet" and the issue that will change it.
2. **Second line.** Write the latest release tag and the number of merged PRs after it. If this pass is not in a release, say so.

Then write briefly: the issue that you took, what shipped with numbers, and the next task (named, not started). Add these parts:

- **Review.** What each tool and Copilot found, and what you applied or skipped.
- **Plan diff.** Every promise delivered, or the deviations.
- **What the record gave.** The recorded decisions that the work used, or none.
- **Decisions taken without asking.** One line each: the branch that you took and the branch that you did not take.

## Writing

The PR body, issue comments, commits and report use plain words, the fact first, one paragraph per line. Write the PR body the way that `/pr` does, on the sections of `.github/PULL_REQUEST_TEMPLATE.md`, and set it without a wait for approval. The body says what is true now and links the plan comment. It does not repeat the review. It has one line for each tool, then one line for each skipped finding with its reason.
