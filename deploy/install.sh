#!/usr/bin/env bash
# One line installs or upgrades Nix. With no argument it is a try-out on this machine at
# http://nix.localhost. It needs Docker with the Compose plugin, curl, openssl, jq, and at least
# 1 GB of memory for Docker (Chrome and Firefox resolve .localhost names themselves; Safari
# needs them in /etc/hosts):
#
#   curl -fsSL https://raw.githubusercontent.com/sianachi/nixsites/main/deploy/install.sh | bash
#
# For a real install the argument is the public origin, with DNS for it pointing at the machine
# (or the cluster's ingress):
#
#   curl -fsSL https://raw.githubusercontent.com/sianachi/nixsites/main/deploy/install.sh \
#     | bash -s -- https://nix.example.org
#
# Docker (default): Caddy is the public listener on ports 80 and 443 and fetches the certificates;
# everything lands under --dir (default ~/nix), where nix.env holds every generated secret and is
# the only file to back up with the Docker volumes. Nix signs people in itself: the first visit
# asks for the setup code printed at the end, and the person who uses it becomes the administrator.
# An install made with the bundled Zitadel must run --migrate-local-auth to upgrade: this version no
# longer includes, starts or upgrades Zitadel.
#
# --kubernetes: installs into the current kubectl context with deploy/k8s, under namespace nix.
# The ingress controller must listen on the origin's port. Certificates: --tls-cert/--tls-key
# (a PEM pair covering <host> and *.<host>), or --cluster-issuer <name> for cert-manager (no
# wildcard then: sites need DNS-01), or a self-signed pair for a try-out.
#
# Re-running upgrades: state is kept, migrations run, services restart on the new images.
#   --version <tag|sha>      release to install (default: the latest GitHub release)
#   --dir <path>             state directory (default ~/nix)
#   --kubernetes             target the current kubectl context instead of Docker
#   --ingress-class <name>   kubernetes: IngressClass (default: the first one)
#   --ingress-service <ns/name>  kubernetes: the ingress controller's Service, only needed for a
#                            .localhost try-out (cluster DNS gets the names pointed at it)
#   --storage-class <name>   kubernetes: StorageClass (default: the cluster default)
#   --pod-cidr <cidr>        kubernetes: pod network (default: the first node's podCIDR)
#   --tls-cert/--tls-key <file>, --cluster-issuer <name>  kubernetes certificates, see above
#   --migrate-local-auth     Docker: move an install off the bundled Zitadel onto Nix's own sign-in,
#                            carrying accounts, passwords, authenticator apps and passkeys over; the
#                            old Zitadel containers and volumes are stopped and kept, not removed
#   --dry-run                with --migrate-local-auth: report what would move and change nothing
# NIX_SOURCE_DIR=<checkout> uses that checkout's deploy/ instead of downloading the release.
set -euo pipefail

repo=${NIX_REPO:-sianachi/nixsites}
registry=${NIX_IMAGE_REGISTRY:-ghcr.io/sianachi/nix}
version=
dir=$HOME/nix
target=compose
origin=
ingress_class= ingress_service= storage_class= pod_cidr= tls_cert= tls_key= cluster_issuer=
migrate_auth=false dry_run=false
usage='usage: install.sh [--version <tag|sha>] [--dir <path>] [--kubernetes ...] [--migrate-local-auth [--dry-run]] [origin]'
die() { printf 'install: %s\n' "$*" >&2; exit 2; }
say() { printf '\ninstall: %s\n' "$*"; }
warn() { printf 'install: warning: %s\n' "$*" >&2; }

