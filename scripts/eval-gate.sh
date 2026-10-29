#!/usr/bin/env bash
# Regression gate for the pet chat evals: run the suite against a live stack and fail only when
# it does worse than the committed baseline (packages/structure-spec/evals/chat/baseline.json).
#
# Run it against the local dev stack before committing a change to the pet's prompt, tools or
# reads. The suite talks to a real model, so it needs a pet with a connected provider. Core's
# write limit (Nix__RateLimits__WritesPerMinute, default 120 a minute per address) can throttle a
# long run; raise it in the local API's environment, never in production.
#
# Usage: scripts/eval-gate.sh <profile> <workspace-id> <pet-id> [case-or-prefix*]
#   RUNS=2 (default) repeats each case; RECORD=1 records a new baseline instead of gating.
# Replies stay in memory: this script never sets NIX_EVAL_ANSWERS_DIR, since replies can quote
# workspace content.
set -euo pipefail

if [ $# -lt 3 ]; then
  sed -n '2,13p' "$0" >&2
  exit 2
fi
profile=$1
workspace=$2
pet=$3
case_filter=${4:-}
runs=${RUNS:-2}
repo_root=$(git rev-parse --show-toplevel)
baseline="$repo_root/packages/structure-spec/evals/chat/baseline.json"

args=(--profile "$profile" pet eval --suite chat --workspace "$workspace" --pet "$pet" --runs "$runs" --allow-writes)
[ -n "$case_filter" ] && args+=(--case "$case_filter")
if [ "${RECORD:-0}" = 1 ]; then
  [ -n "$case_filter" ] && { echo "Record a baseline from the whole suite, not a subset." >&2; exit 2; }
  args+=(--write-baseline "$baseline")
else
  args+=(--baseline "$baseline")
fi

cd "$repo_root"
node --experimental-strip-types apps/cli/src/index.ts "${args[@]}"
