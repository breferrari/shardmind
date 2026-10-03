#!/usr/bin/env sh
# Self-test for step 1's milestone selection and the pre-flight comparisons.
#
# Why this exists: the selection rule is a jq filter inside a shell script, so
# no vitest test can reach it. In vigia, where this skill was written, the
# first two edits to it were verified by hand into a GitHub comment, and that
# verification died with the shell it ran in. CLAUDE.md's rule is no code
# without a test, and this is the cheapest thing that makes the rule hold here.
# Ported with the skill on 2026-10-03: the cases are vigia's, renumbered for
# this pre-flight and given ShardMind's invariant form, plus the cases for
# comparison 1, which asks a different question here.
#
# It is offline and hermetic: every case is a fixture, so it needs no network,
# no `gh`, and no particular state of the tracker. Run it after any edit to
# next.sh, preflight.sh, or the rules beside them in SKILL.md.
#
#   sh .claude/skills/take-next/selftest.sh
#
# Requires `jq` only, which next.sh already requires.

set -u
FAIL=0
HERE="$(dirname "$0")"
SKILL="$HERE/SKILL.md"
NEXT="$HERE/next.sh"
PRE="$HERE/preflight.sh"
FIX="$(mktemp -d)"
trap 'rm -rf "$FIX"' EXIT

ok() { printf '  ok   %s\n' "$1"; }
no() { printf '  FAIL %s\n    expected: %s\n    actual:   %s\n' "$1" "$2" "$3"; FAIL=$((FAIL + 1)); }

# Every case drives next.sh through its fixture seam, so what is tested is what
# a session runs rather than a copy of it.
case_is() { # name, expected, json
  printf '%s' "$3" > "$FIX/ms.json"
  actual=$(NEXT_MILESTONES_FILE="$FIX/ms.json" sh "$NEXT" 2>&1 | tr -d '\r' | sed -n 's/^milestone: //p')
  [ "$actual" = "$2" ] && ok "$1" || no "$1" "$2" "$actual"
}

echo "selection:"

# The shelf carries the marker and may sit numerically below phases that must
# be taken. The answer must be the lowest real phase.
case_is "shelf is skipped even when its number is lowest" \
  "Phase 6 - measured" \
  '[{"title":"Phase 5 - deferred","description":"Shelf: never next. Work found mid-phase","open_issues":28},
    {"title":"Phase 6 - measured","description":"A claim that outruns its evidence","open_issues":4},
    {"title":"Phase 7 - distribution","description":"Filter: does this ship","open_issues":1}]'

case_is "lowest eligible phase number wins" \
  "Phase 4 - artifacts" \
  '[{"title":"Phase 4 - artifacts","description":"","open_issues":7},
    {"title":"Phase 5 - deferred","description":"Shelf: never next.","open_issues":28},
    {"title":"Phase 6 - measured","description":"","open_issues":4}]'

# A milestone with no open issues must not be selected.
case_is "a milestone with no open issues is not selected" \
  "Phase 7 - distribution" \
  '[{"title":"Phase 6 - measured","description":"","open_issues":0},
    {"title":"Phase 7 - distribution","description":"","open_issues":1}]'

# Only shelved work left is empty output, not an answer.
case_is "only shelved work remaining gives empty" \
  "" \
  '[{"title":"Shelf","description":"Shelf: never next.","open_issues":28}]'

case_is "an empty board gives empty" "" '[]'

# An unrecognised title sorts last rather than vanishing. Both halves matter:
# it loses to a real phase, and it still wins when it is the only thing eligible.
case_is "an unnumbered milestone sorts last" \
  "Phase 7 - distribution" \
  '[{"title":"Housekeeping","description":"","open_issues":3},
    {"title":"Phase 7 - distribution","description":"","open_issues":1}]'

case_is "an unnumbered milestone is still selectable alone" \
  "Housekeeping" \
  '[{"title":"Housekeeping","description":"","open_issues":3}]'

# The anchor is real: "Phase 1" not at the start does not make it phase 1.
case_is "the phase number must begin the title" \
  "Phase 2 - two" \
  '[{"title":"The Phase 1 retrospective","description":"","open_issues":1},
    {"title":"Phase 2 - two","description":"","open_issues":1}]'

# Ordering is numeric, not lexicographic. 10 must not beat 9.
case_is "ordering is numeric, not lexicographic" \
  "Phase 9 - nine" \
  '[{"title":"Phase 10 - ten","description":"","open_issues":1},
    {"title":"Phase 9 - nine","description":"","open_issues":1}]'

