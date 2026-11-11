#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
example="$root/examples/slack"
release="$example/.release"

rm -rf "$release"
mkdir -p "$release"

node "$root/scripts/release.mjs" build "$release"
docker build -f "$example/Dockerfile" -t fevex-slack-example:local "$example"

size=$(docker image inspect fevex-slack-example:local --format '{{.Size}}')
awk -v bytes="$size" 'BEGIN { printf "Built fevex-slack-example:local (%.1f MB)\n", bytes / 1024 / 1024 }'
