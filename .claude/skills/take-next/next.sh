#!/bin/sh
# Names the milestone the next task is taken from, then lists its open issues.
#
# The order is the phase number at the start of the title. It is deterministic
# and needs no metadata, where the milestone due date was null on every row and
# so sorted nothing. A title not beginning `Phase <n>` sorts last rather than
# vanishing, which is what the `// "9999"` fallback holds: with it removed,
# `scan` fails loudly where `capture` would drop the row in silence, so `scan`
# is the form to keep. A milestone whose description begins `Shelf:` is never
# selected, and a milestone with no open issues is not a place to look, so a
# finished phase left open cannot answer.
#
# Usage: next.sh [--ranked]
#   --ranked  print every eligible milestone in take order, not only the first
#
# Test seam: NEXT_MILESTONES_FILE substitutes a fixture for the tracker fetch,
# and the issue listing is then skipped.
set -eu

SELECT='[ .[]
    | select(.open_issues > 0)
    | select((.description // "") | startswith("Shelf:") | not)
    | { order: (((.title | [scan("^Phase +([0-9]+)")[]] | first) // "9999") | tonumber), title: .title }
  ] | sort_by(.order, .title) | .[].title'

if [ -n "${NEXT_MILESTONES_FILE:-}" ]; then
  ranked=$(jq -r "$SELECT" "$NEXT_MILESTONES_FILE" | tr -d '\r')
else
  # per_page=100 and no --paginate: `gh api --paginate --jq` runs its filter
  # once per page and emits one answer per page.
  ranked=$(gh api "repos/{owner}/{repo}/milestones?state=open&per_page=100" | jq -r "$SELECT" | tr -d '\r')
fi

if [ "${1:-}" = "--ranked" ]; then
  printf '%s\n' "$ranked"
  exit 0
fi

title=$(printf '%s\n' "$ranked" | head -n 1)
if [ -z "$title" ]; then
  echo "no eligible milestone: what is left is shelved, exhausted, or nothing. Read which before acting."
  exit 0
fi
printf 'milestone: %s\n' "$title"
[ -n "${NEXT_MILESTONES_FILE:-}" ] && exit 0
gh issue list --state open --milestone "$title"