# A tie must be defined rather than input-order dependent, so the same two
# milestones are asserted in both orders and must give the same answer.
case_is "a tie breaks on title, given one order" \
  "Phase 6 - alpha" \
  '[{"title":"Phase 6 - zulu","description":"","open_issues":1},
    {"title":"Phase 6 - alpha","description":"","open_issues":1}]'

case_is "a tie breaks on title, given the other" \
  "Phase 6 - alpha" \
  '[{"title":"Phase 6 - alpha","description":"","open_issues":1},
    {"title":"Phase 6 - zulu","description":"","open_issues":1}]'

# The shelf rule is a prefix rule. "Shelf:" further in is prose, not a marker.
case_is "Shelf: mid-description does not exclude" \
  "Phase 6 - measured" \
  '[{"title":"Phase 6 - measured","description":"Not a Shelf: this is real work","open_issues":1}]'

# A null description must not throw, which is what `// ""` is for. GitHub
# returns null rather than "" for a milestone created without one.
case_is "a null description is handled" \
  "Phase 6 - measured" \
  '[{"title":"Phase 6 - measured","description":null,"open_issues":1}]'

# --ranked shows the whole order the answer came from, shelf excluded.
printf '%s' '[{"title":"Phase 7 - distribution","description":"","open_issues":1},
  {"title":"Shelf","description":"Shelf: never next.","open_issues":28},
  {"title":"Phase 6 - measured","description":"","open_issues":4}]' > "$FIX/ms.json"
ranked=$(NEXT_MILESTONES_FILE="$FIX/ms.json" sh "$NEXT" --ranked 2>&1 | tr -d '\r' | paste -sd '|' -)
[ "$ranked" = "Phase 6 - measured|Phase 7 - distribution" ] && ok "--ranked lists every eligible milestone in take order" \
  || no "--ranked lists every eligible milestone in take order" "Phase 6 - measured|Phase 7 - distribution" "$ranked"

echo "mutation (the check must be able to fail):"

# next.sh claims the fallback is what stops a milestone vanishing, and that scan
# fails loudly where capture fails silently. Both halves are asserted, because
# the prose is only trustworthy if something holds it to account.
F='[{"title":"Phase 6 - six","description":"","open_issues":1},{"title":"Backlog","description":"","open_issues":1}]'

kept=$(printf '%s' "$F" | jq -c '[.[] | {o:(((.title|capture("^Phase +(?<n>[0-9]+)").n)//"9999")|tonumber)}] | length' 2>/dev/null | tr -d '\r')
[ "$kept" = "2" ] && ok "with the fallback, capture keeps every milestone too" \
  || no "with the fallback, capture keeps every milestone too" "2" "$kept"

kept=$(printf '%s' "$F" | jq -c '[.[] | {o:((.title|capture("^Phase +(?<n>[0-9]+)").n)|tonumber)}] | length' 2>/dev/null | tr -d '\r')
[ "$kept" = "1" ] && ok "without the fallback, capture drops one silently" \
  || no "without the fallback, capture drops one silently" "1" "$kept"

if printf '%s' "$F" | jq -c '[.[] | {o:((.title|[scan("^Phase +([0-9]+)")[]]|first)|tonumber)}]' >/dev/null 2>&1; then
  no "without the fallback, scan fails loudly" "a jq error" "no error"
else
  ok "without the fallback, scan fails loudly"
fi

echo "preflight (the board every comparison reads):"

# The spec declares one invariant, and the test fixture names it.
cat > "$FIX/spec.md" <<'EOF'
## Installation invariants
### Invariant 1 — a thing holds
EOF
printf 'describe("Invariant 1: holds", () => {});\n' > "$FIX/tests.txt"