# Names every missing tool in one message. Docker and Compose are the default target;
# --kubernetes uses kubectl and envsubst instead, and does not require Docker.
require_tools() {
  local missing=() tool list mem min_bytes mb whole frac
  for tool in curl openssl jq; do
    command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
  done
  case "$target" in
    compose)
      if ! command -v docker >/dev/null 2>&1; then
        missing+=("docker")
      elif ! docker compose version >/dev/null 2>&1; then
        missing+=("Docker Compose plugin (docker compose)")
      fi
      ;;
    kubernetes)
      command -v kubectl >/dev/null 2>&1 || missing+=("kubectl")
      command -v envsubst >/dev/null 2>&1 || missing+=("envsubst (gettext)")
      ;;
  esac
  if [ "${#missing[@]}" -gt 0 ]; then
    list=$(printf '%s, ' "${missing[@]}")
    list=${list%, }
    die "missing $list"
  fi
  [ "$target" = compose ] || return 0
  if ! mem=$(docker info --format '{{.MemTotal}}' 2>/dev/null); then
    die "cannot reach the Docker daemon. Start Docker and run this again."
  fi
  mem=${mem//[[:space:]]/}
  # Bytes. Warn below 0.75 GiB: a 1 GB Docker Desktop VM reports a little under 1 GiB.
  # The stack was measured at about 0.6 GB with one person using it.
  min_bytes=$((3 * 256 * 1024 * 1024))
  case "$mem" in
    ''|*[!0-9]*)
      warn "could not read how much memory Docker has. Nix wants at least 1 GB."
      return 0
      ;;
  esac
  if [ "$mem" -lt "$min_bytes" ]; then
    mb=$(( mem / 1024 / 1024 ))
    whole=$(( mb / 1024 ))
    frac=$(( (mb % 1024) * 10 / 1024 ))
    warn "Docker has ${whole}.${frac} GiB available. Give it at least 1 GB, or the stack can run out of memory."
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) version=${2:?}; shift 2 ;;
    --dir) dir=${2:?}; shift 2 ;;
    --kubernetes) target=kubernetes; shift ;;
    --ingress-class) ingress_class=${2:?}; shift 2 ;;
    --ingress-service) ingress_service=${2:?}; shift 2 ;;
    --storage-class) storage_class=${2:?}; shift 2 ;;
    --pod-cidr) pod_cidr=${2:?}; shift 2 ;;
    --tls-cert) tls_cert=${2:?}; shift 2 ;;
    --tls-key) tls_key=${2:?}; shift 2 ;;
    --cluster-issuer) cluster_issuer=${2:?}; shift 2 ;;
    --migrate-local-auth) migrate_auth=true; shift ;;
    --dry-run) dry_run=true; shift ;;
    -h|--help) echo "$usage"; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) [ -z "$origin" ] || die "$usage"; origin=$1; shift ;;
  esac
