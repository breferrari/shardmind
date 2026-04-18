#!/usr/bin/env bash
# Smoke-test the install command against a real GitHub-hosted shard.
#
# Prerequisite (one-time): publish a test shard to GitHub. Easiest way:
#
#   cp -r examples/minimal-shard /tmp/test-minimal-shard
#   cd /tmp/test-minimal-shard
#   git init && git add -A && git commit -m "initial"
#   gh repo create <your-user>/test-minimal-shard --public --source=. --push
#   git tag v0.1.0 && git push --tags
#
# Then export SHARDMIND_TEST_SHARD once:
#
#   export SHARDMIND_TEST_SHARD=github:<your-user>/test-minimal-shard
#
# Usage:
#
#   npm run smoke                 # runs non-interactive scenarios
#   npm run smoke -- --interactive  # pauses for manual TUI scenarios too

set -euo pipefail

SHARD_REF="${SHARDMIND_TEST_SHARD:-github:breferrari/test-minimal-shard}"
INTERACTIVE=false
for arg in "$@"; do
  case "$arg" in
    --interactive) INTERACTIVE=true ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$REPO_ROOT/dist/cli.js"
SANDBOX="$REPO_ROOT/.smoke"

say() { printf '\n\033[36m==>\033[0m %s\n' "$*"; }
fail() { printf '\n\033[31mFAIL:\033[0m %s\n' "$*" >&2; exit 1; }
pause() {
  if $INTERACTIVE; then
    printf '\n\033[33mPress Enter to continue...\033[0m'
    read -r
  fi
}

say "Building shardmind"
(cd "$REPO_ROOT" && npm run build >/dev/null)
[[ -f "$CLI" ]] || fail "Build did not produce $CLI"

say "Preparing sandbox at $SANDBOX"
rm -rf "$SANDBOX"
mkdir -p "$SANDBOX"

# Write a reusable values file for --yes runs
cat > "$SANDBOX/values.yaml" <<EOF
user_name: Smoke Tester
org_name: Test Org
vault_purpose: engineering
qmd_enabled: true
EOF

say "Scenario 1: --dry-run (no writes expected)"
(
  mkdir -p "$SANDBOX/dry-run" && cd "$SANDBOX/dry-run"
  node "$CLI" install "$SHARD_REF" --dry-run --values "$SANDBOX/values.yaml" --yes
  # Verify no state was written
  if [[ -d ".shardmind" ]]; then fail "dry-run wrote .shardmind/"; fi
  if [[ -f "Home.md" ]]; then fail "dry-run wrote Home.md"; fi
)
say "Scenario 1 OK"
pause

say "Scenario 2: --yes non-interactive install"
(
  mkdir -p "$SANDBOX/yes" && cd "$SANDBOX/yes"
  node "$CLI" install "$SHARD_REF" --values "$SANDBOX/values.yaml" --yes
  [[ -f "Home.md" ]] || fail "Home.md not written"
  [[ -f ".shardmind/state.json" ]] || fail "state.json not written"
  [[ -f "shard-values.yaml" ]] || fail "shard-values.yaml not written"
  grep -q "Smoke Tester" Home.md || fail "Home.md did not render user_name"
)
say "Scenario 2 OK"
pause

say "Scenario 3: --verbose on a fresh vault"
(
  mkdir -p "$SANDBOX/verbose" && cd "$SANDBOX/verbose"
  node "$CLI" install "$SHARD_REF" --values "$SANDBOX/values.yaml" --yes --verbose
  [[ -f "Home.md" ]] || fail "Home.md not written in verbose scenario"
)
say "Scenario 3 OK"
pause

say "Scenario 4: collision — pre-seed Home.md, install with --yes"
(
  mkdir -p "$SANDBOX/collision" && cd "$SANDBOX/collision"
  printf 'user content\n' > Home.md
  node "$CLI" install "$SHARD_REF" --values "$SANDBOX/values.yaml" --yes
  # With --yes, policy is back-up-and-continue
  if ! ls Home.md.shardmind-backup-* 1>/dev/null 2>&1; then
    fail "expected a backup file Home.md.shardmind-backup-*"
  fi
  # New content installed
  grep -q "Smoke Tester" Home.md || fail "Home.md not replaced with shard content"
)
say "Scenario 4 OK"
pause

say "Scenario 5: existing install — re-run in same dir (expect cancellation)"
(
  cd "$SANDBOX/yes"
  # Without --yes this would open the gate; with --yes the gate has no
  # non-interactive reinstall path, so we expect the CLI to surface an
  # error / cancellation. We don't assert pass/fail here — this scenario
  # is primarily informational to surface the current --yes policy.
  set +e
  node "$CLI" install "$SHARD_REF" --values "$SANDBOX/values.yaml" --yes
  echo "(exit code above documents current --yes behavior on re-install)"
  set -e
)
pause

if $INTERACTIVE; then
  say "Interactive scenarios — drive these manually:"
  cat <<EOF
  a) Fresh wizard:
     mkdir $SANDBOX/interactive-wizard && cd $SANDBOX/interactive-wizard
     node $CLI install $SHARD_REF

     Check: all value prompts, Esc back-nav, computed-default preview,
     module multiselect with live file-count, confirm screen Back option,
     summary next-step hint.

  b) Collision review:
     mkdir $SANDBOX/interactive-collide && cd $SANDBOX/interactive-collide
     echo "user" > Home.md
     node $CLI install $SHARD_REF
     Check: backup/overwrite/cancel choices all behave correctly.

  c) Existing-install gate:
     cd $SANDBOX/interactive-wizard
     node $CLI install $SHARD_REF
     Check: update/reinstall/cancel choices. Try typing wrong text at
     the REINSTALL prompt and confirm it's rejected.
EOF
fi

say "Smoke complete. Sandbox preserved at $SANDBOX for inspection."