# Every fixture issue is closed, milestoned and named by a roadmap row, and the
# declared invariant is named by a test, so comparisons 1 to 6 are quiet and
# each case below reads exactly one line moving. The third row cites `#9`, which
# no `board` call produces, and that is the comparison-3 case rather than an
# oversight.
cat > "$FIX/roadmap.md" <<'EOF'
## Phase 8 - look
| | Task | Issue |
|---|---|---|
| ✅ | one | [#1](https://example.invalid/1) |
| ✅ | two | [#2](https://example.invalid/2) |
| ✅ | absent | [#9](https://example.invalid/9) |
EOF

board() { # count -> issues.json
  jq -n --argjson n "$1" '[range(1; $n + 1) | {
    number: ., state: "CLOSED", milestone: {title: "Phase 8 - look"},
    title: (if . == 1 then "Invariant 1: the first" else "issue \(.)" end)
  }]'
}

# One preflight run, filtered to the lines a case is about. `awk '{$1=$1}1'`
# rebuilds the record on single spaces, which is what makes a case pattern
# independent of the column padding `ok` and `hit` align their output on.
runs() { # limit, count, pattern -> the matching lines, space-normalised
  board "$2" > "$FIX/issues.json"
  PREFLIGHT_SPEC_FILE="$FIX/spec.md" \
  PREFLIGHT_ROADMAP_FILE="$FIX/roadmap.md" \
  PREFLIGHT_ISSUES_FILE="$FIX/issues.json" \
  PREFLIGHT_TESTS_FILE="$FIX/tests.txt" \
  PREFLIGHT_ISSUE_LIMIT="$1" \
    sh "$PRE" 2>&1 | awk -v p="$3" '$0 ~ p { $1 = $1; print }'
}

BOARD='^ +(ok|DRIFT) +(all [0-9]+ issues|the fetch returned)'

line=$(runs 2 2 "$BOARD")
case "$line" in
  "DRIFT the fetch returned 2 issues against a limit of 2"*)
    ok "a board at the fetch limit is reported, not read" ;;
  *) no "a board at the fetch limit is reported, not read" "a DRIFT naming the limit" "$line" ;;
esac

line=$(runs 4 2 "$BOARD")
case "$line" in
  "ok all 2 issues fetched, under a limit of 4"*) ok "a board under the limit reads clean" ;;
  *) no "a board under the limit reads clean" "ok all 2 issues fetched, under a limit of 4" "$line" ;;
esac

# The other end of the same silence, and the one no fetch size fixes: #9 is cited
# by a roadmap row and is in no board, which is what a deleted issue, a
# transferred one and a mistyped number all look like from here.
line=$(runs 4 2 'row cites #')
case "$line" in
  "DRIFT row cites #9, which the tracker does not have"*)
    ok "a roadmap row citing an issue the board lacks is reported" ;;
  *) no "a roadmap row citing an issue the board lacks is reported" \
       "DRIFT row cites #9, which the tracker does not have" "$line" ;;
esac

# One pre-flight run over the fixture files, at a limit the fixtures stay under.
pre() {
  PREFLIGHT_SPEC_FILE="$FIX/spec.md" PREFLIGHT_ROADMAP_FILE="$FIX/roadmap.md" \
  PREFLIGHT_ISSUES_FILE="$FIX/issues.json" PREFLIGHT_TESTS_FILE="$FIX/tests.txt" \
  PREFLIGHT_ISSUE_LIMIT=10 sh "$PRE" "$@"
}
section() { # number -> that comparison's indented lines, space-normalised
  pre 2>&1 | awk -v n="$1" '/^[0-9]+\./ { on = ($0 ~ "^" n "\\."); next } /^[a-z]/ { on = 0 } on && /^ / { $1 = $1; print }'
}

echo "preflight (comparisons 1 and 2, the invariants):"

# Comparison 1 is the one this port changed: vigia asks whether an issue names
# each invariant, and ShardMind asks whether a test does.
board 2 > "$FIX/issues.json"
out=$(section 1)
[ "$out" = "ok every declared invariant is named by a test" ] && ok "a tested invariant reads clean" \
  || no "a tested invariant reads clean" "ok every declared invariant is named by a test" "$out"

printf 'describe("Invariant 10: a different one", () => {});\n' > "$FIX/tests.txt"
out=$(section 1)
[ "$out" = "DRIFT Invariant 1 is declared by docs/SHARD-LAYOUT.md and no test names it" ] \
  && ok "an untested invariant is reported, and Invariant 10 does not count as Invariant 1" \
  || no "an untested invariant is reported, and Invariant 10 does not count as Invariant 1" "DRIFT Invariant 1 ... no test names it" "$out"

printf '## no invariants here\n' > "$FIX/spec.md"
out=$(section 1)
case "$out" in
  "DRIFT docs/SHARD-LAYOUT.md declares no"*) ok "a spec with no invariants is reported, not read as clean" ;;
  *) no "a spec with no invariants is reported, not read as clean" "DRIFT ... declares no" "$out" ;;
esac

# Restore the clean fixtures for everything below.
printf '## Installation invariants\n### Invariant 1 — a thing holds\n' > "$FIX/spec.md"
printf 'describe("Invariant 1: holds", () => {});\n' > "$FIX/tests.txt"

jq -n '[{number: 1, state: "CLOSED", milestone: {title: "Phase 8 - look"}, title: "Invariant 1: the first"},
        {number: 2, state: "OPEN", milestone: {title: "Phase 8 - look"}, title: "Invariant 5 holds on Windows"}]' > "$FIX/issues.json"
