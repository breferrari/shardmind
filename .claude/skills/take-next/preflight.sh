#!/bin/sh
# take-next pre-flight, as one command instead of eight hand-run comparisons.
#
# The comparisons and their WHY live in SKILL.md; this file is the mechanism.
# Ported from vigia's take-next on 2026-10-03, where every trap below was found:
# everything reads from an explicit git ref (default origin/main) and never the
# working tree, jq output is stripped of CR before any comparison (jq emits CRLF
# on Windows and grep -qxF then fails against every line), word boundaries are
# explicit character classes because \b is backspace inside a jq string, and
# the milestone query uses per_page=100 with no --paginate (the --jq filter runs
# once per page and emits one answer per page).
#
# The spec is docs/SHARD-LAYOUT.md, the contract CLAUDE.md names authoritative,
# and an invariant is a `### Invariant <n>` heading in it. vigia tracks an
# invariant by an issue that builds it; ShardMind's four invariants shipped in
# v0.1, so what can drift is the test that holds one, and comparison 1 asks for
# that instead.
#
# Exit: 0 clean, 1 any mechanical finding. Comparison 8 is judgment: its rows
# are printed for reading and never counted.
#
# Test seams (test-only, never set in a real run): PREFLIGHT_SPEC_FILE,
# PREFLIGHT_ROADMAP_FILE, PREFLIGHT_ISSUES_FILE and PREFLIGHT_TESTS_FILE
# substitute local files for the ref's copies, the tracker fetch and the test
# tree, so a mutation ("delete an invariant's test", "flip a row's mark", "hand
# it a board at the cap") can prove each comparison fires. A drift check that
# cannot report "no drift" has not been tested, and neither has one that cannot
# report drift. Comparison 7 has two more: PREFLIGHT_REFS_FILE for the
# worktrees and branches, and PREFLIGHT_COMMENTS_FILE for the issue's comments.
#
# Usage: preflight.sh [issue]. Comparison 7 runs only when given the issue.
set -u
TAKEN="${1:-}"
case "$TAKEN" in *[!0-9]*) echo "usage: preflight.sh [issue number]" >&2; exit 2 ;; esac
REF="${PREFLIGHT_REF:-origin/main}"
SPEC_PATH="docs/SHARD-LAYOUT.md"
# Most comparisons read the tracker fetch, so a short one is not one defect but
# several. Overridable the way REF is: selftest.sh proves the guard below fires
# without pulling a thousand-issue fixture through comparison 6.
ISSUE_LIMIT="${PREFLIGHT_ISSUE_LIMIT:-1000}"
findings=0
say() { printf '%s\n' "$1"; }
hit() { printf '  DRIFT %s\n' "$1"; findings=$((findings + 1)); }
ok() { printf '  ok    %s\n' "$1"; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

if [ -z "${PREFLIGHT_SPEC_FILE:-}${PREFLIGHT_ROADMAP_FILE:-}" ]; then
  git fetch -q origin 2>/dev/null || true
fi

if [ -n "${PREFLIGHT_SPEC_FILE:-}" ]; then cp "$PREFLIGHT_SPEC_FILE" "$tmp/spec.md"
else git show "$REF:$SPEC_PATH" > "$tmp/spec.md" || exit 2; fi
if [ -n "${PREFLIGHT_ROADMAP_FILE:-}" ]; then cp "$PREFLIGHT_ROADMAP_FILE" "$tmp/roadmap.md"
else git show "$REF:ROADMAP.md" > "$tmp/roadmap.md" || exit 2; fi

if [ -n "${PREFLIGHT_ISSUES_FILE:-}" ]; then cp "$PREFLIGHT_ISSUES_FILE" "$tmp/issues.json"
else gh issue list --state all --limit "$ISSUE_LIMIT" --json number,title,state,milestone > "$tmp/issues.json" || exit 2; fi
jq -r '.[] | "\(.number)\t\(.state)\t\(.milestone.title // "NONE")\t\(.title)"' "$tmp/issues.json" | tr -d '\r' > "$tmp/issues.tsv"

# The test tree at the ref, as text: every line under tests/ that names an
# invariant. Read from the ref like everything else, so an uncommitted test
# cannot make comparison 1 pass.
if [ -n "${PREFLIGHT_TESTS_FILE:-}" ]; then cp "$PREFLIGHT_TESTS_FILE" "$tmp/tests.txt"
else git grep -h -E 'Invariant [0-9]+' "$REF" -- tests > "$tmp/tests.txt" 2>/dev/null || : > "$tmp/tests.txt"; fi

grep -oE '^### Invariant [0-9]+' "$tmp/spec.md" | sed 's/^### //' | sort -u > "$tmp/spec-invariants.txt"
B='(^|[^A-Za-z0-9])'; A='([^0-9]|$)'

# The board every comparison below reads, and whether all of it arrived. A short
# fetch is invisible from inside a comparison: 2, 4 and 6 under-report in
# silence. This is a precondition rather than a comparison, which is why it
# carries no number. Counted from the JSON rather than the TSV's line count,
# because a title carrying a newline would make the cheaper form over-count and
# mask the very case this guards.
#
# `gh issue list --limit N` pages internally until N is satisfied, and the
# `--paginate` trap does not reach it: that one is about `gh api --paginate
# --jq` running the filter once per page.
say "the board:"
issues=$(jq 'length' "$tmp/issues.json")
if [ "$issues" -ge "$ISSUE_LIMIT" ]; then
  hit "the fetch returned $issues issues against a limit of $ISSUE_LIMIT, so every comparison below is reading a truncated board"
else
  ok "all $issues issues fetched, under a limit of $ISSUE_LIMIT"
fi

say "1. untested — invariants $SPEC_PATH declares and no test under tests/ names:"
found=0
if [ ! -s "$tmp/spec-invariants.txt" ]; then
  hit "$SPEC_PATH declares no '### Invariant <n>' heading, so this comparison has nothing to hold"; found=1
fi
while IFS= read -r inv; do
  if ! grep -qE "${B}${inv}${A}" "$tmp/tests.txt"; then
    hit "$inv is declared by $SPEC_PATH and no test names it"; found=1
  fi
done < "$tmp/spec-invariants.txt"
[ "$found" -eq 0 ] && ok "every declared invariant is named by a test"

say "2. orphan — issue titles naming an invariant the spec no longer declares:"
found=0
cut -f4 "$tmp/issues.tsv" | grep -oE "${B}Invariant [0-9]+${A}" | grep -oE 'Invariant [0-9]+' | sort -u > "$tmp/issue-invariants.txt"
while IFS= read -r inv; do
  if ! grep -qxF "$inv" "$tmp/spec-invariants.txt"; then
    hit "an issue names $inv and $SPEC_PATH no longer declares it"; found=1
  fi
done < "$tmp/issue-invariants.txt"
[ "$found" -eq 0 ] && ok "no issue names a retired invariant"

say "3. state — roadmap marks vs issue state:"
# One awk for every row, since a process per row is most of the run.
grep -oE '^\| *(✅|🔨|⬜) *\|.*\[#[0-9]+\]' "$tmp/roadmap.md" |
awk -F'\t' '
  FILENAME == ARGV[1] { state[$1] = $2; next }
  {
    # A row names its issue in its last cell. A row may cite a second issue in
    # its task prose (`Blocks`, `Closed by`), so the first link is wrong.
    match($0, /\[#[0-9]+\]$/)
    n = substr($0, RSTART + 2, RLENGTH - 3)
    # A deleted issue, a transferred one and a mistyped `#N` all land here, and
    # the board guard above cannot see them: it counts what arrived.
    if (!(n in state)) { printf "  DRIFT row cites #%s, which the tracker does not have\n", n; next }
    if (index($0, "| ✅") == 1) { if (state[n] == "OPEN") printf "  DRIFT row marked done, issue #%s is open\n", n }
    else if (state[n] == "CLOSED") printf "  DRIFT row not marked done, issue #%s is closed\n", n
  }' "$tmp/issues.tsv" - > "$tmp/state.out"
if [ -s "$tmp/state.out" ]; then cat "$tmp/state.out"; findings=$((findings + $(wc -l < "$tmp/state.out"))); else ok "every roadmap mark agrees with its issue"; fi

say "4. unfiled — open issues with no milestone (invisible to step 1 forever):"
awk -F'\t' '$2 == "OPEN" && $3 == "NONE" { printf "  DRIFT #%s has no milestone: %s\n", $1, $4 }' "$tmp/issues.tsv" > "$tmp/unfiled.out"
if [ -s "$tmp/unfiled.out" ]; then cat "$tmp/unfiled.out"; findings=$((findings + $(wc -l < "$tmp/unfiled.out"))); else ok "every open issue has a milestone"; fi

say "5. milestone drift — step 1's answer vs the roadmap's section order:"
if [ -z "${PREFLIGHT_SPEC_FILE:-}${PREFLIGHT_ROADMAP_FILE:-}" ]; then
  gh api "repos/{owner}/{repo}/milestones?state=open&per_page=100" > "$tmp/ms.json"
  step1=$(NEXT_MILESTONES_FILE="$tmp/ms.json" sh "$(dirname "$0")/next.sh" | sed -n 's/^milestone: //p' | tr -d '\r')
  grep -oE '^## Phase [0-9]+.*' "$tmp/roadmap.md" | sed 's/^## //' | tr -d '\r' > "$tmp/order.txt"
  jq -r '.[] | select(.open_issues > 0) | .title' "$tmp/ms.json" | tr -d '\r' > "$tmp/withwork.txt"
  jq -r '.[] | select(.open_issues > 0) | select((.description // "") | startswith("Shelf:")) | .title' "$tmp/ms.json" | tr -d '\r' > "$tmp/shelved.txt"
  roadmap_says=""
  while IFS= read -r s; do
    grep -qxF "$s" "$tmp/withwork.txt" || continue
    grep -qxF "$s" "$tmp/shelved.txt" && continue
    roadmap_says="$s"; break
  done < "$tmp/order.txt"
  if [ "$step1" = "$roadmap_says" ]; then ok "step 1 and the roadmap agree: ${step1:-<no eligible work>}"
  else hit "step 1 says '${step1:-<empty>}', roadmap section order says '${roadmap_says:-<empty>}'"; fi
  # Shelved milestones are exempt from the section check: a shelf holds no
  # place in the take-order, so it owes the file no `## Phase <n>` section.
  LC_ALL=C sort "$tmp/withwork.txt" > "$tmp/ww.all"
  LC_ALL=C sort "$tmp/shelved.txt" > "$tmp/sh.s"
  LC_ALL=C comm -23 "$tmp/ww.all" "$tmp/sh.s" > "$tmp/ww.s"
  LC_ALL=C sort "$tmp/order.txt" > "$tmp/or.s"
  LC_ALL=C comm -23 "$tmp/ww.s" "$tmp/or.s" > "$tmp/ms-orphans.out"
  if [ -s "$tmp/ms-orphans.out" ]; then
    sed 's/^/  DRIFT milestone with work and no roadmap section: /' "$tmp/ms-orphans.out"
    findings=$((findings + $(wc -l < "$tmp/ms-orphans.out")))
  else ok "every open milestone with work has a roadmap section"; fi
else
  say "  (skipped under test seams — needs the live tracker)"
fi

say "6. missing row — issues the roadmap never mentions:"
# Every `#N` the roadmap mentions, collected in one pass. A mention has no
# letter or digit on either side. `grep -o` with boundary groups would consume
# the separator and lose the second of `#1,#2`.
awk -F'\t' '
  FILENAME == ARGV[1] {
    off = 0
    while (match(substr($0, off + 1), /#[0-9]+/)) {
      s = off + RSTART; e = s + RLENGTH
      if (substr($0, s - 1, 1) !~ /[A-Za-z0-9]/ && substr($0, e, 1) !~ /[A-Za-z0-9]/) seen[substr($0, s + 1, RLENGTH - 1)] = 1
      off = e - 1
    }
    next
  }
  !($1 in seen) { printf "  DRIFT #%s has no roadmap mention: %s\n", $1, $4 }' "$tmp/roadmap.md" "$tmp/issues.tsv" > "$tmp/missing.out"
if [ -s "$tmp/missing.out" ]; then cat "$tmp/missing.out"; findings=$((findings + $(wc -l < "$tmp/missing.out"))); else ok "every issue has a roadmap mention"; fi

# 7 answers "is this issue in flight", not "is anything", so it needs the issue.
# A session holds an issue before its row says so: step 3 posts the plan on the
# issue and step 8 flips the row, so no step marks it started.
if [ -n "$TAKEN" ]; then
  say "7. in flight — another session's work on #$TAKEN:"
  if [ -n "${PREFLIGHT_REFS_FILE:-}" ]; then cp "$PREFLIGHT_REFS_FILE" "$tmp/refs.txt"
  else
    { git worktree list --porcelain | awk '/^worktree / { w = substr($0, 10) } /^branch refs\/heads\// { print "worktree " w " on " substr($0, 19) }'
      git branch -a --format='branch %(refname:short)'; } > "$tmp/refs.txt"
  fi
  if [ -n "${PREFLIGHT_COMMENTS_FILE:-}" ]; then cp "$PREFLIGHT_COMMENTS_FILE" "$tmp/comments.json"
  else gh issue view "$TAKEN" --json comments > "$tmp/comments.json" || exit 2; fi
  grep -E "[^0-9]${TAKEN}([^0-9]|\$)" "$tmp/refs.txt" | sed 's/^/  DRIFT /' > "$tmp/flight.out"
  jq -r '.comments[] | select(.body | test("^\\W*(approved )?plan\\b"; "i")) | "  DRIFT a plan comment by \(.author.login), \(.createdAt)"' "$tmp/comments.json" | tr -d '\r' >> "$tmp/flight.out"
  if [ -s "$tmp/flight.out" ]; then cat "$tmp/flight.out"; findings=$((findings + $(wc -l < "$tmp/flight.out"))); else ok "no worktree, branch or plan names #$TAKEN"; fi
fi

# 8 cannot say a reason is false, only that it names something that changed
# since: a closed issue, a retired invariant, a phase with no open milestone.
# Only the Why cell counts. The Surfaced cell names where the row came from,
# which is closed by the time anyone reads it.
say "8. stale reasons — open shelf rows whose reason names what has since changed (read these):"
if [ -s "$tmp/ms.json" ]; then jq -r '.[].title' "$tmp/ms.json" | tr -d '\r' > "$tmp/open-ms.txt"; else : > "$tmp/open-ms.txt"; fi
awk '/^## Deferral shelf/ { on = 1; next } /^## / { on = 0 } on && /^\| [^-|]/' "$tmp/roadmap.md" |
awk -F'\t' '
  FILENAME == ARGV[1] { state[$1] = $2; next }
  FILENAME == ARGV[2] { declared[$0] = 1; next }
  FILENAME == ARGV[3] { phases = 1; if (match($0, /^Phase [0-9]+/)) open[substr($0, 1, RLENGTH)] = 1; next }
  {
    split($0, cell, "|")
    if (!match(cell[2], /\[#[0-9]+\]/)) next
    own = substr(cell[2], RSTART + 2, RLENGTH - 3)
    if (state[own] != "OPEN") next
    why = cell[5]; out = ""
    split(cell[3], surfaced, ",")
    for (w = why; match(w, /#[0-9]+/); w = substr(w, RSTART + RLENGTH)) {
      m = substr(w, RSTART + 1, RLENGTH - 1)
      if (state[m] == "CLOSED" && surfaced[1] !~ ("#" m "$") && index(out, " #" m " ") == 0) out = out " #" m " (closed),"
    }
    for (w = why; match(w, /Invariant [0-9]+/); w = substr(w, RSTART + RLENGTH)) {
      t = substr(w, RSTART, RLENGTH)
      if (substr(w, RSTART + RLENGTH, 1) !~ /[0-9]/ && !(t in declared) && index(out, " " t " ") == 0) out = out " " t " (retired),"
    }
    for (w = why; phases && match(w, /Phase [0-9]+/); w = substr(w, RSTART + RLENGTH)) {
      p = substr(w, RSTART, RLENGTH)
      if (!(p in open) && index(out, " " p " ") == 0) out = out " " p " (closed),"
    }
    if (out != "") { sub(/,$/, "", out); printf "  read  #%s: its reason cites%s\n", own, out }
  }' "$tmp/issues.tsv" "$tmp/spec-invariants.txt" "$tmp/open-ms.txt" - > "$tmp/stale.out"
if [ -s "$tmp/stale.out" ]; then cat "$tmp/stale.out"; else ok "no open shelf reason names a closed issue, retired invariant or closed phase"; fi

if [ "$findings" -eq 0 ]; then say "pre-flight clean"; else say "$findings finding(s) — fix in this pass, not a note"; exit 1; fi
