#!/usr/bin/env bash
# Verified local backup for the Compose deployment.
#
#   backup.sh <sha>          create and verify $NIX_BACKUP_ROOT/pre-<sha> (default ~/nix-backups)
#   backup.sh --nightly      create and verify $NIX_BACKUP_ROOT/nightly-<UTC YYYYmmddTHHMMSSZ>
#   backup.sh --check <dir>  exit 0 only for a complete backup whose restore verification passed
#
# Creation needs NIX_DEPLOY_ENV (absolute path to the private env file). Optional overrides:
# NIX_CORE_ACCESS_TOKEN_PEM, NIX_BACKUP_COMPOSE_FILE, NIX_BACKUP_CADDYFILE. Never deletes anything
# and never prints secrets: dumps, env and key copies go only to mode-600 files in a mode-700 dir.
#
# The Zitadel identity database (Compose project `zitadel`) is dumped too when its Postgres
# container runs: zitadel.dump and zitadel-roles.sql, restored into a second throwaway container.
# NIX_ZITADEL_DB_CONTAINER names the container instead of discovering it; NIX_ZITADEL_DB_NAME and
# NIX_ZITADEL_DB_USER default to zitadel and postgres. A missing Zitadel database is a warning
# unless NIX_REQUIRE_ZITADEL=1. Backups made before Zitadel capture have no zitadel files; --check
# accepts them (and notes it) unless NIX_REQUIRE_ZITADEL=1.
set -euo pipefail

project=nix
pg_image=pgvector/pgvector:pg16
volumes=(nix-versity-data nix-api-data-protection nix-companion-data)
data_files=(nix.dump roles.sql nix-versity-data.tar nix-api-data-protection.tar nix-companion-data.tar
  env.private core-access-token.pem compose.prod.yml Caddyfile.prod containers.private.json)
zitadel_files=(zitadel.dump zitadel-roles.sql)
row_count_tables=10

die() { echo "backup: $*" >&2; exit 1; }
usage() { echo 'usage: backup.sh <release-sha> | backup.sh --nightly | backup.sh --check <backup-dir>' >&2; exit 2; }

check_backup() {
  local dir=$1 name recorded actual present=0 covered note=''
  [[ $dir == /* ]] || die "backup directory must be an absolute path: $dir"
  [[ -d $dir ]] || die "backup directory does not exist: $dir"
  covered=("${data_files[@]}")
  for name in "${zitadel_files[@]}"; do
    if [[ -e $dir/$name ]]; then present=$((present + 1)); fi
  done
  if (( present == ${#zitadel_files[@]} )); then
    covered+=("${zitadel_files[@]}")
  elif (( present > 0 )); then
    die "incomplete zitadel backup in $dir: expected both ${zitadel_files[*]}"
  elif [[ ${NIX_REQUIRE_ZITADEL:-0} == 1 ]]; then
    die "no zitadel dump in $dir and NIX_REQUIRE_ZITADEL=1"
  else
    note="no zitadel dump in $dir (made before zitadel capture, or zitadel was not running)"
  fi
  for name in "${covered[@]}" SHA256SUMS verified.txt; do
    [[ -f $dir/$name ]] || die "missing $name in $dir"
    [[ -s $dir/$name ]] || die "empty $name in $dir"
  done
  if (( present > 0 )); then
    grep -qx 'zitadel=verified' "$dir/verified.txt" \
      || die "verified.txt does not record a verified zitadel restore in $dir"
  fi
  for name in "${covered[@]}"; do
    awk -v f="$name" '{ sub(/^\*/, "", $2) } $2 == f { found=1 } END { exit !found }' "$dir/SHA256SUMS" \
      || die "SHA256SUMS does not cover $name"
  done
  (cd "$dir" && sha256sum --quiet -c SHA256SUMS >/dev/null 2>&1) \
    || die "SHA256SUMS verification failed in $dir"
  grep -qx 'result=passed' "$dir/verified.txt" \
    || die "verified.txt does not record a passed restore verification"
  recorded=$(sed -n 's/^sha256sums=//p' "$dir/verified.txt")
  actual=$(sha256sum < "$dir/SHA256SUMS" | cut -d' ' -f1)
  [[ -n $recorded && $recorded == "$actual" ]] \
    || die 'verified.txt was not written for this SHA256SUMS'
  python3 - "$dir" <<'PY' || die "backup is readable by group or others: $dir"
import os, stat, sys
d = sys.argv[1]
paths = [d] + [os.path.join(d, n) for n in os.listdir(d)]
sys.exit(1 if any(os.stat(p).st_mode & 0o077 for p in paths) else 0)
PY
  echo "backup verified: $dir"
  if [[ -n $note ]]; then echo "backup: note: $note"; fi
}

