#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../packages/magnitude-core"

# Accept the exact tarball already scanned and tested; default to the package directory.
TARGET="${1:-.}"

VERSION=$(node -p "require('./package.json').version")

echo "=== Dry run: contents of @ddwang/magnitude-core@$VERSION ==="
npm pack --dry-run "$TARGET"
echo ""

echo "Publishing @ddwang/magnitude-core@$VERSION. Press enter to continue, Ctrl+C to abort."
read

npm publish "$TARGET" --access public --tag latest