done
[ "$dry_run" = false ] || [ "$migrate_auth" = true ] || die '--dry-run only goes with --migrate-local-auth'
[ "$migrate_auth" = false ] || [ "$target" = compose ] || die '--migrate-local-auth is for the Docker install'
require_tools
origin=${origin:-http://nix.localhost}

# ── Origin ─────────────────────────────────────────────────────────────────────
[[ "$origin" =~ ^(https?)://([a-z0-9.-]+)(:([0-9]+))?/?$ ]] || die "origin must be http(s)://host[:port], got $origin"
scheme=${BASH_REMATCH[1]} host=${BASH_REMATCH[2]} port=${BASH_REMATCH[4]:-}
origin="$scheme://$host${port:+:$port}"
if [ "$scheme" = http ] && [[ "$host" != *.localhost && "$host" != localhost ]]; then
  die "a plain-http origin is only allowed for a .localhost try-out; use https:// for $host"
fi
[ "$host" != localhost ] || die "use http://nix.localhost: inside a container, localhost is the container itself"
# Only an install migrated off the bundled Zitadel has an auth hostname: the passkey hostname.
auth_host="auth.$host"
issuer="$scheme://$auth_host${port:+:$port}"
if [ "$scheme" = https ]; then
  http_port=80 https_port=${port:-443}
else
  http_port=${port:-80} https_port=443
fi
# Web Push wants a mailto: or https: contact; an http try-out origin is neither.
vapid_subject="mailto:admin@$host"

# ── Release source ─────────────────────────────────────────────────────────────
if [ -z "$version" ]; then
  version=$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" | jq -r '.tag_name // empty')
  [ -n "$version" ] || die "no release found for $repo; pass --version"
fi
umask 077
mkdir -p "$dir"
if [ -n "${NIX_SOURCE_DIR:-}" ]; then
  src=$NIX_SOURCE_DIR/deploy
  [ -f "$src/compose.prod.yml" ] || die "NIX_SOURCE_DIR has no deploy/compose.prod.yml"
else
  src=$dir/src/$version/deploy
  if [ ! -f "$src/compose.prod.yml" ]; then
    say "downloading release $version"
    tmp=$(mktemp -d)
    curl -fsSL "https://github.com/$repo/archive/$version.tar.gz" | tar -xz -C "$tmp"
    mkdir -p "$dir/src/$version"
    mv "$tmp"/*/deploy "$src"
    rm -rf "$tmp"
  fi
fi

# ── State file helpers ─────────────────────────────────────────────────────────
# Never source the file: connection strings carry ';', which a shell reads as a separator.
env_get() { sed -n "s|^$1=||p" "$env_file"; }
set_env() {
  if grep -q "^$1=" "$env_file"; then
    sed -i.bak "s|^$1=.*|$1=$2|" "$env_file" && rm -f "$env_file.bak"
  else
    printf '%s=%s\n' "$1" "$2" >> "$env_file"
  fi
}
secret() { openssl rand -hex "$1"; }

# $1: the setup code (new local install), "-" (existing local install), or "oidc" (the operator's
# own identity provider).
finish() {
  printf '\nNix is running at %s\n\n' "$origin"
  case "$1" in
    oidc)
      echo "  Sign in with your identity provider." ;;
    -)
      echo "  Sign in with your email and password. The setup code is NIX_AUTH_SETUP_CODE in $env_file."
      echo "  Add people from People in the settings; they get a one-time link to set a password." ;;
    *)
      printf '  Open %s/setup and enter this setup code to create the first account\n  (it becomes the administrator):\n\n    %s\n\n' "$origin" "$1"
      echo "  Add people from People in the settings; they get a one-time link to set a password." ;;
  esac
  printf '\nState: %s\nUpgrade: run this installer again with --version <newer release>\n' "$dir"
  [ "$scheme" = https ] || echo "Try-out: Chrome and Firefox resolve $host on their own; Safari needs it in /etc/hosts as 127.0.0.1."
}

# ══ Kubernetes ═════════════════════════════════════════════════════════════════
if [ "$target" = kubernetes ]; then
  env_file=$dir/kubernetes.env
  # A new install signs people in itself. A state file from before that has no NIX_AUTH_MODE and
  # was made with the bundled Zitadel, which this version no longer deploys or manages.
  new_install=false
  if [ ! -f "$env_file" ]; then
    new_install=true
    printf 'NIX_PUBLIC_ORIGIN=%s\nNIX_AUTH_MODE=local\nNIX_AUTH_SETUP_CODE=%s\n' "$origin" "$(secret 8)" > "$env_file"
  fi
  [ "$(env_get NIX_PUBLIC_ORIGIN)" = "$origin" ] || die "$env_file was written for $(env_get NIX_PUBLIC_ORIGIN); pass that origin or use another --dir"
  auth_mode=$(env_get NIX_AUTH_MODE)
  [ -n "$auth_mode" ] || die "this install was made with the bundled Zitadel, which this version no longer includes. Move it onto Nix's own sign-in with deploy/k8s/deploy.sh first (docs/install.md, \"Moving a cluster install off Zitadel\"), then add NIX_AUTH_MODE=local to $env_file"
  oidc_issuer=$(env_get NIX_OIDC_ISSUER) oidc_client_id=$(env_get NIX_OIDC_CLIENT_ID)
  [ "$auth_mode" = local ] || { [ -n "$oidc_issuer" ] && [ -n "$oidc_client_id" ]; } || die "NIX_AUTH_MODE=oidc needs NIX_OIDC_ISSUER and NIX_OIDC_CLIENT_ID in $env_file"
  kubectl cluster-info >/dev/null 2>&1 || die 'kubectl has no working context'
  ingress_class=${ingress_class:-$(kubectl get ingressclass -o jsonpath='{.items[0].metadata.name}')}
  storage_class=${storage_class:-$(kubectl get storageclass -o jsonpath='{.items[?(@.metadata.annotations.storageclass\.kubernetes\.io/is-default-class=="true")].metadata.name}')}
  pod_cidr=${pod_cidr:-$(kubectl get nodes -o jsonpath='{.items[0].spec.podCIDR}')}
  [ -n "$ingress_class" ] || die 'no IngressClass found; pass --ingress-class'
  [ -n "$storage_class" ] || die 'no default StorageClass; pass --storage-class'
  [ -n "$pod_cidr" ] || die 'cannot read the pod CIDR; pass --pod-cidr'
  tls_hosts="[\"$host\", \"*.$host\"]"
  if [ -n "$cluster_issuer" ]; then
    tls_hosts="[\"$host\"]"
  fi

  if ! kubectl -n nix get secret nix-db >/dev/null 2>&1; then
    if [ -z "$tls_cert" ]; then
      # Self-signed for a try-out, or a placeholder cert-manager replaces.
      tls_cert=$dir/tls.crt tls_key=$dir/tls.key
      [ -f "$tls_cert" ] || openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
        -keyout "$tls_key" -out "$tls_cert" -days 3650 -subj "/CN=$host" -addext "subjectAltName=DNS:$host,DNS:*.$host" 2>/dev/null
    fi
    say "creating secrets in namespace nix"
    DOMAIN=$host NIX_OBJECT_STORE_PUBLIC_ORIGIN=$origin NIX_PUSH_VAPID_SUBJECT=$vapid_subject \
      NIX_AUTH_SETUP_CODE=$(env_get NIX_AUTH_SETUP_CODE) \
      NIX_ORIGIN_TLS_CERT_FILE=$tls_cert NIX_ORIGIN_TLS_KEY_FILE=$tls_key bash "$src/k8s/create-secrets.sh"
  fi

  # A .localhost try-out: nothing resolves the names inside the cluster, so cluster DNS gets them
  # pointed at the ingress controller (Core fetches OIDC discovery and the workers probe the origin).
  if [[ "$host" == *.localhost ]]; then
    if [ -z "$ingress_service" ]; then
      case "$ingress_class" in
        nginx) ingress_service=ingress-nginx/ingress-nginx-controller ;;
        traefik) ingress_service=kube-system/traefik ;;
        *) die "pass --ingress-service <namespace/name> for the $ingress_class controller" ;;
      esac
    fi
    ingress_ip=$(kubectl -n "${ingress_service%/*}" get service "${ingress_service#*/}" -o jsonpath='{.spec.clusterIP}')
    [ -n "$ingress_ip" ] || die "no cluster IP for service $ingress_service"
    corefile=$(kubectl -n kube-system get configmap coredns -o jsonpath='{.data.Corefile}')
    if ! grep -q " $host " <<<"$corefile "; then
      corefile=$(awk -v entry="        $ingress_ip $host $auth_host" '{ print } /^\.:53 \{/ { print "    hosts {"; print entry; print "        fallthrough"; print "    }" }' <<<"$corefile")
      kubectl -n kube-system patch configmap coredns --type merge -p "$(jq -n --arg c "$corefile" '{data:{Corefile:$c}}')" >/dev/null
      kubectl -n kube-system rollout restart deployment/coredns >/dev/null
      kubectl -n kube-system rollout status deployment/coredns --timeout=120s >/dev/null
    fi
  fi

  say "deploying Nix $version"
  NIX_DEPLOY_TARGET=kubernetes REGISTRY=$registry TAG=$version DOMAIN=$host PUBLIC_ORIGIN=$origin OIDC_ISSUER=$oidc_issuer \
    NIX_AUTH_MODE=$auth_mode OIDC_CLIENT_ID=$oidc_client_id NIX_TEMPLATE_BOOT_ENABLED=false NIX_INGRESS_CLOUDFLARE_ONLY=false \
    INGRESS_CLASS=$ingress_class STORAGE_CLASS=$storage_class STORAGE_CLASS_RETAIN=$storage_class POD_CIDR=$pod_cidr \
    INGRESS_SSL_REDIRECT=$([ "$scheme" = https ] && echo true || echo false) TLS_HOSTS=$tls_hosts bash "$src/k8s/deploy.sh"
  [ -z "$cluster_issuer" ] || kubectl -n nix annotate --overwrite ingress nix "cert-manager.io/cluster-issuer=$cluster_issuer" >/dev/null
  if [ "$auth_mode" = local ]; then
    if [ "$new_install" = true ]; then finish "$(env_get NIX_AUTH_SETUP_CODE)"; else finish -; fi
    echo "Token for scripts and template sync: run the migrator image's 'account service-token --name <name>' (see docs/install.md)."
  else
    finish oidc
  fi
  echo "Logs:    kubectl -n nix logs deployment/nix-api -f"
  exit 0
fi

# ══ Docker Compose ═════════════════════════════════════════════════════════════
env_file=$dir/nix.env
key_file=$dir/core-access-token.pem
new_install=false
[ -f "$env_file" ] || new_install=true
[ "$new_install" = false ] || [ "$migrate_auth" = false ] || die "no $env_file to migrate"
[ -f "$key_file" ] || openssl ecparam -name prime256v1 -genkey -noout -out "$key_file"
if [ "$new_install" = true ]; then
  say "writing $env_file"
  pg_app=$(secret 24) pg_migrator=$(secret 24) pg_collab=$(secret 24)
  # SEC1 DER for P-256: the private scalar is at offset 7, the public point the last 65 bytes.
  vapid_der=$(mktemp)
  openssl ecparam -name prime256v1 -genkey -noout | openssl ec -outform DER -out "$vapid_der" 2>/dev/null
  [ "$(wc -c < "$vapid_der" | tr -d ' ')" = 121 ] || die 'unexpected EC key encoding for the VAPID pair'
  vapid_private=$(dd if="$vapid_der" bs=1 skip=7 count=32 2>/dev/null | openssl base64 -A | tr '+/' '-_' | tr -d '=')
  vapid_public=$(tail -c 65 "$vapid_der" | openssl base64 -A | tr '+/' '-_' | tr -d '=')
  rm -f "$vapid_der"
  cat > "$env_file" <<ENVEOF
# Written by deploy/install.sh. Every value is a secret for this install; back this file up.
NIX_PUBLIC_ORIGIN=$origin
NIX_PUBLIC_HOST=$host
NIX_HTTP_PORT=$http_port
NIX_HTTPS_PORT=$https_port
# Core signs people in itself. The setup code is only asked for on the first-run page.
NIX_AUTH_MODE=local
NIX_AUTH_SETUP_CODE=$(secret 8)
# Explicitly empty: Compose refuses an unset sign-in variable so an old OIDC install cannot drift into local mode.
NIX_OIDC_ISSUER=
NIX_OIDC_CLIENT_ID=
NIX_COLLAB_OIDC_ISSUERS=$origin|http://nix-api:8080/public/v1/auth/jwks
NIX_COLLAB_OIDC_AUDIENCE=nix
NIX_PG_SUPERUSER_PASSWORD=$(secret 24)
NIX_PG_APP_PASSWORD=$pg_app
NIX_PG_MIGRATOR_PASSWORD=$pg_migrator
NIX_PG_COLLAB_PASSWORD=$pg_collab
NIX_MIGRATOR_CONNECTION_STRING=Host=postgres;Port=5432;Database=nix;Username=nix_migrator;Password=$pg_migrator
NIX_CORE_DATABASE_URL=Host=postgres;Port=5432;Database=nix;Username=nix_app;Password=$pg_app
NIX_COLLAB_DATABASE_URL=postgresql://nix_collab:$pg_collab@postgres:5432/nix
NIX_COLLAB_MIGRATOR_CONNECTION_STRING=postgresql://nix_migrator:$pg_migrator@postgres:5432/nix
NIX_INTERNAL_SECRET=$(secret 32)
NIX_PUBLIC_FORMS_SIGNING_KEY=$(secret 32)
NIX_PUSH_VAPID_PRIVATE_KEY=$vapid_private
NIX_PUSH_VAPID_PUBLIC_KEY=$vapid_public
NIX_PUSH_VAPID_SUBJECT=$vapid_subject
NIX_OBJECT_STORE_ENDPOINT=$origin
NIX_OBJECT_STORE_PUBLIC_ORIGIN=$origin
NIX_OBJECT_STORE_REGION=us-east-1
NIX_OBJECT_STORE_BUCKET=nix-worker-jobs
NIX_OBJECT_STORE_ACCESS_KEY=nix-root-$(secret 8)
NIX_OBJECT_STORE_SECRET_KEY=$(secret 32)
NIX_CORE_TOKEN_ISSUER=$origin
NIX_CORE_TOKEN_AUDIENCE=nix
NIX_CORE_TOKEN_KEY_ID=nix-core-$(date +%Y-%m)
NIX_CORE_TOKEN_SIGNING_KEY_FILE=$key_file
# cloudflared is parked behind the cloudflare profile; the manifest still wants a value.
CLOUDFLARE_TUNNEL_TOKEN=unused
ENVEOF
fi
[ "$(env_get NIX_PUBLIC_ORIGIN)" = "$origin" ] || die "$env_file was written for $(env_get NIX_PUBLIC_ORIGIN); pass that origin or use another --dir"

# An install made before Core could sign people in has an OIDC issuer and no NIX_AUTH_MODE. The
# master key marks the bundled Zitadel; any other oidc install uses a provider the operator runs.
auth_mode=$(env_get NIX_AUTH_MODE)
if [ -z "$auth_mode" ]; then
  if [ -n "$(env_get NIX_OIDC_ISSUER)" ]; then auth_mode=oidc; else auth_mode=local; fi
fi
bundled=false
{ [ "$auth_mode" = oidc ] && [ -n "$(env_get NIX_ZITADEL_MASTERKEY)" ]; } && bundled=true
if [ "$bundled" = true ] && [ "$migrate_auth" = false ]; then
  die "this install still uses the bundled Zitadel. This version signs people in itself and no longer includes Zitadel. Run this again with --migrate-local-auth --dry-run to see what would move, then with --migrate-local-auth."
fi
if [ "$migrate_auth" = true ] && [ "$bundled" = false ]; then
  [ "$auth_mode" = oidc ] || die "this install already signs people in with Nix itself; nothing to migrate"
  die "this install uses an identity provider you run, not the bundled Zitadel; nothing to migrate"
fi

export NIX_IMAGE_REGISTRY=$registry NIX_IMAGE_TAG=$version NIX_WEB_IMAGE_TAG=$version
compose=(docker compose -p nix --env-file "$env_file" -f "$src/compose.prod.yml" -f "$src/compose.quickstart.yml")
"${compose[@]}" config --quiet

# The bundled Zitadel's containers, as the earlier release created them in this Compose project. No
# overlay defines them any more, so they are found by label and never created, pulled or upgraded here.
zitadel_containers() {
  docker ps -a --filter label=com.docker.compose.project=nix --filter "label=com.docker.compose.service=$1" --format '{{.Names}}'
}

# Reads the bundled Zitadel's database and moves its accounts onto the existing principals in Core.
# Core's data protection keys are mounted because authenticator secrets are stored encrypted with them.
run_account_import() {
  # Secrets go in by name only, so they never show in the process list. The RP ID is the hostname
  # Core will use after the switch; without it the import falls back to Zitadel's own domain and
  # passkeys registered for the other name would be refused.
  NIX_ZITADEL_DATABASE_URL="Host=zitadel-db;Port=5432;Database=zitadel;Username=postgres;Password=$(env_get NIX_ZITADEL_DB_PASSWORD)" \
  NIX_ZITADEL_MASTERKEY=$(env_get NIX_ZITADEL_MASTERKEY) \
  "${compose[@]}" run --rm --no-deps \
    -v nix-api-data-protection:/var/lib/nix/data-protection \
    -e Nix__Bff__DataProtectionKeysPath=/var/lib/nix/data-protection \
    -e "Nix__Auth__Passkeys__RpId=$auth_host" \
    -e NIX_ZITADEL_DATABASE_URL -e NIX_ZITADEL_MASTERKEY \
    nix-migrate account import-zitadel "$@"
}

if [ "$migrate_auth" = true ]; then
  zdb=$(zitadel_containers zitadel-db)
  [ -n "$zdb" ] || die "the bundled Zitadel database container no longer exists in the nix Compose project, so there is nothing to import from"
  zdb_was_running=$(docker inspect --format '{{.State.Running}}' "$zdb" 2>/dev/null || true)
  say "starting the databases and bringing the schema to $version"
  "${compose[@]}" up -d --wait --wait-timeout 180 postgres
  docker start "$zdb" >/dev/null
  deadline=$((SECONDS + 120))
  until docker exec "$zdb" pg_isready -U postgres -d postgres >/dev/null 2>&1; do
    [ "$SECONDS" -lt "$deadline" ] || die "the Zitadel database ($zdb) did not become ready within 120s"
    sleep 2
  done
  "${compose[@]}" run --rm --no-deps nix-api-init >/dev/null
  "${compose[@]}" run --rm --no-deps nix-migrate
  if [ "$dry_run" = true ]; then
    say "dry run: nothing is changed"
    run_account_import --dry-run
    [ "$zdb_was_running" = true ] || docker stop "$zdb" >/dev/null
    exit 0
  fi
  run_account_import
  # Zitadel's data stays where it is; rolling back is restoring this copy of the env file.
  backup_env=$env_file.pre-local-auth
  cp -p "$env_file" "$backup_env"
  # Passkeys were registered for the old auth hostname, so it stays the WebAuthn RP ID and the
  # listener keeps answering /.well-known/webauthn there; nothing else is served on it.
  webauthn_file=$dir/webauthn.caddy
  cat > "$webauthn_file" <<CADDYEOF
# Related origins for passkeys registered before Nix signed people in itself (written by install.sh).
$issuer {
	header Content-Type application/json
	respond /.well-known/webauthn \`{"origins":["$origin"]}\` 200
	respond 404
}
CADDYEOF
  set_env NIX_AUTH_MODE local
  set_env NIX_OIDC_ISSUER ""
  set_env NIX_OIDC_CLIENT_ID ""
  set_env NIX_AUTH_PASSKEY_RP_ID "$auth_host"
  set_env NIX_WEBAUTHN_CADDY "$webauthn_file"
  set_env NIX_COLLAB_OIDC_ISSUERS "$origin|http://nix-api:8080/public/v1/auth/jwks"
  set_env NIX_COLLAB_OIDC_AUDIENCE nix
  # Stopped, not removed: the containers and volumes stay until the operator deletes them.
  leftover=$(for service in zitadel zitadel-init zitadel-db; do zitadel_containers "$service"; done | tr '\n' ' ')
  say "stopping the bundled identity provider (its containers and volumes are kept)"
  # shellcheck disable=SC2086
  docker stop $leftover >/dev/null
  auth_mode=local
  "${compose[@]}" config --quiet
fi

say "starting the database and object store"
"${compose[@]}" up -d --wait --wait-timeout 180 postgres nix-versitygw
"${compose[@]}" exec -T postgres psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -v app_password="$(env_get NIX_PG_APP_PASSWORD)" -v migrator_password="$(env_get NIX_PG_MIGRATOR_PASSWORD)" \
  -v collab_password="$(env_get NIX_PG_COLLAB_PASSWORD)" -v db_name=nix -f /nix-seed/seed.sql >/dev/null
if [ "$("${compose[@]}" exec -T postgres psql -X -tAc "SELECT 1 FROM pg_database WHERE datname = 'nix'" -U postgres -d postgres)" != 1 ]; then
  "${compose[@]}" exec -T postgres psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -c 'CREATE DATABASE nix OWNER nix_migrator' >/dev/null
fi
"${compose[@]}" exec -T postgres psql -X -v ON_ERROR_STOP=1 -U postgres -d nix -v db_name=nix -f /nix-seed/seed_database.sql >/dev/null
"${compose[@]}" --profile maintenance run --rm --no-deps nix-storage-init >/dev/null

say "running migrations"
"${compose[@]}" run --rm --no-deps nix-migrate
"${compose[@]}" run --rm --no-deps nix-template-presets
"${compose[@]}" run --rm --no-deps nix-api-init
"${compose[@]}" --profile maintenance run --rm --no-deps nix-collab-migrate
say "starting Nix $version"
"${compose[@]}" up -d
"${compose[@]}" up -d --wait --wait-timeout 300 nix-api nix-node nix-web
if [ "$auth_mode" = oidc ]; then
  finish oidc
elif [ "$migrate_auth" = true ]; then
  finish -
  printf '\nMigrated. People sign in with the same email and password; passkeys and authenticator apps came across.\n'
  printf "\nLeft behind, stopped and not removed: %s\nVolumes kept: nix-zitadel-data nix-zitadel-machinekey\nOnce you are satisfied, delete them:\n  docker rm %s\n  docker volume rm nix-zitadel-data nix-zitadel-machinekey\n" "$leftover" "$leftover"
  printf "\nTo roll back this version cannot run Zitadel, so reinstall the previous release with the saved env file:\n  cp %s %s\n  run this installer with --version <previous release>\n" "$backup_env" "$env_file"
elif [ "$new_install" = true ]; then
  finish "$(env_get NIX_AUTH_SETUP_CODE)"
else
  finish -
fi
echo "Logs:    ${compose[*]} logs -f"
