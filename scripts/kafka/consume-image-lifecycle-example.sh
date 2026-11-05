#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

cd "$repo_root/apps/storage"
TS_NODE_PROJECT=./tsconfig.json pnpm exec ts-node \
  -r tsconfig-paths/register \
  ../../examples/client-service/lifecycle-consumer.ts \
  "$@"
