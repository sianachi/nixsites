#!/usr/bin/env bash
# Prerequisite checks in deploy/install.sh. Stubs stand in for Docker and the other tools,
# so this does not start a stack or talk to the network.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
bash_bin=$(command -v bash)
bash -n deploy/install.sh

fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
empty=$fixture/empty
bin=$fixture/bin
src=$fixture/src
state=$fixture/state
called=$fixture/called
mkdir -p "$empty" "$bin" "$src"

stub() {
  printf '%s\n' "$2" > "$bin/$1"
  chmod +x "$bin/$1"
}

# Present on PATH, but any real invocation is a failure we can see.
stub curl '#!/bin/sh
printf curl >> "'"$called"'"
exit 1'
stub openssl '#!/bin/sh
exit 0'
stub jq '#!/bin/sh
exit 0'

assert_ok() {
  if [ "$code" -ne 0 ]; then
    printf 'expected success, got %s\n%s\n' "$code" "$out" >&2
    exit 1
  fi
}
assert_fail() {
  if [ "$code" -eq 0 ]; then
    printf 'expected failure\n%s\n' "$out" >&2
    exit 1
  fi
}
assert_has() {
  if ! printf '%s\n' "$out" | grep -F -q -- "$1"; then
    printf 'expected to find: %s\n%s\n' "$1" "$out" >&2
    exit 1
  fi
}
assert_lacks() {
  if printf '%s\n' "$out" | grep -F -q -- "$1"; then
    printf 'did not expect: %s\n%s\n' "$1" "$out" >&2
    exit 1
  fi
}

run() {
  set +e
  out=$(env -u NIX_SOURCE_DIR PATH="$1" "$bash_bin" deploy/install.sh "${@:2}" 2>&1)
  code=$?
  set -e
}

# Flags still win, and help does not need the tools.
run "$empty" --help
assert_ok
assert_has 'usage: install.sh'

run "$empty" --not-a-flag
assert_fail
assert_has 'unknown option --not-a-flag'
assert_lacks 'missing'

run "$empty" --version
assert_fail
assert_lacks 'missing'

# Every missing tool is named, and nothing is created yet.
rm -rf "$state"
run "$empty" --dir "$state"
assert_fail
assert_has 'missing curl, openssl, jq, docker'
assert_lacks 'downloading release'
[ ! -e "$state" ]

# Compose is its own missing piece once the docker binary is there.
stub docker '#!/bin/sh
exit 1'
run "$bin" --dir "$state"
assert_fail
assert_has 'missing Docker Compose plugin (docker compose)'
assert_lacks 'cannot reach the Docker daemon'
[ ! -e "$state" ]

# Daemon down fails before the state directory or a download.
stub docker '#!/bin/sh
if [ "$1" = compose ] && [ "$2" = version ]; then exit 0; fi
exit 1'
: > "$called"
run "$bin" --dir "$state" --version v0.0.0
assert_fail
assert_has 'cannot reach the Docker daemon'
assert_lacks 'GiB available'
[ ! -s "$called" ]
[ ! -e "$state" ]

