#!/usr/bin/env bash
# One line installs or upgrades Nix. With no argument it is a try-out on this machine at
# http://nix.localhost. It needs Docker with the Compose plugin, curl, openssl, jq, and about
# 8 GB of memory for Docker (Chrome and Firefox resolve .localhost names themselves; Safari
# needs them in /etc/hosts):
#
#   curl -fsSL https://raw.githubusercontent.com/sianachi/nixsites/main/deploy/install.sh | bash
#
# For a real install the argument is the public origin, with DNS for it and for auth.<host>
# pointing at the machine (or the cluster's ingress):
#
#   curl -fsSL https://raw.githubusercontent.com/sianachi/nixsites/main/deploy/install.sh \
#     | bash -s -- https://nix.example.org
#
# Docker (default): Caddy is the public listener on ports 80 and 443 and fetches the certificates;
# everything lands under --dir (default ~/nix), where nix.env holds every generated secret and is
# the only file to back up with the Docker volumes.
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
# NIX_SOURCE_DIR=<checkout> uses that checkout's deploy/ instead of downloading the release.
set -euo pipefail

repo=${NIX_REPO:-sianachi/nixsites}
registry=${NIX_IMAGE_REGISTRY:-ghcr.io/sianachi/nix}
version=
dir=$HOME/nix
target=compose
origin=
ingress_class= ingress_service= storage_class= pod_cidr= tls_cert= tls_key= cluster_issuer=
usage='usage: install.sh [--version <tag|sha>] [--dir <path>] [--kubernetes ...] [origin]'
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
  # Bytes. Warn below 7 GiB: an 8 GB Docker Desktop VM reports a little under 8 GiB,
  # and the common miss is a 2-4 GB default.
  min_bytes=$((7 * 1024 * 1024 * 1024))
  case "$mem" in
    ''|*[!0-9]*)
      warn "could not read how much memory Docker has. Nix wants about 8 GB."
      return 0
      ;;
  esac
  if [ "$mem" -lt "$min_bytes" ]; then
    mb=$(( mem / 1024 / 1024 ))
    whole=$(( mb / 1024 ))
    frac=$(( (mb % 1024) * 10 / 1024 ))
    warn "Docker has ${whole}.${frac} GiB available. Give it about 8 GB, or the stack thrashes."
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
    -h|--help) echo "$usage"; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) [ -z "$origin" ] || die "$usage"; origin=$1; shift ;;
  esac
done
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
auth_host="auth.$host"
issuer="$scheme://$auth_host${port:+:$port}"
if [ "$scheme" = https ]; then
  auth_port=${port:-443} auth_secure=true tls_mode=external http_port=80 https_port=${port:-443}
else
  auth_port=${port:-80} auth_secure=false tls_mode=disabled http_port=${port:-80} https_port=443
fi
host_header="$auth_host"
case "$auth_port" in 80|443) ;; *) host_header="$auth_host:$auth_port" ;; esac
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

