#!/usr/bin/env bash
# Rebuild tests/fixtures/shards/minimal-shard.tar.gz from examples/minimal-shard/.
#
# Real GitHub tarballs include a top-level wrapper directory (`<repo>-<sha>/`).
# `download.ts` extracts with `strip: 1`, so the fixture must mirror that
# shape. We achieve it by tar-ing the `minimal-shard/` directory itself with
# `examples/` as the cwd — the tarball's leaf paths become
# `minimal-shard/<file>`, and `strip: 1` peels that off on extraction.
#
# Run this whenever `examples/minimal-shard/` changes. CI does not regenerate;
# the fixture is committed.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO_ROOT/examples/minimal-shard"
OUT="$REPO_ROOT/tests/fixtures/shards/minimal-shard.tar.gz"

if [ ! -d "$SRC" ]; then
  echo "error: source not found at $SRC" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"

tar -czf "$OUT" -C "$REPO_ROOT/examples" minimal-shard

echo "Built $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"
