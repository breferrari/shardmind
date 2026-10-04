# take-next: unattended-loop

The reader invoked `/take-next unattended-loop`. That invocation is plan approval for every pass the loop takes. Run `SKILL.md` pass after pass, until the queue is dry. **Where this file and `SKILL.md` differ, this file wins.**

## What changes in a pass

- **Step 3 does not wait, and skips plan mode.** Write the plan as usual and post it on the issue, headed "Plan (pre-approved by the reader for this run)". Then build. This replaces "Step 3 is a real stop".
- **The four stops stop the item, not the loop.** A contradiction with the spec, a task that is two tasks, a destructive action outside the branch, or a decline or narrowing of what the reader asked for: do not build past it. If a draft PR is open, leave it open with the question at the top of its body. Record the question for the final report and take the next item. A new dependency or a contract change in `docs/SHARD-LAYOUT.md` is the reader's, and goes to the report the same way.
- **A wait does not block.** After `gh pr ready`, start the next pass in a new worktree while CI runs. While review agents run, apply each report as it arrives, then build. Merging still waits for its green run.
- **Nothing releases.** The loop merges; tagging stays with the reader after `RELEASE-SMOKE.md`.

## Merging

- Merge a PR when the `CI` run on its **head** is green. Then remove its worktree and local branch in the same step.
- A red run stops merging. Fix it before the next pass starts.
- When `main` moves under an open PR, rebase it. On a `ROADMAP.md` or `CHANGELOG.md` conflict, keep both sides' rows. Then rerun `npm run typecheck && npm test`.

## The queue

1. `next.sh`, in its own order.
2. When it is dry, stop. There is no shelf: the reader retired it on 2026-10-04, moving its items into Phases 4 to 11, and the loop takes those phases in order like any other. This replaces the 2026-10-03 ruling that shelf items are not taken unattended. A pass that concludes an item should be declined still stops that item and reports it, per the decline stop above.
3. Read the queue again when a pass ends and before calling it dry: issues are filed while the loop runs. When nothing is eligible, tell the reader.

## Done when

`next.sh` is dry and every PR of the loop is merged or reported red. Report once, per `SKILL.md` step 9, with the counts: PRs opened, merged and red, items skipped, and the questions waiting on the reader.