# ── Identity provider: register the Nix application once ──────────────────────
# Needs admin_url (a loopback route to Zitadel's API) and pat (its bootstrap token); records
# the client and project ids in the state file. Idempotent: existing objects are found by name.
api() {
  local out code; out=$(mktemp)
  code=$(curl -sS -o "$out" -w '%{http_code}' -X "$1" "$admin_url$2" -H "Host: $host_header" \
    -H "Authorization: Bearer $pat" -H 'Content-Type: application/json' -d "$3")
  case "$code" in 2*) cat "$out"; rm -f "$out" ;; *) cat "$out" >&2; rm -f "$out"; die "identity provider refused $1 $2 ($code)" ;; esac
}
register_app() {
  say "waiting for the identity provider at $issuer"
  local deadline=$((SECONDS + 240)) project_id client_id
  until curl -fsS -o /dev/null -H "Host: $host_header" "$admin_url/.well-known/openid-configuration" 2>/dev/null; do
    [ "$SECONDS" -lt "$deadline" ] || die 'the identity provider did not answer within 240s'
    sleep 3
  done
  [ -n "$pat" ] || die 'the identity provider wrote no bootstrap token'
  # The built-in login, not the separate v2 login service this stack does not run.
  api PUT /v2/features/instance '{"loginV2":{"required":false}}' >/dev/null
  project_id=$(api POST /management/v1/projects/_search '{"queries":[{"nameQuery":{"name":"Nix","method":"TEXT_QUERY_METHOD_EQUALS"}}]}' \
    | jq -r 'first(.result[]? | select(.name == "Nix") | .id) // empty')
  [ -n "$project_id" ] || project_id=$(api POST /management/v1/projects '{"name":"Nix"}' | jq -r .id)
  client_id=$(api POST "/management/v1/projects/$project_id/apps/_search" '{"queries":[]}' \
    | jq -r 'first(.result[]? | select(.name == "Nix Web") | .oidcConfig.clientId) // empty')
  if [ -z "$client_id" ]; then
    # Public client with PKCE, as Core's browser login expects. devMode allows the plain-http
    # redirect of a .localhost try-out and is off for https.
    local dev_mode=false app; [ "$scheme" = https ] || dev_mode=true
    app=$(jq -nc --arg cb "$origin/auth/callback" --arg home "$origin" --argjson dev "$dev_mode" '{
      name: "Nix Web", redirectUris: [$cb], postLogoutRedirectUris: [$home],
      responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
      grantTypes: ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE", "OIDC_GRANT_TYPE_REFRESH_TOKEN"],
      appType: "OIDC_APP_TYPE_USER_AGENT", authMethodType: "OIDC_AUTH_METHOD_TYPE_NONE",
      devMode: $dev, accessTokenType: "OIDC_TOKEN_TYPE_JWT",
      accessTokenRoleAssertion: false, idTokenRoleAssertion: false, idTokenUserinfoAssertion: true }')
    client_id=$(api POST "/management/v1/projects/$project_id/apps/oidc" "$app" | jq -r .clientId)
    say "registered the Nix application with the identity provider"
  fi
  set_env NIX_OIDC_CLIENT_ID "$client_id"
  set_env NIX_BOOTSTRAP_OIDC_PROJECT_ID "$project_id"
}

finish() {
  cat <<EOF

Nix is running at $origin

  Sign in as:  admin@nix.$auth_host
  Password:    $1  (you will be asked to change it)

State: $dir
Upgrade: run this installer again with --version <newer release>
EOF
  [ "$scheme" = https ] || echo "Try-out: Chrome and Firefox resolve $host and $auth_host on their own; Safari needs both in /etc/hosts as 127.0.0.1."
}