# Under about 0.75 GiB, warn and carry on. The empty source dir is what stops the run.
docker_mem() {
  stub docker "#!/bin/sh
if [ \"\$1\" = compose ] && [ \"\$2\" = version ]; then exit 0; fi
if [ \"\$1\" = info ]; then printf '%s\\n' '$1'; exit 0; fi
exit 1"
}
run_mem() {
  : > "$called"
  rm -rf "$state"
  set +e
  out=$(env PATH="$bin:/usr/bin:/bin" NIX_SOURCE_DIR="$src" "$bash_bin" deploy/install.sh --dir "$state" --version v0.0.0 2>&1)
  code=$?
  set -e
}
docker_mem 536870912
run_mem
assert_fail
assert_has 'Docker has 0.5 GiB available. Give it at least 1 GB, or the stack can run out of memory.'
assert_has 'NIX_SOURCE_DIR has no deploy/compose.prod.yml'
assert_lacks 'missing'
[ ! -s "$called" ]
[ -d "$state" ]

# 0.75 GiB is the floor (a 1 GB Docker Desktop VM reports a little less). One byte under warns.
docker_mem 805306367
run_mem
assert_fail
assert_has 'GiB available'

docker_mem 805306368
run_mem
assert_fail
assert_lacks 'GiB available'
assert_has 'NIX_SOURCE_DIR has no deploy/compose.prod.yml'

docker_mem 17179869184
run_mem
assert_fail
assert_lacks 'warning:'

docker_mem 'not-a-number'
run_mem
assert_fail
assert_has 'could not read how much memory Docker has'
assert_has 'NIX_SOURCE_DIR has no deploy/compose.prod.yml'

# Kubernetes keeps its own tools and does not ask for Docker or its memory.
rm -f "$bin/docker"
run "$bin" --kubernetes --version v0.0.0 --dir "$state" https://nix.example.org
assert_fail
assert_has 'missing kubectl, envsubst (gettext)'
assert_lacks 'docker'
assert_lacks 'GiB'

stub kubectl '#!/bin/sh
exit 0'
stub envsubst '#!/bin/sh
exit 0'
: > "$called"
rm -rf "$state"
set +e
out=$(env PATH="$bin:/usr/bin:/bin" NIX_SOURCE_DIR="$src" "$bash_bin" deploy/install.sh \
  --kubernetes --ingress-class demo --storage-class demo --pod-cidr 10.0.0.0/16 \
  --version v0.0.0 --dir "$state" https://nix.example.org 2>&1)
code=$?
set -e
assert_fail
assert_has 'NIX_SOURCE_DIR has no deploy/compose.prod.yml'
assert_lacks 'missing'
assert_lacks 'unknown option'
assert_lacks 'GiB'
[ ! -s "$called" ]

# ── Sign-in modes ──────────────────────────────────────────────────────────────
# A recording Docker stands in for the daemon; real openssl and jq generate the keys.
dlog=$fixture/docker.log
real=$fixture/real
mkdir -p "$real"
cat > "$real/docker" <<STUB
#!/bin/sh
printf '%s\n' "\$*" >> "$dlog"
case "\$*" in
  "info --format"*) echo 17179869184 ;;
  *"SELECT 1 FROM pg_database"*) echo 1 ;;
  "ps -a"*"service=zitadel-db"*) echo nix-zitadel-db-1 ;;
  "ps -a"*"service=zitadel-init"*) echo nix-zitadel-init-1 ;;
  "ps -a"*"service=zitadel"*) echo nix-zitadel-1 ;;
esac
exit 0
STUB
chmod +x "$real/docker"
stub curl '#!/bin/sh
exit 1'
rm -f "$bin/openssl" "$bin/jq" "$bin/kubectl" "$bin/envsubst"
run_install() {
  : > "$dlog"
  set +e
  out=$(env PATH="$real:$bin:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin" NIX_SOURCE_DIR="$root" "$bash_bin" deploy/install.sh \
    --dir "$sdir" --version v0.0.0 "$@" 2>&1)
  code=$?
  set -e
}
assert_log_has() { grep -F -q -- "$1" "$dlog" || { printf 'expected in docker calls: %s\n%s\n' "$1" "$(cat "$dlog")" >&2; exit 1; }; }
assert_log_lacks() { ! grep -F -q -- "$1" "$dlog" || { printf 'unexpected in docker calls: %s\n' "$1" >&2; exit 1; }; }
env_val() { sed -n "s|^$1=||p" "$sdir/nix.env"; }

# A new install signs in locally: no Zitadel, no OIDC settings, one hostname, a setup code.
sdir=$fixture/new
run_install http://nix.localhost
assert_ok
[ "$(env_val NIX_AUTH_MODE)" = local ]
grep -q '^NIX_OIDC_ISSUER=$' "$sdir/nix.env"
grep -q '^NIX_OIDC_CLIENT_ID=$' "$sdir/nix.env"
case "$(env_val NIX_AUTH_SETUP_CODE)" in [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;; *) echo 'no setup code' >&2; exit 1 ;; esac
[ "$(env_val NIX_COLLAB_OIDC_AUDIENCE)" = nix ]
[ "$(env_val NIX_COLLAB_OIDC_ISSUERS)" = 'http://nix.localhost|http://nix-api:8080/public/v1/auth/jwks' ]
! grep -q -i -E 'ZITADEL|OIDC_ISSUER|OIDC_CLIENT|AUTH_HOST|ADMIN_PASSWORD' "$sdir/nix.env"
assert_log_lacks compose.zitadel.yml
assert_log_lacks 'up -d zitadel'
assert_log_lacks nix-identity-bootstrap
assert_has 'http://nix.localhost/setup'
assert_has "$(env_val NIX_AUTH_SETUP_CODE)"
grep -q '^NIX_OIDC_ISSUER=$' "$sdir/nix.env"
grep -q '^NIX_OIDC_CLIENT_ID=$' "$sdir/nix.env"
assert_lacks 'auth.nix.localhost'

# Running it again upgrades and does not print the code a second time.
run_install http://nix.localhost
assert_ok
assert_lacks "$(env_val NIX_AUTH_SETUP_CODE)"
assert_has 'NIX_AUTH_SETUP_CODE'

