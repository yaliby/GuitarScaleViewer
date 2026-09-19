#!/usr/bin/env bash
# The Cloudflare worker is a separate package with its own tsconfig, so it cannot import from
# ../src. These modules are therefore copied verbatim; `sharedWorkerSources.test.ts` fails the
# build if the two sides drift, which is how the worker ended up serving a stale key parser.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
files=(nameNormalize.ts keyParse.ts)

for file in "${files[@]}"; do
  cp "$root/src/services/$file" "$root/chordsync-api/src/$file"
  echo "synced $file"
done
