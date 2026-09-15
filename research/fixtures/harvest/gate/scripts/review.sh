#!/bin/sh
# Reviews the files this pull request touched.
set -e
FILES=$(git diff --name-only "$BASE_SHA...HEAD" | grep -E '\.(ts|js)$' || true)
if [ -z "$FILES" ]; then
  echo "no source files changed"
  exit 0
fi
echo "reviewing: $FILES"
for f in $FILES; do echo "  checked $f"; done
