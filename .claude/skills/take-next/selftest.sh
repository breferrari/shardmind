#!/bin/sh
# Offline selftest for take-next's step-1 selection and the pre-flight grep.
# Needs only awk/grep. Run after any edit to the commands or the rules beside
# them. The drift check fails if this file and SKILL.md stop testing the same
# filter — in either direction.
set -u
here="$(dirname "$0")"
fails=0
ok() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; fails=$((fails + 1)); }

# The filter under test, verbatim from SKILL.md step 1.
FILTER='/^- \[ \]/ { print; exit }'
select_next() { awk "$FILTER"; }

echo "selection:"

r=$(printf -- '- [x] done thing (#1)\n- [ ] first open (#2)\n- [ ] second open (#3)\n' | select_next)
[ "$r" = "- [ ] first open (#2)" ] && ok "first unchecked wins, checked rows are skipped" || fail "first unchecked wins (got: $r)"

r=$(printf -- '## Milestone A\n- [x] a (#1)\n## Milestone B\n- [ ] b (#4)\n' | select_next)
[ "$r" = "- [ ] b (#4)" ] && ok "file order carries milestone order" || fail "file order carries milestone order (got: $r)"

r=$(printf -- '- [x] a (#1)\n- [x] b (#2)\n' | select_next)
[ -z "$r" ] && ok "a fully checked roadmap gives empty" || fail "fully checked gives empty (got: $r)"

r=$(printf -- 'prose mentioning - [ ] mid-line\n- [ ] real row (#9)\n' | select_next)
[ "$r" = "- [ ] real row (#9)" ] && ok "an unchecked marker mid-line is not a row" || fail "mid-line marker (got: $r)"

echo "mutation (the check must be able to fail):"
# Dropping the exit turns first-match into every-match: two lines, not one.
r=$(printf -- '- [ ] one (#1)\n- [ ] two (#2)\n' | awk '/^- \[ \] / { print }' | wc -l | tr -d ' ')
[ "$r" = "2" ] && ok "without exit, the filter over-returns (mutant detected)" || fail "mutant undetected"

echo "drift:"
if grep -qF "$FILTER" "$here/SKILL.md"; then
  ok "the tested filter is the one SKILL.md documents"
else
  fail "SKILL.md filter drifted from this test"
fi
if grep -qE '^[0-9]+\. \*\*Orphan issue\*\*' "$here/SKILL.md"; then
  ok "SKILL.md still names the orphan-issue direction"
else
  fail "orphan-issue comparison missing from SKILL.md"
fi

[ "$fails" -eq 0 ] && echo "all checks passed" || { echo "$fails check(s) failed"; exit 1; }
