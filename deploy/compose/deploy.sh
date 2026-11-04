#!/usr/bin/env bash
# Run on the Compose host from the release checkout. Never deletes volumes or seeds users.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
: "${NIX_DEPLOY_ENV:?absolute path to the private production env file}"
: "${NIXCTL_PROFILE:?authenticated nixctl profile for release verification}"
: "${NIX_SMOKE_WORKSPACE:?dedicated workspace for disposable smoke-test items}"
: "${NIX_BACKUP_REFERENCE:?absolute path to the backup directory made by deploy/compose/backup.sh}"
case "$NIX_BACKUP_REFERENCE" in /*) ;; *) echo 'NIX_BACKUP_REFERENCE must be an absolute backup directory path' >&2; exit 2;; esac
bash "$root/deploy/compose/backup.sh" --check "$NIX_BACKUP_REFERENCE"
case "$NIX_DEPLOY_ENV" in /*) ;; *) echo 'NIX_DEPLOY_ENV must be absolute' >&2; exit 2;; esac
# The release every container reports in Settings > About; the commit is each service's image tag.
NIX_RELEASE_VERSION=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$root/package.json")
export NIX_RELEASE_VERSION
compose=(docker compose -p nix --env-file "$NIX_DEPLOY_ENV" -f "$root/deploy/compose.prod.yml")
# Validate without printing interpolated credentials.
"${compose[@]}" config --quiet
release_config=$("${compose[@]}" --profile maintenance config --format json | python3 -c '
import json, sys
s = json.load(sys.stdin)["services"]
if not s["nix-collab-migrate"]["environment"].get("NIX_COLLAB_MIGRATOR_CONNECTION_STRING"):
    sys.exit("Set the separate collaboration migrator connection before deployment.")
registry, sep, tag = s["nix-api"]["image"].rpartition("/api:")
if not sep:
    sys.exit("Cannot derive the release-tools image from the nix-api image.")
print(s["nix-api"]["environment"]["Nix__Bff__PublicOrigin"])
print(registry + "/release-tools:" + tag)
print(s["nix-api"]["environment"].get("Nix__Sites__Domain") or "")')
{ read -r NIX_SMOKE_ORIGIN; read -r release_tools_image; read -r sites_domain || true; } <<< "$release_config"
# Fresh installs only: NIX_BOOTSTRAP_IDENTITY=true runs nix-identity-bootstrap after the migrator,
# creating the tenant and its identity providers from the env file's NIX_BOOTSTRAP_* and NIX_OIDC_*
# values (deploy/seed/bootstrap_identity.sql). Checked here, before any writer stops.
bootstrap_identity=${NIX_BOOTSTRAP_IDENTITY:-false}
case "$bootstrap_identity" in
  true)
    "${compose[@]}" --profile bootstrap config --format json | python3 -c '
import json, sys
e = json.load(sys.stdin)["services"]["nix-identity-bootstrap"]["environment"]
missing = [k for k in ("NIX_BOOTSTRAP_TENANT_NAME", "NIX_BOOTSTRAP_OIDC_PROJECT_ID") if not (e.get(k) or "").strip()]
if missing:
    sys.exit("NIX_BOOTSTRAP_IDENTITY=true needs " + ", ".join(missing) + " in the env file.")' ;;
  false) ;;
  *) echo 'NIX_BOOTSTRAP_IDENTITY must be true or false' >&2; exit 2 ;;
esac
# Sites (ADR-0063) and remote MCP roll with the release when the env file enables them:
# COMPOSE_PROFILES=sites,mcp (visible only without --profile flags), or NIX_SITES_DOMAIN for
# sites. Otherwise they are left alone.
optional_services=()
active_services=$("${compose[@]}" config --services)
if [ -n "$sites_domain" ] || grep -qx nix-sites-worker <<< "$active_services"; then
  optional_services=(nix-sites-worker nix-sites-serve)
fi
if grep -qx nix-mcp <<< "$active_services"; then
  optional_services+=(nix-mcp)
fi
export NIX_SMOKE_ORIGIN
# Smoke checks run from the release-tools image at the release tag; the host needs no Node.
nixctl_config=${NIXCTL_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/nixctl/config.json}
[ -f "$nixctl_config" ] || { echo "nixctl profile file not found: $nixctl_config" >&2; exit 2; }
case "$release_tools_image" in
  localhost/*) docker image inspect "$release_tools_image" >/dev/null ;;
  *) docker pull --quiet "$release_tools_image" >/dev/null ;;
esac
smoke() {
  docker run --rm --user "$(id -u):$(id -g)" -v "$nixctl_config:/config/nixctl/config.json:ro" \
    -e NIXCTL_PROFILE -e NIX_SMOKE_WORKSPACE -e NIX_SMOKE_ORIGIN "$release_tools_image" smoke "$@"
}
smoke --preflight
# Fetch release images before writers stop, so the maintenance window excludes the download.
# Host-built images (NIX_IMAGE_REGISTRY=localhost/nix) must already exist locally.
release_services=(nix-migrate nix-api nix-collab-migrate nix-collab nix-companion nix-web ${optional_services[@]+"${optional_services[@]}"})
while IFS= read -r image; do
  case "$image" in
    localhost/*) docker image inspect "$image" >/dev/null ;;
    *) docker pull --quiet "$image" >/dev/null ;;
  esac
done < <("${compose[@]}" --profile maintenance config --images "${release_services[@]}" | sort -u)
# Check the release's bind mounts as RabbitMQ's runtime user before stopping writers.
# A private umask on the checkout can leave these public source files unreadable.
"${compose[@]}" run --rm --no-deps --entrypoint /bin/sh rabbitmq -c 'for file in /usr/local/bin/nix-rabbitmq-start /etc/rabbitmq/rabbitmq.conf /etc/rabbitmq/definitions.json; do if [ ! -r "$file" ]; then printf "Release bind mount is not readable: %s\n" "$file" >&2; exit 1; fi; done'
# Preview drift before anything is recreated; refuses recreating stateful infrastructure.
bash "$root/deploy/compose/drift.sh" "${compose[@]}"
# Stop retired services from an older manifest without removing their volumes.
for service in nix-speech-worker nix-indexer nix-opensearch grafana alloy loki docker-socket-proxy; do
  retired=$(docker ps -q --filter label=com.docker.compose.project=nix --filter "label=com.docker.compose.service=$service")
  if [ -n "$retired" ]; then
    while IFS= read -r container; do docker stop "$container"; done <<< "$retired"
  fi
done
# Stop writers before the infrastructure `up`, and keep them stopped while document/schema
# migrations run. RabbitMQ mounts its configuration from the release checkout, so every release
# recreates it; with publishers and consumers stopped, that restart cannot interrupt a delivery
# (queues are durable and messages persistent). Failure leaves writers stopped for inspection.
"${compose[@]}" stop nix-web ${optional_services[@]+"${optional_services[@]}"} nix-companion nix-collab nix-api
"${compose[@]}" up -d --wait --wait-timeout 180 postgres rabbitmq nix-versitygw
"${compose[@]}" --profile maintenance run --rm --no-deps nix-storage-init
# The BackupRuns migration grants to the nix_backup role, which migrations cannot create. Create
# it here, idempotently, with the attributes seed.sql gives it; never run deploy/seed/seed.sql on production (it resets role passwords).
"${compose[@]}" exec -T postgres psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -c "DO \$\$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nix_backup') THEN CREATE ROLE nix_backup NOLOGIN NOINHERIT; END IF; ALTER ROLE nix_backup NOLOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE; END\$\$"
"${compose[@]}" run --rm --no-deps nix-migrate
if [ "$bootstrap_identity" = true ]; then
  "${compose[@]}" --profile bootstrap run --rm --no-deps nix-identity-bootstrap
fi
"${compose[@]}" run --rm --no-deps nix-template-presets
"${compose[@]}" run --rm --no-deps nix-api-init
"${compose[@]}" --profile maintenance run --rm --no-deps nix-collab-migrate
"${compose[@]}" up -d --no-deps --wait --wait-timeout 180 nix-api nix-collab
"${compose[@]}" up -d --no-deps --wait --wait-timeout 180 nix-companion ${optional_services[@]+"${optional_services[@]}"} nix-web cloudflared
smoke
echo 'Compose release passed import/export verification. Complete browser checks in the runbook.'