# ══ Kubernetes ═════════════════════════════════════════════════════════════════
if [ "$target" = kubernetes ]; then
  env_file=$dir/kubernetes.env
  [ -f "$env_file" ] || printf 'NIX_PUBLIC_ORIGIN=%s\nNIX_OIDC_CLIENT_ID=pending\nNIX_BOOTSTRAP_OIDC_PROJECT_ID=pending\n' "$origin" > "$env_file"
  [ "$(env_get NIX_PUBLIC_ORIGIN)" = "$origin" ] || die "$env_file was written for $(env_get NIX_PUBLIC_ORIGIN); pass that origin or use another --dir"
  kubectl cluster-info >/dev/null 2>&1 || die 'kubectl has no working context'
  ingress_class=${ingress_class:-$(kubectl get ingressclass -o jsonpath='{.items[0].metadata.name}')}
  storage_class=${storage_class:-$(kubectl get storageclass -o jsonpath='{.items[?(@.metadata.annotations.storageclass\.kubernetes\.io/is-default-class=="true")].metadata.name}')}
  pod_cidr=${pod_cidr:-$(kubectl get nodes -o jsonpath='{.items[0].spec.podCIDR}')}
  [ -n "$ingress_class" ] || die 'no IngressClass found; pass --ingress-class'
  [ -n "$storage_class" ] || die 'no default StorageClass; pass --storage-class'
  [ -n "$pod_cidr" ] || die 'cannot read the pod CIDR; pass --pod-cidr'
  tls_hosts="[\"$host\", \"*.$host\"]"
  [ -z "$cluster_issuer" ] || tls_hosts="[\"$host\", \"$auth_host\"]"

  if ! kubectl -n nix get secret nix-db >/dev/null 2>&1; then
    if [ -z "$tls_cert" ]; then
      # Self-signed for a try-out, or a placeholder cert-manager replaces.
      tls_cert=$dir/tls.crt tls_key=$dir/tls.key
      [ -f "$tls_cert" ] || openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
        -keyout "$tls_key" -out "$tls_cert" -days 3650 -subj "/CN=$host" -addext "subjectAltName=DNS:$host,DNS:*.$host" 2>/dev/null
    fi
    say "creating secrets in namespace nix"
    DOMAIN=$host NIX_OBJECT_STORE_PUBLIC_ORIGIN=$origin NIX_PUSH_VAPID_SUBJECT=$vapid_subject \
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

  deploy() {
    NIX_DEPLOY_TARGET=kubernetes REGISTRY=$registry TAG=$version DOMAIN=$host PUBLIC_ORIGIN=$origin OIDC_ISSUER=$issuer \
      OIDC_CLIENT_ID=$(env_get NIX_OIDC_CLIENT_ID) NIX_TEMPLATE_BOOT_ENABLED=false NIX_INGRESS_CLOUDFLARE_ONLY=false \
      INGRESS_CLASS=$ingress_class STORAGE_CLASS=$storage_class STORAGE_CLASS_RETAIN=$storage_class POD_CIDR=$pod_cidr \
      AUTH_PORT=$auth_port AUTH_SECURE=$auth_secure ZITADEL_TLS_MODE=$tls_mode INGRESS_SSL_REDIRECT=$auth_secure TLS_HOSTS=$tls_hosts env "$@" bash "$src/k8s/deploy.sh"
  }
  if [ "$(env_get NIX_OIDC_CLIENT_ID)" = pending ]; then
    say "deploying Nix $version (first pass, before the application is registered)"
    deploy
    admin_url=http://127.0.0.1:${NIX_ZITADEL_ADMIN_PORT:-8301}
    kubectl -n nix port-forward service/nix-zitadel "${NIX_ZITADEL_ADMIN_PORT:-8301}:8080" >/dev/null 2>&1 &
    forward=$!
    trap 'kill $forward 2>/dev/null' EXIT
    pat=$(kubectl -n nix exec deployment/nix-zitadel -c pat -- cat /machinekey/pat.txt | tr -d '\r\n')
    register_app
    kill $forward 2>/dev/null; trap - EXIT
  fi
  say "deploying Nix $version"
  deploy NIX_BOOTSTRAP_IDENTITY=true NIX_BOOTSTRAP_TENANT_NAME=Nix NIX_BOOTSTRAP_OIDC_PROJECT_ID="$(env_get NIX_BOOTSTRAP_OIDC_PROJECT_ID)"
  [ -z "$cluster_issuer" ] || kubectl -n nix annotate --overwrite ingress nix "cert-manager.io/cluster-issuer=$cluster_issuer" >/dev/null
  finish "$(kubectl -n nix get secret nix-zitadel -o jsonpath='{.data.admin-password}' | base64 -d)"
  echo "Logs:    kubectl -n nix logs deployment/nix-api -f"
  exit 0
fi

# ══ Docker Compose ═════════════════════════════════════════════════════════════
env_file=$dir/nix.env
key_file=$dir/core-access-token.pem
[ -f "$key_file" ] || openssl ecparam -name prime256v1 -genkey -noout -out "$key_file"
if [ ! -f "$env_file" ]; then
  say "writing $env_file"
  pg_app=$(secret 24) pg_migrator=$(secret 24) pg_collab=$(secret 24)
  # SEC1 DER for P-256: the private scalar is at offset 7, the public point the last 65 bytes.
  vapid_der=$(mktemp)
  openssl ecparam -name prime256v1 -genkey -noout | openssl ec -outform DER -out "$vapid_der" 2>/dev/null
  [ "$(wc -c < "$vapid_der" | tr -d ' ')" = 121 ] || die 'unexpected EC key encoding for the VAPID pair'
  vapid_private=$(dd if="$vapid_der" bs=1 skip=7 count=32 2>/dev/null | openssl base64 -A | tr '+/' '-_' | tr -d '=')
  vapid_public=$(tail -c 65 "$vapid_der" | openssl base64 -A | tr '+/' '-_' | tr -d '=')
  rm -f "$vapid_der"
  cat > "$env_file" <<EOF
