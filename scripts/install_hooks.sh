#!/bin/sh
set -eu
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
chmod +x scripts/githooks/pre-commit scripts/build_netlify.sh
git config core.hooksPath scripts/githooks
echo "Configured Git hooks path -> scripts/githooks"
