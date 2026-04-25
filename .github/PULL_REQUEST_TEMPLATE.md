<!--
Before opening this PR, confirm you've read CLAUDE.md §Working Agreement:
https://github.com/breferrari/shardmind/blob/main/CLAUDE.md#working-agreement-v6-execution-standard

Every v6 sub-issue (#73–#78, #14, #15, #85) must pass the quality gate below.
For non-v6 PRs, delete the v6 sections and keep Summary + Test plan only.
-->

## Summary

<!-- 1-3 bullets on what changed and why. Reference the issue (`closes #N`). -->

-
-

Closes #

## Adversarial cases considered

<!--
List the edge cases you enumerated before coding, each with a corresponding test.
See CLAUDE.md §Working Agreement §3 for the starter list per v0.1 track.
Delete this section for non-v6 PRs.
-->

-
-

## Quality gate (v6 PRs only)

<!-- Every item must be checked or explicitly justified before merge. -->

- [ ] `npm run typecheck` passes locally and in CI
- [ ] `npm test` passes locally and in CI (all scopes: unit, component, integration, E2E)
- [ ] **Tests added before implementation** (no code without a failing test that motivated it) — CLAUDE.md §Working Agreement §2
- [ ] **Step-by-step commits** (not a single squash) — CLAUDE.md §Working Agreement §7. Typecheck + relevant tests must be green at every commit; reviewers should be able to read the series incrementally and `git bisect`.
- [ ] Adversarial cases from the section above are all covered by tests
- [ ] Copilot review requested and every comment addressed (or marked false-positive with justification in the PR thread)
- [ ] Issue acceptance criteria checked off with evidence below (or in the issue)
- [ ] ROADMAP.md checkbox updated in this PR
- [ ] For PRs on #73-#77: manual Invariant 1 proxy run (`git clone <shard>` + `shardmind install --defaults` + `diff -r`) — pending #78's CI test
- [ ] For PR on #78 and later: Invariant 1 CI test still green
- [ ] Spec alignment: no divergence from [`docs/SHARD-LAYOUT.md`](../blob/main/docs/SHARD-LAYOUT.md); if the implementation revealed a spec gap, the spec update is in this PR or a predecessor

## Test plan

<!--
Bulleted markdown of what was tested + how to verify manually.
Keep concise — focus on surprising or manual-verification-only things.
-->

- [ ]
- [ ]

## Risk / blast radius

<!--
What could this break? What did you check that it didn't?
Pre-existing behavior that must still work. Migration concerns (fixtures, state.json, test data).
-->

-

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