# An install that still uses the bundled Zitadel is refused before anything changes.
sdir=$fixture/old
mkdir -p "$sdir"
cat > "$sdir/nix.env" <<ENV
NIX_PUBLIC_ORIGIN=https://nix.example.org
NIX_PUBLIC_HOST=nix.example.org
NIX_AUTH_HOST=auth.nix.example.org
NIX_OIDC_ISSUER=https://auth.nix.example.org
NIX_OIDC_CLIENT_ID=abc
NIX_ADMIN_PASSWORD=pw
NIX_ZITADEL_MASTERKEY=masterkey-value
NIX_ZITADEL_DB_PASSWORD=zdb-secret
NIX_PG_APP_PASSWORD=a
NIX_PG_MIGRATOR_PASSWORD=b
NIX_PG_COLLAB_PASSWORD=c
ENV
cp "$sdir/nix.env" "$fixture/old.env"
run_install https://nix.example.org
assert_fail
assert_has 'no longer includes Zitadel'
assert_has '--migrate-local-auth --dry-run'
! grep -Ev '^(info |compose version)' "$dlog"
cmp -s "$sdir/nix.env" "$fixture/old.env"

# Migration needs the flag, only for the Docker install, and a dry run changes nothing.
run_install --dry-run https://nix.example.org
assert_fail
assert_has '--dry-run only goes with --migrate-local-auth'

run_install --migrate-local-auth --dry-run https://nix.example.org
assert_ok
assert_log_has 'nix-migrate account import-zitadel --dry-run'
assert_log_has '-e Nix__Auth__Passkeys__RpId=auth.nix.example.org'
assert_log_has '-e NIX_ZITADEL_DATABASE_URL -e NIX_ZITADEL_MASTERKEY'
assert_log_lacks NIX_ZITADEL_CONNECTION_STRING
assert_log_lacks zdb-secret
assert_log_lacks masterkey-value
# The existing database container is started (and put back, since it was not running); nothing Zitadel is created or pulled.
assert_log_has 'start nix-zitadel-db-1'
assert_log_has 'stop nix-zitadel-db-1'
assert_log_lacks 'stop nix-zitadel-1'
assert_log_lacks 'up -d zitadel'
assert_log_lacks 'pull'
assert_log_lacks 'ghcr.io/zitadel'
! grep -Eq '^(rm|container rm|volume) ' "$dlog"
assert_log_lacks compose.zitadel.yml
cmp -s "$sdir/nix.env" "$fixture/old.env"
[ ! -e "$sdir/nix.env.pre-local-auth" ]

# The real run switches to local mode, keeps the old hostname for passkeys, stops the leftovers and keeps them and their data.
run_install --migrate-local-auth https://nix.example.org
assert_ok
assert_log_has 'nix-migrate account import-zitadel'
assert_log_has '-e Nix__Auth__Passkeys__RpId=auth.nix.example.org'
assert_log_has '-e NIX_ZITADEL_DATABASE_URL -e NIX_ZITADEL_MASTERKEY'
assert_log_lacks NIX_ZITADEL_CONNECTION_STRING
assert_log_lacks zdb-secret
assert_log_lacks masterkey-value
assert_log_has 'start nix-zitadel-db-1'
assert_log_has 'stop nix-zitadel-1 nix-zitadel-init-1 nix-zitadel-db-1'
assert_log_lacks 'up -d zitadel'
assert_log_lacks 'pull'
assert_log_lacks 'ghcr.io/zitadel'
! grep -Eq '^(rm|container rm|volume) ' "$dlog"
assert_log_lacks compose.zitadel.yml
cmp -s "$sdir/nix.env.pre-local-auth" "$fixture/old.env"
[ "$(env_val NIX_AUTH_MODE)" = local ]
[ "$(env_val NIX_AUTH_PASSKEY_RP_ID)" = auth.nix.example.org ]
[ "$(env_val NIX_WEBAUTHN_CADDY)" = "$sdir/webauthn.caddy" ]
grep -F -q 'https://auth.nix.example.org {' "$sdir/webauthn.caddy"
grep -F -q '{"origins":["https://nix.example.org"]}' "$sdir/webauthn.caddy"
! grep -F -q 'down' "$dlog"
assert_has 'Left behind, stopped and not removed: nix-zitadel-1 nix-zitadel-init-1 nix-zitadel-db-1'
assert_has 'docker rm nix-zitadel-1 nix-zitadel-init-1 nix-zitadel-db-1'
assert_has 'docker volume rm nix-zitadel-data nix-zitadel-machinekey'
assert_has 'cannot run Zitadel'
assert_has "$sdir/nix.env.pre-local-auth"

