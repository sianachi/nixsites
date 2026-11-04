#!/usr/bin/env bash
# Run the whole local dev environment from one terminal.
#
# Brings up infrastructure, rebuilds the workspace packages, then starts Core,
# the Node host (collaboration, pet companion, sites worker), the sites server and the web dev
# server side by side.
# Output from each process is prefixed with its name and also written to .local/logs/<name>.log.
# Ctrl-C stops everything; if any one process exits, the rest are stopped too so a
# half-running stack is never left behind.
#
# Usage:
#   scripts/dev.sh                    # stack-up, then every process
#   scripts/dev.sh --skip-stack       # infrastructure is already up
#   scripts/dev.sh api web            # only the named processes
#
# Processes: api, node, sites-serve, web. Port overrides (NIX_API_PORT and
# friends) are read from the calling shell, exactly as the individual dev-*.sh scripts do.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

all_services="api node sites-serve web"
skip_stack=false
services=""

for arg in "$@"; do
  case "$arg" in
    --skip-stack) skip_stack=true ;;
    -h|--help)
      sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    api|node|sites-serve|web) services="$services $arg" ;;
    *)
      echo "dev: unknown argument '$arg' (expected --skip-stack or one of: $all_services)" >&2
      exit 2
      ;;
  esac
done
services="${services:-$all_services}"

service_command() {
  case "$1" in
    api) echo "bash scripts/dev-api.sh" ;;
    node) echo "bash scripts/dev-node.sh" ;;
    sites-serve) echo "bash scripts/dev-sites-serve.sh" ;;
    web) echo "pnpm --filter @nix/web dev" ;;
  esac
}

service_color() {
  case "$1" in
    api) echo 34 ;;
    node) echo 35 ;;
    sites-serve) echo 31 ;;
    web) echo 36 ;;
  esac
}

if [ "$skip_stack" = false ]; then
  bash scripts/dev-stack-up.sh
fi

# The web app and the node host import the workspace packages from their built dist/
# output, so a stale build after a pull fails at runtime with a missing export.
case " $services " in
  *" web "*|*" node "*) pnpm run prepare ;;
esac

log_dir="$repo_root/.local/logs"
mkdir -p "$log_dir"

# Each process runs in its own process group so stopping it also stops the
# children it spawns (dotnet, vite, the compiled Go binary).
set -m

pids=""
for name in $services; do
  cmd="$(service_command "$name")"
  label="$(printf '\033[%sm%-11s\033[0m | ' "$(service_color "$name")" "$name")"
  log_file="$log_dir/$name.log"
  (
    $cmd 2>&1 | tee "$log_file" | awk -v p="$label" '{ print p $0; fflush() }'
  ) &
  pids="$pids $!"
  echo "dev: started $name (log: ${log_file#"$repo_root"/})"
done

stopping=false
stop_all() {
  [ "$stopping" = true ] && return
  stopping=true
  echo
  echo "dev: stopping$services"
  for pid in $pids; do
    kill -TERM -- "-$pid" 2>/dev/null || true
  done
  for pid in $pids; do
    wait "$pid" 2>/dev/null || true
  done
}
trap 'stop_all; exit 130' INT TERM
trap 'stop_all' EXIT

echo "dev: web on ${NIX_WEB_ORIGIN:-http://localhost:${NIX_WEB_PORT:-5173}} - Ctrl-C stops everything"

# Bash 3.2 (macOS) has no `wait -n`, so poll for the first process to exit.
while :; do
  for pid in $pids; do
    if ! kill -0 "$pid" 2>/dev/null; then
      status=0
      wait "$pid" || status=$?
      echo "dev: a process exited (status $status); stopping the rest" >&2
      exit "$status"
    fi
  done
  sleep 1
done