# Written by deploy/install.sh. Every value is a secret for this install; back this file up.
NIX_PUBLIC_ORIGIN=$origin
NIX_PUBLIC_HOST=$host
NIX_AUTH_HOST=$auth_host
NIX_AUTH_PORT=$auth_port
NIX_AUTH_SECURE=$auth_secure
NIX_HTTP_PORT=$http_port
NIX_HTTPS_PORT=$https_port
NIX_OIDC_ISSUER=$issuer
NIX_OIDC_CLIENT_ID=pending
NIX_BOOTSTRAP_OIDC_PROJECT_ID=pending
NIX_BOOTSTRAP_TENANT_NAME=Nix
NIX_ZITADEL_TLS_MODE=$tls_mode
NIX_ZITADEL_MASTERKEY=$(secret 16)
NIX_ZITADEL_DB_PASSWORD=$(secret 24)
NIX_ZITADEL_USER_PASSWORD=$(secret 24)
NIX_ADMIN_USERNAME=admin
NIX_ADMIN_PASSWORD=$(secret 12)Aa1!
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
EOF
fi
[ "$(env_get NIX_PUBLIC_ORIGIN)" = "$origin" ] || die "$env_file was written for $(env_get NIX_PUBLIC_ORIGIN); pass that origin or use another --dir"

export NIX_IMAGE_REGISTRY=$registry NIX_IMAGE_TAG=$version NIX_WEB_IMAGE_TAG=$version
compose=(docker compose -p nix --env-file "$env_file" -f "$src/compose.prod.yml" -f "$src/compose.quickstart.yml")
"${compose[@]}" config --quiet

say "starting the database, broker, object store and identity provider"
"${compose[@]}" up -d --wait --wait-timeout 180 postgres nix-versitygw
# No healthcheck on the distroless Zitadel image; register_app polls its discovery document.
"${compose[@]}" up -d zitadel
"${compose[@]}" exec -T postgres psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -v app_password="$(env_get NIX_PG_APP_PASSWORD)" -v migrator_password="$(env_get NIX_PG_MIGRATOR_PASSWORD)" \
  -v collab_password="$(env_get NIX_PG_COLLAB_PASSWORD)" -v db_name=nix -f /nix-seed/seed.sql >/dev/null
if [ "$("${compose[@]}" exec -T postgres psql -X -tAc "SELECT 1 FROM pg_database WHERE datname = 'nix'" -U postgres -d postgres)" != 1 ]; then
  "${compose[@]}" exec -T postgres psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -c 'CREATE DATABASE nix OWNER nix_migrator' >/dev/null
fi
"${compose[@]}" exec -T postgres psql -X -v ON_ERROR_STOP=1 -U postgres -d nix -v db_name=nix -f /nix-seed/seed_database.sql >/dev/null
"${compose[@]}" --profile maintenance run --rm --no-deps nix-storage-init >/dev/null

if [ "$(env_get NIX_OIDC_CLIENT_ID)" = pending ]; then
  admin_url=http://127.0.0.1:${NIX_ZITADEL_ADMIN_PORT:-8301}
  pat=
  deadline=$((SECONDS + 240))
  until [ -n "$pat" ] || [ "$SECONDS" -ge "$deadline" ]; do
    pat=$(docker run --rm -v nix-zitadel-machinekey:/machinekey:ro busybox:1.37 cat /machinekey/pat.txt 2>/dev/null | tr -d '\r\n')
    [ -n "$pat" ] || sleep 3
  done
  register_app
fi

say "running migrations"
"${compose[@]}" run --rm --no-deps nix-migrate
"${compose[@]}" --profile bootstrap run --rm --no-deps nix-identity-bootstrap
"${compose[@]}" run --rm --no-deps nix-template-presets
"${compose[@]}" run --rm --no-deps nix-api-init
"${compose[@]}" --profile maintenance run --rm --no-deps nix-collab-migrate
say "starting Nix $version"
"${compose[@]}" up -d
"${compose[@]}" up -d --wait --wait-timeout 300 nix-api nix-node nix-web
finish "$(env_get NIX_ADMIN_PASSWORD)"
echo "Logs:    ${compose[*]} logs -f"
