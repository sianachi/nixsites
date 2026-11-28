#!/usr/bin/env bash
# Runs, or with LIST=1 only lists, one shard of the integration suite (see integration-shard.mjs).
# SHARD is 1..K, or "all" for the unsplit suite (the guard's reference). A pull request sets
# SKIP_PLAN_EVIDENCE=1: the plan evidence classes run on main pushes only, as before the split.
set -euo pipefail
shard="${1:?shard number or all}"
args=(--project tests/Nix.Integration.Tests/Nix.Integration.Tests.csproj --configuration Release --no-build)
if [ "$shard" != all ]; then
  while IFS= read -r line; do args+=("$line"); done < <(node "$(dirname "$0")/integration-shard.mjs" "$shard")
fi
[ "${SKIP_PLAN_EVIDENCE:-}" = 1 ] && args+=(--filter-not-trait "Category=PlanEvidence")
if [ "${LIST:-}" = 1 ]; then args+=(--list-tests); else args+=(--output Detailed); fi
cd "$(dirname "$0")/../../backend"
dotnet test "${args[@]}"