if [[ ${1:-} == --check ]]; then
  [[ $# -eq 2 ]] || usage
  check_backup "$2"
  exit 0
fi
if [[ ${1:-} == --nightly ]]; then
  [[ $# -eq 1 ]] || usage
  kind=nightly sha=''
  label=nightly-$(date -u +%Y%m%dT%H%M%SZ)
  name=$label
else
  [[ $# -eq 1 && -n $1 && $1 != -* ]] || usage
  sha=$1
  [[ $sha =~ ^[0-9A-Za-z._-]+$ ]] || die 'release sha may contain only letters, digits, dot, dash and underscore'
  kind=release label=$sha name=pre-$sha
fi
: "${NIX_DEPLOY_ENV:?absolute path to the private production env file}"
[[ $NIX_DEPLOY_ENV == /* && -f $NIX_DEPLOY_ENV ]] || die 'NIX_DEPLOY_ENV must be an absolute path to a file'
command -v docker >/dev/null || die 'docker is required'
command -v sha256sum >/dev/null || die 'sha256sum is required'
command -v python3 >/dev/null || die 'python3 is required'

root=$(cd "$(dirname "$0")/../.." && pwd)
backup_root=${NIX_BACKUP_ROOT:-$HOME/nix-backups}
[[ $backup_root == /* ]] || die 'NIX_BACKUP_ROOT must be absolute'
dir=$backup_root/$name
umask 077

service_container() {
  local id
  id=$(docker ps -q --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=$1")
  [[ -n $id && $id != *$'\n'* ]] || die "expected exactly one running $1 container in project $project"
  echo "$id"
}
mount_source() {
  docker inspect --format "{{range .Mounts}}{{if eq .Destination \"$2\"}}{{.Source}}{{end}}{{end}}" "$1"
}

postgres=$(service_container postgres)
api=$(service_container nix-api)
versity=$(service_container nix-versitygw)
for vol in "${volumes[@]}"; do
  docker volume inspect "$vol" >/dev/null 2>&1 || die "volume $vol does not exist"
done
pem=${NIX_CORE_ACCESS_TOKEN_PEM:-$(mount_source "$api" /run/secrets/core-access-token.pem)}
[[ -n $pem && -f $pem ]] || die 'core access token pem not found; set NIX_CORE_ACCESS_TOKEN_PEM'
# Prefer the files the running stack was started from over this checkout's copies.
compose_file=${NIX_BACKUP_COMPOSE_FILE:-$(docker inspect --format \
  '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$api" | cut -d, -f1)}
[[ -f $compose_file ]] || compose_file=$root/deploy/compose.prod.yml
caddyfile=${NIX_BACKUP_CADDYFILE:-}
if [[ -z $caddyfile ]]; then
  caddy=$(docker ps -q --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=caddy" | head -n1)
  [[ -n $caddy ]] && caddyfile=$(mount_source "$caddy" /etc/caddy/Caddyfile)
  [[ -f $caddyfile ]] || caddyfile=$(dirname "$compose_file")/Caddyfile.prod
fi
[[ -f $compose_file && -f $caddyfile ]] || die 'compose or Caddy file not found; set NIX_BACKUP_COMPOSE_FILE/NIX_BACKUP_CADDYFILE'

# Zitadel runs as its own Compose project; its Postgres service is found by service name.
zitadel_db=${NIX_ZITADEL_DB_NAME:-zitadel}
zitadel_user=${NIX_ZITADEL_DB_USER:-postgres}
[[ $zitadel_db =~ ^[a-z_][a-z0-9_]*$ && $zitadel_user =~ ^[a-z_][a-z0-9_]*$ ]] \
  || die 'NIX_ZITADEL_DB_NAME and NIX_ZITADEL_DB_USER must be plain lowercase identifiers'
# shellcheck source=deploy/compose/zitadel-db.sh
source "$root/deploy/compose/zitadel-db.sh"
zitadel=$(find_zitadel_db)
if [[ -n $zitadel ]]; then
  zitadel_image=${NIX_ZITADEL_VERIFY_IMAGE:-$(docker inspect --format '{{.Config.Image}}' "$zitadel")}
  [[ -n $zitadel_image ]] || die "could not read the image of zitadel database container $zitadel"
elif [[ ${NIX_REQUIRE_ZITADEL:-0} == 1 ]]; then
  die 'no running zitadel database container and NIX_REQUIRE_ZITADEL=1; set NIX_ZITADEL_DB_CONTAINER'
else
  echo 'backup: warning: no running zitadel database container; this backup will not include zitadel' >&2
fi

[[ -e $dir ]] && die "$dir already exists; refusing to overwrite it (choose another NIX_BACKUP_ROOT)"
mkdir -p "$backup_root"
mkdir -m 700 "$dir"

paused='' verify_containers=() snapshot_pid='' snapshot_open='' snapshot_reply=''
# One psql session holds a REPEATABLE READ transaction whose exported snapshot pg_dump shares, so
# the row counts recorded in it describe exactly the dumped data even while writers stay live.
# The session is a background psql fed through FIFOs: fd 7 writes SQL, fd 8 reads results.
snapshot_start() {
  local fifos
  fifos=$(mktemp -d)
  mkfifo "$fifos/in" "$fifos/out"
  docker exec -i "$postgres" psql -X -At -q -v ON_ERROR_STOP=1 -U postgres -d nix \
    < "$fifos/in" > "$fifos/out" &
  snapshot_pid=$!
  exec 7> "$fifos/in" 8< "$fifos/out"
  snapshot_open=1
  rm -r "$fifos"
}
snapshot_send() { printf '%s\n' "$1" >&7 || die 'snapshot session closed unexpectedly'; }
snapshot_read() {
  IFS= read -r -t 120 snapshot_reply <&8 || die 'snapshot session ended or stalled'
}
snapshot_query() { snapshot_send "$1"; snapshot_read; }
# Closing stdin ends psql, which rolls back anything uncommitted; the kill is a last resort.
snapshot_stop() {
  local status=0
  if [[ -n $snapshot_open ]]; then exec 7>&-; fi
  if [[ -n $snapshot_pid ]]; then
    for _ in $(seq 1 30); do kill -0 "$snapshot_pid" 2>/dev/null || break; sleep 1; done
    kill "$snapshot_pid" 2>/dev/null || true
    wait "$snapshot_pid" 2>/dev/null || status=$?
    snapshot_pid=''
  fi
  if [[ -n $snapshot_open ]]; then exec 8<&-; snapshot_open=''; fi
  return "$status"
}
cleanup() {
  snapshot_stop || true
  if [[ -n $paused ]]; then docker unpause "$paused" >/dev/null || echo "backup: UNPAUSE $paused MANUALLY" >&2; fi
  for container in ${verify_containers[@]+"${verify_containers[@]}"}; do
    docker rm -f "$container" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT
trap 'exit 130' INT TERM
# A write to a dead snapshot session must fail through the EXIT trap, not kill the shell silently.
trap 'exit 141' PIPE

echo "backup: writing $dir"
snapshot_start
snapshot_send 'BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;'
snapshot_query 'SELECT pg_export_snapshot();'
snapshot_id=$snapshot_reply
[[ $snapshot_id =~ ^[0-9A-Fa-f-]+$ ]] || die 'could not export a database snapshot'
snapshot_query 'SELECT count(*) FROM pg_stat_user_tables;'
snapshot_tables=$snapshot_reply
snapshot_send "SELECT format('%I.%I', schemaname, relname) FROM pg_stat_user_tables
  ORDER BY n_live_tup DESC, 1 LIMIT $row_count_tables;"
snapshot_send "SELECT 'end-of-tables';"
count_tables=() snapshot_counts=()
while snapshot_read && [[ $snapshot_reply != end-of-tables ]]; do count_tables+=("$snapshot_reply"); done
for table in "${count_tables[@]+"${count_tables[@]}"}"; do
  snapshot_query "SELECT count(*) FROM $table;"
  snapshot_counts+=("$snapshot_reply")
done
docker exec "$postgres" pg_dump -U postgres -Fc --snapshot="$snapshot_id" nix > "$dir/nix.dump"
snapshot_send 'COMMIT;'
snapshot_stop || die 'snapshot session did not end cleanly'
docker exec "$postgres" pg_dumpall -U postgres --roles-only > "$dir/roles.sql"
files=("${data_files[@]}")
if [[ -n $zitadel ]]; then
  # Zitadel's schema changes only on its own upgrades, so the live table count is a fair check.
  zitadel_live_tables=$(docker exec "$zitadel" psql -X -At -U "$zitadel_user" -d "$zitadel_db" \
    -c 'SELECT count(*) FROM pg_stat_user_tables')
  docker exec "$zitadel" pg_dump -U "$zitadel_user" -Fc "$zitadel_db" > "$dir/zitadel.dump"
  docker exec "$zitadel" pg_dumpall -U "$zitadel_user" --roles-only > "$dir/zitadel-roles.sql"
  files+=("${zitadel_files[@]}")
fi
archive_volume() {
  docker run --rm --network none -v "$1:/data:ro" "$pg_image" tar -C /data -cf - . > "$dir/$1.tar"
}
archive_volume nix-api-data-protection
archive_volume nix-companion-data
# Versity must not change while archived; the EXIT trap unpauses it on any failure.
docker pause "$versity" >/dev/null
paused=$versity
archive_volume nix-versity-data
docker unpause "$versity" >/dev/null
paused=''
cp "$NIX_DEPLOY_ENV" "$dir/env.private"
cp "$pem" "$dir/core-access-token.pem"
cp "$compose_file" "$dir/compose.prod.yml"
cp "$caddyfile" "$dir/Caddyfile.prod"
# shellcheck disable=SC2046 # one argument per container id
docker inspect $(docker ps -aq --filter "label=com.docker.compose.project=$project") > "$dir/containers.private.json"
chmod 600 "$dir"/*
(cd "$dir" && sha256sum -- "${files[@]}" > SHA256SUMS && chmod 600 SHA256SUMS)
(cd "$dir" && sha256sum --quiet -c SHA256SUMS)

echo 'backup: restoring into an isolated container'
failures=() warnings=() report=()
start_verify() { # name image superuser
  verify_containers+=("$1")
  docker run -d --name "$1" --network none -e POSTGRES_HOST_AUTH_METHOD=trust -e "POSTGRES_USER=$3" \
    "$2" >/dev/null
  for _ in $(seq 1 60); do
    # The entrypoint's init server listens only on the socket; TCP means the final server is up.
    docker exec "$1" pg_isready -q -h 127.0.0.1 -U "$3" && break
    sleep 1
  done
  docker exec "$1" pg_isready -q -h 127.0.0.1 -U "$3" || die "verify container $1 did not start"
}
verify_container=nix-backup-verify-$label-$$
start_verify "$verify_container" "$pg_image" postgres
# The postgres role already exists in a fresh cluster; everything else must apply cleanly.
grep -vx 'CREATE ROLE postgres;' "$dir/roles.sql" \
  | docker exec -i "$verify_container" psql -q -X -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null
docker exec "$verify_container" createdb -U postgres nix
docker exec -i "$verify_container" pg_restore -U postgres -d nix --exit-on-error < "$dir/nix.dump"

restored_sql() { docker exec "$verify_container" psql -X -At -U postgres -d nix -c "$1"; }
restored_tables=$(restored_sql 'SELECT count(*) FROM pg_stat_user_tables')
report+=("tables snapshot=$snapshot_tables restored=$restored_tables")
[[ $snapshot_tables == "$restored_tables" ]] \
  || failures+=("table count snapshot=$snapshot_tables restored=$restored_tables")
for i in "${!count_tables[@]}"; do
  table=${count_tables[$i]} expected=${snapshot_counts[$i]}
  restored=$(restored_sql "SELECT count(*) FROM $table")
  report+=("rows $table snapshot=$expected restored=$restored")
  [[ $expected == "$restored" ]] || failures+=("rows $table snapshot=$expected restored=$restored")
done

archive_entries() {
  python3 - "$1" <<'PY'
import sys, tarfile
with tarfile.open(sys.argv[1]) as t:
    print(sum(1 for m in t if m.name.rstrip('/') not in ('', '.')))
PY
}
for vol in "${volumes[@]}"; do
  live=$(docker run --rm --network none -v "$vol:/data:ro" "$pg_image" sh -c 'find /data -mindepth 1 | wc -l' | tr -d ' ')
  archived=$(archive_entries "$dir/$vol.tar")
  report+=("files $vol live=$live archived=$archived")
  [[ $live == "$archived" ]] && continue
  diff=$(( live > archived ? live - archived : archived - live ))
  # Companion data changes constantly; tolerate small drift there only.
  if [[ $vol == nix-companion-data ]] && (( diff <= 10 || diff * 20 <= live )); then
    warnings+=("files $vol live=$live archived=$archived")
  else
    failures+=("files $vol live=$live archived=$archived")
  fi
done

# Zitadel may run another Postgres major version, so it restores into a container of its own image.
zitadel_state=absent
if [[ -n $zitadel ]]; then
  zitadel_verify=nix-backup-verify-zitadel-$label-$$
  start_verify "$zitadel_verify" "$zitadel_image" "$zitadel_user"
  grep -vx "CREATE ROLE $zitadel_user;" "$dir/zitadel-roles.sql" \
    | docker exec -i "$zitadel_verify" psql -q -X -v ON_ERROR_STOP=1 -U "$zitadel_user" -d postgres >/dev/null
  if [[ -z $(docker exec "$zitadel_verify" psql -X -At -U "$zitadel_user" -d postgres \
      -c "SELECT 1 FROM pg_database WHERE datname = '$zitadel_db'") ]]; then
    docker exec "$zitadel_verify" createdb -U "$zitadel_user" "$zitadel_db"
  fi
  docker exec -i "$zitadel_verify" pg_restore -U "$zitadel_user" -d "$zitadel_db" --exit-on-error \
    < "$dir/zitadel.dump"
  zitadel_restored_tables=$(docker exec "$zitadel_verify" psql -X -At -U "$zitadel_user" \
    -d "$zitadel_db" -c 'SELECT count(*) FROM pg_stat_user_tables')
  report+=("zitadel tables live=$zitadel_live_tables restored=$zitadel_restored_tables")
  if [[ $zitadel_live_tables != "$zitadel_restored_tables" || $zitadel_restored_tables == 0 ]]; then
    failures+=("zitadel tables live=$zitadel_live_tables restored=$zitadel_restored_tables")
  else
    zitadel_state=verified
  fi
fi

result=passed
(( ${#failures[@]} == 0 )) || result=failed
{
  echo "result=$result"
  echo "verified_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "kind=$kind"
  if [[ $kind == release ]]; then echo "release=$sha"; else echo "label=$label"; fi
  echo "zitadel=$zitadel_state"
  echo "sha256sums=$(sha256sum < "$dir/SHA256SUMS" | cut -d' ' -f1)"
  for line in "${report[@]}"; do echo "check $line"; done
  for line in "${warnings[@]+"${warnings[@]}"}"; do echo "warning $line"; done
  for line in "${failures[@]+"${failures[@]}"}"; do echo "failure $line"; done
} > "$dir/verified.txt"
chmod 600 "$dir/verified.txt"
for line in "${warnings[@]+"${warnings[@]}"}"; do echo "backup: warning: $line" >&2; done
if [[ $result != passed ]]; then
  for line in "${failures[@]}"; do echo "backup: failure: $line" >&2; done
  die "verification failed; $dir is kept for inspection"
fi
check_backup "$dir"
