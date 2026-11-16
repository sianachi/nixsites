#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
exec node --experimental-strip-types "$root/apps/cli/src/bin.ts" "$@"