# Afterwards it is an ordinary local install; migrating again is refused.
run_install https://nix.example.org
assert_ok
assert_log_lacks compose.zitadel.yml
run_install --migrate-local-auth https://nix.example.org
assert_fail
assert_has 'already signs people in with Nix itself'

# An outside provider the operator runs (an issuer, no master key) keeps working, and has nothing to migrate.
sdir=$fixture/own
mkdir -p "$sdir"
cat > "$sdir/nix.env" <<ENV
NIX_PUBLIC_ORIGIN=https://nix.example.org
NIX_PUBLIC_HOST=nix.example.org
NIX_AUTH_MODE=oidc
NIX_OIDC_ISSUER=https://sso.example.org
NIX_OIDC_CLIENT_ID=abc
NIX_PG_APP_PASSWORD=a
NIX_PG_MIGRATOR_PASSWORD=b
NIX_PG_COLLAB_PASSWORD=c
ENV
run_install https://nix.example.org
assert_ok
assert_has 'Sign in with your identity provider'
assert_log_lacks 'zitadel'
assert_log_lacks nix-identity-bootstrap
run_install --migrate-local-auth https://nix.example.org
assert_fail
assert_has 'identity provider you run'

# The compose files parse in both shapes, with the env files install.sh writes.
if docker compose version >/dev/null 2>&1; then
  for shape in local oidc; do
    envf=$fixture/shape.env
    if [ "$shape" = local ]; then cp "$fixture/new/nix.env" "$envf"; else cp "$fixture/old.env" "$envf"; fi
    files=(-f deploy/compose.prod.yml -f deploy/compose.quickstart.yml)
    NIX_IMAGE_TAG=x NIX_WEB_IMAGE_TAG=x NIX_CORE_TOKEN_ISSUER=https://nix.example.org NIX_CORE_TOKEN_AUDIENCE=nix NIX_CORE_TOKEN_KEY_ID=k \
      NIX_CORE_TOKEN_SIGNING_KEY_FILE=/dev/null NIX_OBJECT_STORE_ENDPOINT=http://a NIX_OBJECT_STORE_PUBLIC_ORIGIN=http://a \
      NIX_OBJECT_STORE_BUCKET=a NIX_OBJECT_STORE_ACCESS_KEY=a NIX_OBJECT_STORE_SECRET_KEY=a NIX_PUBLIC_FORMS_SIGNING_KEY=a \
      NIX_INTERNAL_SECRET=a NIX_PG_SUPERUSER_PASSWORD=a NIX_PG_APP_PASSWORD=a NIX_PG_MIGRATOR_PASSWORD=a NIX_MIGRATOR_CONNECTION_STRING=a \
      NIX_CORE_DATABASE_URL=a NIX_COLLAB_DATABASE_URL=a NIX_COLLAB_MIGRATOR_CONNECTION_STRING=a CLOUDFLARE_TUNNEL_TOKEN=u \
      docker compose -p t --env-file "$envf" "${files[@]}" --profile bootstrap config --quiet
  done
  # Remote MCP and its OAuth discovery are on with no profile: the service runs, Core and the
  # service get <origin>/mcp, and Caddy proxies /mcp to it.
  NIX_IMAGE_TAG=x NIX_WEB_IMAGE_TAG=x docker compose -p t --env-file "$fixture/new/nix.env" "${files[@]}" config --format json > "$fixture/rendered.json"
  jq -e '.services["nix-mcp"].command == ["nixctl","mcp","--listen","0.0.0.0:8500"]
    and .services["nix-mcp"].environment.NIX_MCP_PUBLIC_URL == "http://nix.localhost/mcp"
    and .services["nix-api"].environment.Nix__Mcp__PublicUrl == "http://nix.localhost/mcp"
    and .services["nix-api"].environment.Nix__Bff__PublicOrigin == "http://nix.localhost"
    and .services["nix-web"].environment.NIX_MCP_UPSTREAM == "nix-mcp:8500"' "$fixture/rendered.json" >/dev/null
fi
# The quickstart edge serves the production app routes, which carry /mcp and both OAuth documents.
grep -Fq 'import /etc/caddy/Caddyfile.prod' deploy/Caddyfile.quickstart
grep -Fq 'handle /mcp {' deploy/Caddyfile.prod
grep -Fq 'reverse_proxy {$NIX_MCP_UPSTREAM}' deploy/Caddyfile.prod
grep -Fq '@oauth_discovery path /.well-known/oauth-protected-resource* /.well-known/oauth-authorization-server' deploy/Caddyfile.prod


echo 'install checks passed.'