out=$(section 2)
[ "$out" = "DRIFT an issue names Invariant 5 and docs/SHARD-LAYOUT.md no longer declares it" ] && ok "an issue naming a retired invariant is reported" \
  || no "an issue naming a retired invariant is reported" "DRIFT an issue names Invariant 5 ..." "$out"

echo "preflight (comparisons 3 to 8):"

# A row's issue is the one in its last cell. A row may cite a second issue in
# its task prose (`Blocks`, `Closed by`), and reading the first link checks the
# row against the wrong issue. Its own fixture, because the shared one above is
# read by two cases that would see the second link as a board it lacks.
cat > "$FIX/roadmap.md" <<'ROW'
## Phase 8 - look
| | Task | Issue |
|---|---|---|
| ⬜ | deferred by [#1](https://example.invalid/1) | [#2](https://example.invalid/2) |
ROW
jq -n '[{number: 1, state: "CLOSED", milestone: {title: "Phase 8 - look"}, title: "Invariant 1: the first"},
        {number: 2, state: "OPEN", milestone: {title: "Phase 8 - look"}, title: "issue 2"}]'   > "$FIX/issues.json"
line=$(pre 2>&1 | awk '/row (not marked done|marked done|cites)/ { $1 = $1; print }')
case "$line" in
  "") ok "a row is checked against the issue in its own cell" ;;
  *)  no "a row is checked against the issue in its own cell" "no drift" "$line" ;;
esac

# Both directions of a mark that disagrees with its issue, and the mentions
# comparison 6 reads: `#1,#2` names both, `a#3`, `#30` and `#1#3` name no #3.
cat > "$FIX/roadmap.md" <<'ROW'
## Phase 8 - look
| | Task | Issue |
|---|---|---|
| ✅ | done early, see #1,#2 | [#2](https://example.invalid/2) |
| ⬜ | left behind | [#1](https://example.invalid/1) |
a#3, #30 and #1#3
ROW
jq -n '[{number: 1, state: "CLOSED", milestone: {title: "Phase 8 - look"}, title: "Invariant 1: the first"},
        {number: 2, state: "OPEN", milestone: {title: "Phase 8 - look"}, title: "issue 2"},
        {number: 3, state: "CLOSED", milestone: {title: "Phase 8 - look"}, title: "issue 3"}]' > "$FIX/issues.json"
out=$(pre 2>&1 | awk '/DRIFT/ { $1 = $1; print }')
want='DRIFT row marked done, issue #2 is open
DRIFT row not marked done, issue #1 is closed
DRIFT #3 has no roadmap mention: issue 3'
if [ "$out" = "$want" ]; then ok "marks and mentions drift both ways"
else no "marks and mentions drift both ways" "$want" "$out"; fi

# Comparison 4: an open issue with no milestone is invisible to step 1.
printf '| ⬜ | x | [#1](https://example.invalid/1) |\n' > "$FIX/roadmap.md"
jq -n '[{number: 1, state: "OPEN", milestone: null, title: "issue 1"}]' > "$FIX/issues.json"
out=$(section 4)
[ "$out" = "DRIFT #1 has no milestone: issue 1" ] && ok "an open issue with no milestone is reported" \
  || no "an open issue with no milestone is reported" "DRIFT #1 has no milestone: issue 1" "$out"

# An empty file on either side is still read as the side it is.
echo '[]' > "$FIX/issues.json"
out=$(pre 2>&1 | awk '/row cites/ { $1 = $1; print }')
[ "$out" = "DRIFT row cites #1, which the tracker does not have" ] && ok "an empty board fails every row" || no "an empty board fails every row" "row cites #1" "$out"
echo '## no rows' > "$FIX/roadmap.md"
jq -n '[{number: 1, state: "CLOSED", milestone: {title: "Phase 8 - look"}, title: "Invariant 1: the first"}]' > "$FIX/issues.json"
out=$(pre 2>&1 | awk '/roadmap mention/ { $1 = $1; print }')
[ "$out" = "DRIFT #1 has no roadmap mention: Invariant 1: the first" ] && ok "a roadmap with no mentions fails every issue" || no "a roadmap with no mentions fails every issue" "#1 has no roadmap mention" "$out"

# Comparison 7, from the case that filed it in vigia: a sibling worktree on
# `single-297` and a plan comment, with `issue-2970`, `issue-1297` and a closing
# comment beside them.
printf 'worktree C:/Dev/shardmind on main\nworktree C:/Dev/shardmind.b on single-297\nbranch single-297\nbranch origin/issue-2970-x\nbranch issue-1297-y\n' > "$FIX/refs.txt"
jq -n '{comments: [
  {author: {login: "a"}, createdAt: "t1", body: "Plan (pre-approved for this run): x"},
  {author: {login: "b"}, createdAt: "t2", body: "Shipped in abc. The plan held."},
  {author: {login: "c"}, createdAt: "t3", body: "\n**Approved plan, 2026-09-29.**"}]}' > "$FIX/comments.json"
