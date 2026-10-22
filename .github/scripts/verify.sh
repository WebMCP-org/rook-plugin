#!/usr/bin/env bash
# The gate every copy of this repository passes: its release, and Rook's
# monorepo CI on the mirror before it ships. Run after `npm ci`.
set -euo pipefail
cd "$(dirname "$0")/../.."

name="$(jq -er .name package.json)"
version="$(jq -er .version package.json)"

npm run typecheck
npm test
npm exec --no -- vp run build
test "$(node bin/rook --version)" = "rook $version ($name)"
