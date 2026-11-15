#!/usr/bin/env bash
# Exercises import-zitadel.sh against a stubbed docker: the migrator command, the env names, the
# networks and the refusals. Needs no Docker.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
script=$root/deploy/compose/import-zitadel.sh
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"
: > "$work/env"
printf 'the-db-password' > "$work/db-password"

cat > "$work/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
case "$1" in
  ps) printf 'z-db db\nz-app zitadel\n' ;;
  inspect) printf 'zitadel_default 172.19.0.2\n' ;;
  compose) echo '{"networks":{"default":{"name":"nix"}},"services":{"nix-migrate":{"image":"ghcr.io/example/migrator:abc","environment":{"NIX_MIGRATOR_CONNECTION_STRING":"Host=postgres;Password=nix-secret"}}}}' ;;
  create) echo new-container ;;
esac
STUB
chmod +x "$work/bin/docker"
export PATH="$work/bin:$PATH" STUB_LOG="$work/log" NIX_DEPLOY_ENV="$work/env" \
  NIX_AUTH_PASSKEY_RP_ID=auth.example.org NIX_ZITADEL_DB_PASSWORD_FILE="$work/db-password" \
  NIX_ZITADEL_MASTERKEY=the-master-key

run() { : > "$work/log"; bash "$script" "$@" > "$work/out" 2>&1; }

run --dry-run
create=$(grep '^create ' "$work/log")
[[ $create == *'ghcr.io/example/migrator:abc account import-zitadel --dry-run' ]]
[[ $create == *'--network nix '* && $create == *'-v nix-api-data-protection:/var/lib/nix/data-protection'* ]]
for name in NIX_MIGRATOR_CONNECTION_STRING NIX_ZITADEL_DATABASE_URL NIX_ZITADEL_MASTERKEY; do
  [[ $create == *"-e $name "* || $create == *"-e $name" ]] || { echo "$name not passed by name" >&2; exit 1; }
done
[[ $create == *'-e Nix__Auth__Passkeys__RpId=auth.example.org'* && $create == *'-e Nix__Bff__DataProtectionKeysPath='* ]]
grep -qx 'network connect zitadel_default new-container' "$work/log"
grep -q '^start -a new-container' "$work/log"
grep -q '^rm -f new-container' "$work/log"
if grep -qE 'the-db-password|the-master-key|nix-secret' "$work/log"; then echo 'a secret reached the docker arguments' >&2; exit 1; fi
grep -q 'dry run' "$work/out"
if grep -q 'NIX_AUTH_MODE=local' "$work/out"; then echo 'dry run printed the switch steps' >&2; exit 1; fi

run
[[ $(grep '^create ' "$work/log") == *'account import-zitadel' ]]
grep -q 'NIX_AUTH_MODE=local' "$work/out"
grep -q 'NIX_AUTH_PASSKEY_RP_ID=auth.example.org' "$work/out"

refuse() { # label pattern -- command
  local label=$1 pattern=$2; shift 3
  if "$@" > "$work/out" 2>&1; then echo "accepted: $label" >&2; exit 1; fi
  grep -q -- "$pattern" "$work/out" || { echo "unclear refusal for $label:" >&2; cat "$work/out" >&2; exit 1; }
}
refuse 'missing RP id' 'NIX_AUTH_PASSKEY_RP_ID' -- env -u NIX_AUTH_PASSKEY_RP_ID bash "$script" --dry-run
refuse 'missing master key' 'NIX_ZITADEL_MASTERKEY' -- env -u NIX_ZITADEL_MASTERKEY bash "$script"
refuse 'unknown flag' 'usage' -- bash "$script" --force
refuse 'url as RP id' 'bare hostname' -- env NIX_AUTH_PASSKEY_RP_ID=https://auth.example.org bash "$script"
echo 'import-zitadel checks passed.'
