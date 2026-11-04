#!/usr/bin/env bash
# Exercises drift.sh against a stubbed docker; never contacts a Docker daemon.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir "$fixture/bin"
cat > "$fixture/bin/docker" <<'STUB'
#!/usr/bin/env bash
case "$1 $*" in
  'ps '*) cat "$DRIFT_FIXTURE/ids" ;;
  'inspect '*) cat "$DRIFT_FIXTURE/running" ;;
  *' config --hash '*) cat "$DRIFT_FIXTURE/desired" ;;
  *) echo "unexpected docker call: $*" >&2; exit 9 ;;
esac
STUB
chmod +x "$fixture/bin/docker"
export PATH="$fixture/bin:$PATH" DRIFT_FIXTURE="$fixture"
manifest=/srv/nix-release-new/deploy/compose.prod.yml
drift() { bash "$root/deploy/compose/drift.sh" docker compose -p nix --env-file /private/env -f "$manifest"; }
fail() { echo "drift.test: $*" >&2; exit 1; }
running() { printf '%s|%s|%s\n' "$1" "$2" "$3"; } # service hash config-files
printf '%s\n' 'postgres 1' 'nix-api 3-new' 'nix-versitygw 5' > "$fixture/desired"

# 1. Nothing running: every service is created, no refusal.
: > "$fixture/ids"
drift > "$fixture/out" 2>&1 || fail 'refused an empty project'
grep -q 'every service will be created' "$fixture/out" || fail 'empty project not reported'
printf '%s\n' c1 c2 c3 c4 c5 > "$fixture/ids"

# 2. Same files, only the application changed: recreate list names it; no warning.
{ running postgres 1 "$manifest"; running nix-api 3 "$manifest"
  running nix-opensearch 4 "$manifest"; running nix-versitygw 5 "$manifest"; } > "$fixture/running"
drift > "$fixture/out" 2>&1 || fail 'refused an application-only change'
grep -qx 'drift: Compose will recreate: nix-api ' "$fixture/out" || fail 'nix-api recreate not listed'
if grep -q WARNING "$fixture/out"; then fail 'warned about matching config files'; fi

# 3. Old checkouts and an override in the running label: loud warning.
old=/home/nix/nix-pr23/deploy/compose.prod.yml,/home/nix/nix-release-14e0a39d/deploy/compose.host.yml
{ running postgres 1 "$old"; running nix-api 3 "$old"
  running nix-opensearch 4 "$old"; running nix-versitygw 5 "$old"; running legacy-media 9 "$old"; } > "$fixture/running"
drift > "$fixture/out" 2>&1 || fail 'refused an application recreate'
grep -q "WARNING: project 'nix' is running from different Compose files" "$fixture/out" || fail 'no drift warning'
grep -q '/home/nix/nix-release-14e0a39d/deploy/compose.host.yml' "$fixture/out" || fail 'override not listed'
grep -q 'will recreate: nix-api ' "$fixture/out" || fail 'nix-api recreate not listed'
if grep -q 'refusing' "$fixture/out"; then fail 'refused an application recreate'; fi
grep -q 'left alone): legacy-media' "$fixture/out" || fail 'orphan not listed'
grep -q 'nix-opensearch' "$fixture/out" || fail 'retired OpenSearch orphan not listed'

# 3b. An application-only recreate is listed but not refused.
{ running postgres 1 "$manifest"; running nix-api 3 "$manifest"
  running nix-opensearch 4 "$manifest"; running nix-versitygw 5 "$manifest"; } > "$fixture/running"
drift > "$fixture/out" 2>&1 || fail 'refused a non-infrastructure recreate'
grep -q 'will recreate: nix-api' "$fixture/out" || fail 'nix-api recreate not listed'

# 4. Infrastructure would be recreated: refused unless explicitly allowed.
{ running postgres 0 "$manifest"; running nix-api 3 "$manifest"
  running nix-opensearch 4 "$manifest"; running nix-versitygw 5 "$manifest"; } > "$fixture/running"
status=0
drift > "$fixture/out" 2>&1 || status=$?
[ "$status" = 3 ] || fail "infrastructure recreate exited $status, expected 3"
grep -q 'refusing to recreate infrastructure: postgres' "$fixture/out" || fail 'refusal does not name postgres'
NIX_ALLOW_INFRA_RECREATE=1 drift > "$fixture/out" 2>&1 || fail 'override did not allow infrastructure recreate'

# 5. A missing infrastructure service is created, not refused.
{ running nix-api 3 "$manifest"; running nix-opensearch 4 "$manifest"
  running nix-versitygw 5 "$manifest"; } > "$fixture/running"
drift > "$fixture/out" 2>&1 || fail 'refused creating a missing service'
grep -q 'will create: postgres' "$fixture/out" || fail 'create not listed'
echo 'drift.sh checks passed.'
