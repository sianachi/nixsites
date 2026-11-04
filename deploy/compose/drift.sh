#!/usr/bin/env bash
# Preview what a Compose rollout will change before any container is touched.
#
#   drift.sh docker compose -p <project> [--env-file <file>] -f <manifest> [-f <manifest> ...]
#
# Takes the same Compose command the release uses. It never starts, stops or
# recreates anything. It:
#   - warns when the running project was created from different Compose files
#     (com.docker.compose.project.config_files), for example an old checkout or override;
#   - lists services whose config hash differs from their running container, which
#     `up` will recreate, and services that `up` would create;
#   - exits 3 when a stateful infrastructure service (postgres, versitygw) would be
#     recreated, unless NIX_ALLOW_INFRA_RECREATE=1. NIX_INFRA_SERVICES overrides that list;
# Image-only changes under an unchanged tag are not detected; release tags are immutable.
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo 'usage: drift.sh docker compose -p PROJECT [--env-file FILE] -f FILE [-f FILE ...]' >&2
  exit 2
fi
compose=("$@")
project=''
files=()
i=0
while [ "$i" -lt "${#compose[@]}" ]; do
  case "${compose[$i]}" in
    -p|--project-name) project=${compose[$((i + 1))]:-} ;;
    -f|--file) files+=("${compose[$((i + 1))]:-}") ;;
  esac
  i=$((i + 1))
done
if [ -z "$project" ] || [ "${#files[@]}" -eq 0 ]; then
  echo 'drift: the Compose command must name the project (-p) and at least one file (-f)' >&2
  exit 2
fi
read -r -a infra <<< "${NIX_INFRA_SERVICES:-postgres nix-versitygw}"

# Compose records absolute manifest paths joined by commas.
expected=''
for f in "${files[@]}"; do
  case "$f" in /*) ;; *) f="$PWD/$f" ;; esac
  expected="${expected:+$expected,}$f"
done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# One row per service container (one-off `run` containers excluded): service|hash|config files.
docker ps -a -q --filter "label=com.docker.compose.project=$project" \
  --filter label=com.docker.compose.oneoff=False > "$work/ids"
if [ -s "$work/ids" ]; then
  # shellcheck disable=SC2046 # container IDs are single words
  docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.config-hash"}}|{{index .Config.Labels "com.docker.compose.project.config_files"}}' \
    $(cat "$work/ids") > "$work/running"
else
  : > "$work/running"
fi
"${compose[@]}" config --hash '*' > "$work/desired"

if [ ! -s "$work/running" ]; then
  echo "drift: no running containers in project '$project'; every service will be created."
  exit 0
fi

cut -d'|' -f3 "$work/running" | sort -u > "$work/labels"
if grep -qvxF -e "$expected" "$work/labels"; then
  {
    echo '################################################################'
    echo "WARNING: project '$project' is running from different Compose files."
    echo "Deploying:"
    echo "$expected" | tr ',' '\n' | sed 's/^/    /'
    echo 'Running containers were created from:'
    grep -vxF -e "$expected" "$work/labels" | tr ',' '\n' | sed 's/^/    /'
    echo 'Overrides or old checkouts in that list will no longer apply; review the'
    echo 'recreate list below before continuing.'
    echo '################################################################'
  } >&2
fi

awk -F'|' 'NR == FNR { running[$1] = running[$1] " " $2; next }
  NF {
    split($0, pair, /[ \t]+/); svc = pair[1]; hash = pair[2]
    if (!(svc in running)) { print "create " svc; next }
    n = split(running[svc], hashes, " ")
    for (k = 1; k <= n; k++) if (hashes[k] != hash) { print "recreate " svc; next }
  }' "$work/running" "$work/desired" > "$work/plan"
awk -F'|' 'NR == FNR { split($0, pair, /[ \t]+/); desired[pair[1]] = 1; next }
  !($1 in desired) { print "orphan " $1 }' "$work/desired" "$work/running" | sort -u >> "$work/plan"

recreate=$(awk '$1 == "recreate" { printf "%s ", $2 }' "$work/plan")
create=$(awk '$1 == "create" { printf "%s ", $2 }' "$work/plan")
orphan=$(awk '$1 == "orphan" { printf "%s ", $2 }' "$work/plan")
echo "drift: Compose will recreate: ${recreate:-none}"
[ -z "$create" ] || echo "drift: Compose will create: $create"
[ -z "$orphan" ] || echo "drift: running but not in this manifest (left alone): $orphan"

blocked=''
for svc in "${infra[@]}"; do
  case " $recreate" in *" $svc "*) blocked="$blocked $svc" ;; esac
done
if [ -n "$blocked" ]; then
  if [ "${NIX_ALLOW_INFRA_RECREATE:-}" = 1 ]; then
    echo "drift: NIX_ALLOW_INFRA_RECREATE=1; infrastructure will be recreated:$blocked" >&2
  else
    echo "drift: refusing to recreate infrastructure:$blocked" >&2
    echo "drift: compare 'docker compose config' with the running containers, then set" >&2
    echo 'drift: NIX_ALLOW_INFRA_RECREATE=1 to accept the restart. Nothing has been changed.' >&2
    exit 3
  fi
fi