flight() { # issue -> comparison 7's lines, space-normalised
  PREFLIGHT_SPEC_FILE="$FIX/spec.md" PREFLIGHT_ROADMAP_FILE="$FIX/roadmap.md" PREFLIGHT_ISSUES_FILE="$FIX/issues.json" \
  PREFLIGHT_TESTS_FILE="$FIX/tests.txt" PREFLIGHT_REFS_FILE="$FIX/refs.txt" PREFLIGHT_COMMENTS_FILE="$FIX/comments.json" \
  PREFLIGHT_ISSUE_LIMIT=10 sh "$PRE" "$1" 2>&1 | awk '/^[0-9]+\./ { on = /^7\./; next } on && /^ / { $1 = $1; print }'
}
out=$(flight 297)
want='DRIFT worktree C:/Dev/shardmind.b on single-297
DRIFT branch single-297
DRIFT a plan comment by a, t1
DRIFT a plan comment by c, t3'
[ "$out" = "$want" ] && ok "an issue in flight is reported" || no "an issue in flight is reported" "$want" "$out"
echo '{"comments": []}' > "$FIX/comments.json"
out=$(flight 29)
[ "$out" = "ok no worktree, branch or plan names #29" ] && ok "a free issue reads clean" || no "a free issue reads clean" "ok" "$out"
out=$(pre 2>&1 | grep -c '^7\.')
[ "$out" = 0 ] && ok "no issue, no comparison 7" || no "no issue, no comparison 7" "0" "$out"

# Comparison 8 reads only an open row's Why cell. #4 cites closed #1 and a
# retired Invariant 9, #5 cites open #4 and a declared Invariant 1 and names #7
# outside its Why cell, #6 names #1 only where it surfaced, and #7 is closed.
cat > "$FIX/roadmap.md" <<'ROW'
## Deferral shelf
| Item | Surfaced | Moved to | Why |
|---|---|---|---|
| four ([#4](https://example.invalid/4)) | #2, 2026-01-01 | Shelf | waits on #1 and Invariant 9, then #1 again |
| five ([#5](https://example.invalid/5)) | #2, 2026-01-01 | Shelf, after #7 | waits on #4 and Invariant 1 |
| six ([#6](https://example.invalid/6)) | #1, 2026-01-01 | Shelf | found in #1 |
| seven ([#7](https://example.invalid/7)) | #2, 2026-01-01 | Shelf | waits on #1 |
## Pull-forward log
| eight ([#8](https://example.invalid/8)) | #2 | Shelf | waits on #1 |
ROW
jq -n '[range(1; 9) | {number: ., milestone: {title: "Shelf"}, title: "issue \(.)",
  state: (if . == 1 or . == 7 then "CLOSED" else "OPEN" end)}]' > "$FIX/issues.json"
out=$(section 8)
want='read #4: its reason cites #1 (closed), Invariant 9 (retired)'
[ "$out" = "$want" ] && ok "a shelf reason naming a closed issue or retired invariant is surfaced" || no "a shelf reason naming a closed issue or retired invariant is surfaced" "$want" "$out"

echo "drift:"

present() { # needle, file, name
  grep -qF "$1" "$2" 2>/dev/null && ok "$3" || no "$3" "$1" "absent"
}

# One filter, three callers. The skill sends a session to the script, the
# pre-flight compares the script's answer against the roadmap, and the shelf is
# identified by a description prefix in the one place that decides it.
present 'sh .claude/skills/take-next/next.sh' "$SKILL" "SKILL.md sends a session to next.sh"
present 'next.sh' "$PRE" "preflight.sh compares the roadmap against next.sh"
present 'startswith("Shelf:")' "$NEXT" "next.sh identifies the shelf by prefix"
present 'SPEC_PATH="docs/SHARD-LAYOUT.md"' "$PRE" "preflight.sh reads the spec CLAUDE.md names authoritative"

# The limit is the one thing the cases above cannot check about themselves: they
# run at a small override, so nothing there would notice the shipped default
# dropping back under the board.
present 'PREFLIGHT_ISSUE_LIMIT:-1000' "$PRE" "preflight.sh still fetches to a limit of 1000"

echo
if [ "$FAIL" -eq 0 ]; then
  echo "all checks passed"
else
  echo "$FAIL check(s) failed"
fi
exit "$FAIL"
