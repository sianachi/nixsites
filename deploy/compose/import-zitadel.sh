#!/usr/bin/env bash
# Copy accounts, password hashes, authenticator apps and passkeys from a Zitadel that runs as its
# own Compose project into Nix, ahead of switching Core to local sign-in.
#
#   import-zitadel.sh [--dry-run]
#
# Needs NIX_DEPLOY_ENV (absolute path to the private env file) and NIX_IMAGE_TAG (release.sh's
# usual export; the migrator image of that release runs the import), plus:
#   NIX_AUTH_PASSKEY_RP_ID          the identity provider's public hostname, e.g. auth.example.org
#   NIX_ZITADEL_DB_PASSWORD[_FILE]  password of the Zitadel database user
#   NIX_ZITADEL_MASTERKEY[_FILE]    Zitadel's master key
# The Zitadel Postgres container is found as backup.sh finds it; NIX_ZITADEL_DB_CONTAINER,
# NIX_ZITADEL_DB_NAME and NIX_ZITADEL_DB_USER override it. Run it after a release that has local
# sign-in, so Nix's schema is current. Zitadel is only read. This script edits no env file and
# restarts nothing.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
die() { echo "import-zitadel: $*" >&2; exit 1; }
usage() { echo 'usage: import-zitadel.sh [--dry-run]' >&2; exit 2; }

[[ $# -le 1 && ${1:---dry-run} == --dry-run ]] || usage
dry_run=${1:-}
: "${NIX_DEPLOY_ENV:?absolute path to the private production env file}"
[[ $NIX_DEPLOY_ENV == /* && -f $NIX_DEPLOY_ENV ]] || die 'NIX_DEPLOY_ENV must be an absolute path to a file'
rp_id=${NIX_AUTH_PASSKEY_RP_ID:-}
[[ -n $rp_id ]] || die "set NIX_AUTH_PASSKEY_RP_ID to the identity provider's public hostname (passkeys were registered for it)"
[[ $rp_id =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || die 'NIX_AUTH_PASSKEY_RP_ID must be a bare hostname'
zitadel_db=${NIX_ZITADEL_DB_NAME:-zitadel}
zitadel_user=${NIX_ZITADEL_DB_USER:-postgres}
[[ $zitadel_db =~ ^[a-z_][a-z0-9_]*$ && $zitadel_user =~ ^[a-z_][a-z0-9_]*$ ]] \
  || die 'NIX_ZITADEL_DB_NAME and NIX_ZITADEL_DB_USER must be plain lowercase identifiers'
command -v docker >/dev/null || die 'docker is required'
command -v python3 >/dev/null || die 'python3 is required'

secret() { # NAME: the value of $NAME, or the contents of the file named by ${NAME}_FILE
  local name=$1 file=${1}_FILE
  if [[ -n ${!file:-} ]]; then
    [[ -f ${!file} ]] || die "$file is not a file: ${!file}"
    printf '%s' "$(<"${!file}")"
  elif [[ -n ${!name:-} ]]; then
    printf '%s' "${!name}"
  else
    die "set $name or $file"
  fi
}
zitadel_password=$(secret NIX_ZITADEL_DB_PASSWORD)
masterkey=$(secret NIX_ZITADEL_MASTERKEY)

# shellcheck source=deploy/compose/zitadel-db.sh
source "$root/deploy/compose/zitadel-db.sh"
zitadel=$(find_zitadel_db)
[[ -n $zitadel ]] || die 'no running zitadel database container; start Zitadel or set NIX_ZITADEL_DB_CONTAINER'
# One "<network> <address>" pair for the Zitadel container; the run joins that network.
read -r zitadel_net zitadel_host < <(docker inspect --format \
  '{{range $name, $n := .NetworkSettings.Networks}}{{$name}} {{$n.IPAddress}}{{"\n"}}{{end}}' "$zitadel" | head -n1)
[[ -n ${zitadel_net:-} && -n ${zitadel_host:-} ]] || die "could not read the network of $zitadel"

compose=(docker compose -p nix --env-file "$NIX_DEPLOY_ENV" -f "$root/deploy/compose.prod.yml")
{ read -r image; read -r nix_net; read -r nix_connection; } < <("${compose[@]}" config --format json | python3 -c '
import json, sys
c = json.load(sys.stdin)
m = c["services"]["nix-migrate"]
print(m["image"])
print(c["networks"]["default"]["name"])
print(m["environment"]["NIX_MIGRATOR_CONNECTION_STRING"])')
[[ -n $image && -n $nix_connection ]] || die 'could not read the migrator settings from the compose file and env file'

# Secrets reach the container by name only, so they never show in a process list. Zitadel is reached
# by address, so a service name that both projects use cannot point at the wrong database.
cid=$(
  NIX_MIGRATOR_CONNECTION_STRING=$nix_connection \
  NIX_ZITADEL_DATABASE_URL="Host=$zitadel_host;Port=5432;Database=$zitadel_db;Username=$zitadel_user;Password=\"${zitadel_password//\"/\"\"}\"" \
  NIX_ZITADEL_MASTERKEY=$masterkey \
  docker create --network "$nix_net" --read-only --tmpfs /tmp:size=32m,mode=1777 --cap-drop ALL \
    --security-opt no-new-privileges:true \
    -v nix-api-data-protection:/var/lib/nix/data-protection \
    -e Nix__Bff__DataProtectionKeysPath=/var/lib/nix/data-protection \
    -e "Nix__Auth__Passkeys__RpId=$rp_id" \
    -e NIX_MIGRATOR_CONNECTION_STRING -e NIX_ZITADEL_DATABASE_URL -e NIX_ZITADEL_MASTERKEY \
    "$image" account import-zitadel ${dry_run:+"$dry_run"}
)
trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT
docker network connect "$zitadel_net" "$cid"
docker start -a "$cid"

if [[ -n $dry_run ]]; then
  echo 'import-zitadel: dry run, nothing was written.'
  exit 0
fi
cat <<NEXT

Accounts are in Nix. To switch, set these in $NIX_DEPLOY_ENV:
  NIX_AUTH_MODE=local
  NIX_AUTH_PASSKEY_RP_ID=$rp_id
  NIX_OIDC_ISSUER=
  NIX_OIDC_CLIENT_ID=
  NIX_COLLAB_OIDC_ISSUERS=<NIX_CORE_TOKEN_ISSUER>|http://nix-api:8080/public/v1/auth/jwks
  NIX_COLLAB_OIDC_AUDIENCE=<NIX_CORE_TOKEN_AUDIENCE>
then run the usual release. Point https://$rp_id/.well-known/webauthn at Nix (see docs/install.md).
To go back, restore the previous env file and release again; Zitadel's data is untouched.
NEXT
