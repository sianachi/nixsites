#!/usr/bin/env bash
# One-time setup: generates the secrets a Nix deployment needs and the derived
# connection strings, then loads deploy/seed's cluster-level SQL as a ConfigMap.
#
# Do NOT reuse the values in .env.example - that file is committed on purpose and every
# value in it is public. Run this once per cluster; re-running after nix-db already exists
# refuses rather than silently rotating passwords the seeded database roles don't know about
# yet (use deploy/k8s/job-seed.yaml to rotate instead - see section 9 of
# docs/nix-k3s-deployment.md).
#
# This puts passwords through the shell and into `kubectl create secret`, which is what ends
# up in your shell history. Consider sealed-secrets or an external-secrets operator instead
# once this is more than a first bring-up.
#
# Existing clusters can update an external service secret without touching database or signing
# secrets by running this script with `--object-store-only`, `--sites-only`,
# `--tls-only`, `--backup-offsite-only`, `--sites-cloudflare-only`, `--push-only` (creates the Web Push key pair only when
# missing) or `--zitadel-only` (creates the identity provider's secret only when missing). Production values (keys, certificate paths) come from the operator's local,
# uncommitted environment, never from this repository.
#
# Identity bootstrap values (NIX_BOOTSTRAP_TENANT_NAME, NIX_BOOTSTRAP_TENANT_ID,
# NIX_BOOTSTRAP_OIDC_PROJECT_ID) are not secrets and are not stored here; pass them to
# deploy/k8s/deploy.sh with NIX_BOOTSTRAP_IDENTITY=true (see its header).
set -euo pipefail
cd "$(dirname "$0")/../.."

kubectl get namespace nix >/dev/null 2>&1 || kubectl apply -f deploy/k8s/namespace.yaml

create_object_store_secret() {
  local update_existing="$1"

  # Defaults describe the in-cluster versitygw (deploy/k8s/objectstore.yaml): browsers reach it on
  # the app origin through Caddy, and the generated pair becomes its root account. Set every value
  # to point at an external S3 store instead. Re-running rotates the generated pair.
  if [ -z "${NIX_OBJECT_STORE_PUBLIC_ORIGIN:-}" ]; then
    : "${DOMAIN:?set DOMAIN (the app origin serves capability URLs) or NIX_OBJECT_STORE_PUBLIC_ORIGIN}"
  fi
  NIX_OBJECT_STORE_ENDPOINT="${NIX_OBJECT_STORE_ENDPOINT:-http://nix-versitygw:7070}"
  NIX_OBJECT_STORE_PUBLIC_ORIGIN="${NIX_OBJECT_STORE_PUBLIC_ORIGIN:-https://$DOMAIN}"
  NIX_OBJECT_STORE_BUCKET="${NIX_OBJECT_STORE_BUCKET:-nix-worker-jobs}"
  NIX_OBJECT_STORE_ACCESS_KEY="${NIX_OBJECT_STORE_ACCESS_KEY:-nix-root-$(openssl rand -hex 8)}"
  NIX_OBJECT_STORE_SECRET_KEY="${NIX_OBJECT_STORE_SECRET_KEY:-$(openssl rand -hex 32)}"

  local -a object_store_secret_args=(
    -n nix create secret generic nix-object-store
    --from-literal=endpoint="$NIX_OBJECT_STORE_ENDPOINT"
    --from-literal=public-origin="$NIX_OBJECT_STORE_PUBLIC_ORIGIN"
    --from-literal=region="${NIX_OBJECT_STORE_REGION:-us-east-1}"
    --from-literal=bucket="$NIX_OBJECT_STORE_BUCKET"
    --from-literal=access-key="$NIX_OBJECT_STORE_ACCESS_KEY"
    --from-literal=secret-key="$NIX_OBJECT_STORE_SECRET_KEY"
  )
  if [ "$update_existing" = true ]; then
    kubectl "${object_store_secret_args[@]}" --dry-run=client -o yaml | kubectl apply -f -
  else
    kubectl "${object_store_secret_args[@]}"
  fi
}

# Calendar sync OAuth clients (ADR-0052). Every value is optional: a provider without a client id
# and secret is reported unavailable. The api Deployment reads this secret with optional keys, so a
# cluster without it still starts. Redirect URIs to register at the providers:
#   https://$DOMAIN/auth/calendar/callback/google and https://$DOMAIN/auth/calendar/callback/microsoft
create_calendar_secret() {
  local update_existing="$1"
  local -a calendar_secret_args=(
    -n nix create secret generic nix-calendar
    --from-literal=google-client-id="${NIX_CALENDAR_GOOGLE_CLIENT_ID:-}"
    --from-literal=google-client-secret="${NIX_CALENDAR_GOOGLE_CLIENT_SECRET:-}"
    --from-literal=microsoft-client-id="${NIX_CALENDAR_MICROSOFT_CLIENT_ID:-}"
    --from-literal=microsoft-client-secret="${NIX_CALENDAR_MICROSOFT_CLIENT_SECRET:-}"
    --from-literal=microsoft-tenant="${NIX_CALENDAR_MICROSOFT_TENANT:-common}"
  )
  if [ "$update_existing" = true ]; then
    kubectl "${calendar_secret_args[@]}" --dry-run=client -o yaml | kubectl apply -f -
  else
    kubectl "${calendar_secret_args[@]}"
  fi
}

# Sites (ADR-0063). Core signs the sites worker's uploads with the object-store key above. Serve
# gets a separate key that can only read the sites bucket: by default a generated versitygw account
# that deploy/k8s/job-storage-init.yaml creates and scopes with a bucket policy; on an external store
# such as Cloudflare R2, supply an "Object Read only" token scoped to the bucket. The reserved
# owners are optional workspace UUIDs allowed to claim the slugs nix and osinachi.
create_sites_secret() {
  local update_existing="$1"

  NIX_SITES_READ_ACCESS_KEY="${NIX_SITES_READ_ACCESS_KEY:-nix-sites-read-$(openssl rand -hex 6)}"
  NIX_SITES_READ_SECRET_KEY="${NIX_SITES_READ_SECRET_KEY:-$(openssl rand -hex 32)}"
  if [ "$NIX_SITES_READ_ACCESS_KEY" = "${NIX_OBJECT_STORE_ACCESS_KEY:-}" ]; then
    echo "NIX_SITES_READ_ACCESS_KEY must not be the object store's write key." >&2
    exit 1
  fi

  local -a sites_secret_args=(
    -n nix create secret generic nix-sites
    --from-literal=bucket="${NIX_SITES_BUCKET:-nix-sites}"
    --from-literal=read-access-key="$NIX_SITES_READ_ACCESS_KEY"
    --from-literal=read-secret-key="$NIX_SITES_READ_SECRET_KEY"
  )
  # An empty value would fail Core's Guid binding, so an unset owner leaves the key out.
  if [ -n "${NIX_SITES_RESERVED_OWNER_NIX:-}" ]; then
    sites_secret_args+=(--from-literal=reserved-owner-nix="$NIX_SITES_RESERVED_OWNER_NIX")
  fi
  if [ -n "${NIX_SITES_RESERVED_OWNER_OSINACHI:-}" ]; then
    sites_secret_args+=(--from-literal=reserved-owner-osinachi="$NIX_SITES_RESERVED_OWNER_OSINACHI")
  fi
  if [ "$update_existing" = true ]; then
    kubectl "${sites_secret_args[@]}" --dry-run=client -o yaml | kubectl apply -f -
  else
    kubectl "${sites_secret_args[@]}"
  fi
}

# Custom-hostname DNS automation for sites (Nix:Sites:Cloudflare). Every value is optional and an
# unset one is left out of the secret (an empty workspace id would fail Core's Guid binding), so
# without NIX_SITES_CLOUDFLARE_API_TOKEN(_FILE) and NIX_SITES_CLOUDFLARE_MANAGED_ZONE automation is off.
create_sites_cloudflare_secret() {
  local update_existing="$1"
  local api_token="${NIX_SITES_CLOUDFLARE_API_TOKEN:-}"
  if [ -z "$api_token" ] && [ -n "${NIX_SITES_CLOUDFLARE_API_TOKEN_FILE:-}" ]; then
    api_token="$(tr -d '[:space:]' < "$NIX_SITES_CLOUDFLARE_API_TOKEN_FILE")"
  fi
  local -a cloudflare_secret_args=(-n nix create secret generic nix-sites-cloudflare)
  local pair
  for pair in \
    "api-token=$api_token" \
    "account-id=${NIX_SITES_CLOUDFLARE_ACCOUNT_ID:-}" \
    "default-target=${NIX_SITES_CLOUDFLARE_DEFAULT_TARGET:-}" \
    "custom-hostname-target=${NIX_SITES_CUSTOM_HOSTNAME_TARGET:-}" \
    "managed-zone=${NIX_SITES_CLOUDFLARE_MANAGED_ZONE:-}" \
    "managed-zone-workspace-id=${NIX_SITES_CLOUDFLARE_MANAGED_ZONE_WORKSPACE_ID:-}"; do
    if [ -n "${pair#*=}" ]; then
      cloudflare_secret_args+=(--from-literal="$pair")
    fi
  done
  if [ "$update_existing" = true ]; then
    kubectl "${cloudflare_secret_args[@]}" --dry-run=client -o yaml | kubectl apply -f -
  else
    kubectl "${cloudflare_secret_args[@]}"
  fi
}

# Web Push (RFC 8291/8292) key pair for the deployment's lifetime. Created once and never rotated
# here: rotating it orphans every browser's push subscription. The private key (32 raw bytes) goes to
# the worker only; Core serves the public key (uncompressed point). Both are base64url, unpadded.
# Supply NIX_PUSH_VAPID_PRIVATE_KEY and NIX_PUSH_VAPID_PUBLIC_KEY to load an existing pair.
create_push_secret() {
  if kubectl -n nix get secret nix-push-vapid >/dev/null 2>&1; then
    echo "secret nix-push-vapid already exists - leaving it (rotating breaks push subscriptions)."
    return 0
  fi
  local subject="${NIX_PUSH_VAPID_SUBJECT:-}"
  if [ -z "$subject" ]; then
    : "${DOMAIN:?set NIX_PUSH_VAPID_SUBJECT (mailto: or https: operator contact) or DOMAIN}"
    subject="https://$DOMAIN"
  fi
  local private_key="${NIX_PUSH_VAPID_PRIVATE_KEY:-}" public_key="${NIX_PUSH_VAPID_PUBLIC_KEY:-}"
  if [ -z "$private_key" ] || [ -z "$public_key" ]; then
    local der_file
    der_file="$(mktemp)"
    # SEC1 DER for P-256 with named-curve parameters is a fixed 121 bytes: the private scalar sits at
    # offset 7 and the public point is the last 65 bytes.
    openssl ecparam -name prime256v1 -genkey -noout | openssl ec -outform DER -out "$der_file" 2>/dev/null
    if [ "$(wc -c < "$der_file" | tr -d ' ')" != 121 ]; then
      rm -f "$der_file"
      echo "unexpected EC key encoding while generating the VAPID key pair" >&2
      exit 1
    fi
    private_key="$(dd if="$der_file" bs=1 skip=7 count=32 2>/dev/null | openssl base64 -A | tr '+/' '-_' | tr -d '=')"
    public_key="$(tail -c 65 "$der_file" | openssl base64 -A | tr '+/' '-_' | tr -d '=')"
    rm -f "$der_file"
  fi
  kubectl -n nix create secret generic nix-push-vapid \
    --from-literal=private-key="$private_key" \
    --from-literal=public-key="$public_key" \
    --from-literal=subject="$subject"
}

# Cloudflare Origin CA certificate for $DOMAIN and *.$DOMAIN (which covers auth.$DOMAIN), read
# from local files.
create_tls_secret() {
  : "${NIX_ORIGIN_TLS_CERT_FILE:?set NIX_ORIGIN_TLS_CERT_FILE to the origin certificate PEM}"
  : "${NIX_ORIGIN_TLS_KEY_FILE:?set NIX_ORIGIN_TLS_KEY_FILE to its private key PEM}"
  kubectl -n nix create secret tls nix-tls \
    --cert="$NIX_ORIGIN_TLS_CERT_FILE" --key="$NIX_ORIGIN_TLS_KEY_FILE" \
    --dry-run=client -o yaml | kubectl apply -f -
}

# Zitadel (deploy/k8s/zitadel.yaml). Created once and never rotated here: the masterkey encrypts
# Zitadel's stored secrets, so replacing it makes the instance unreadable. The first administrator's
# password is generated unless NIX_ZITADEL_ADMIN_PASSWORD is set, and must be changed at first sign-in.
create_zitadel_secret() {
  if kubectl -n nix get secret nix-zitadel >/dev/null 2>&1; then
    echo "secret nix-zitadel already exists - leaving it (its masterkey must never change)."
    return 0
  fi
  local admin_password="${NIX_ZITADEL_ADMIN_PASSWORD:-$(openssl rand -hex 12)Aa1!}"
  kubectl -n nix create secret generic nix-zitadel \
    --from-literal=masterkey="$(openssl rand -hex 16)" \
    --from-literal=db-password="$(openssl rand -hex 24)" \
    --from-literal=admin-username="${NIX_ZITADEL_ADMIN_USERNAME:-admin}" \
    --from-literal=admin-password="$admin_password"
  echo "Zitadel administrator: kubectl -n nix get secret nix-zitadel -o jsonpath='{.data.admin-password}' | base64 -d"
}

# Off-node backup (deploy/k8s/backup.yaml): restic's own variables, the names Compose's
# offsite.sh credentials file uses, read from the operator's environment. Values go to kubectl
# through a mode-600 temporary env file, never argv or output. Re-running replaces the secret;
# RESTIC_PASSWORD must stay the repository's password.
create_backup_offsite_secret() {
  local key
  for key in RESTIC_REPOSITORY RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
    if [ -z "${!key:-}" ]; then
      echo "set $key in the environment (AWS_DEFAULT_REGION defaults to auto)" >&2
      exit 1
    fi
  done
  offsite_env_file="$(umask 077 && mktemp)"
  trap 'rm -f "$offsite_env_file"' EXIT
  {
    printf 'RESTIC_REPOSITORY=%s\n' "$RESTIC_REPOSITORY"
    printf 'RESTIC_PASSWORD=%s\n' "$RESTIC_PASSWORD"
    printf 'AWS_ACCESS_KEY_ID=%s\n' "$AWS_ACCESS_KEY_ID"
    printf 'AWS_SECRET_ACCESS_KEY=%s\n' "$AWS_SECRET_ACCESS_KEY"
    printf 'AWS_DEFAULT_REGION=%s\n' "${AWS_DEFAULT_REGION:-auto}"
  } > "$offsite_env_file"
  kubectl -n nix create secret generic nix-backup-offsite --from-env-file="$offsite_env_file" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  rm -f "$offsite_env_file"
  echo "secret nix-backup-offsite applied."
}

case "${1:-}" in
  --backup-offsite-only)
    create_backup_offsite_secret
    echo "The next nightly backup pushes off the node. Deploy with NIX_BACKUP_OFFSITE=true to require it."
    exit 0
    ;;
  --zitadel-only)
    create_zitadel_secret
    exit 0
    ;;
  --object-store-only)
    create_object_store_secret true
    echo "Object-store configuration updated. Run deploy/k8s/deploy.sh to roll it out."
    exit 0
    ;;
  --calendar-only)
    create_calendar_secret true
    echo "Calendar OAuth clients updated. Run deploy/k8s/deploy.sh to roll them out."
    exit 0
    ;;
  --sites-only)
    create_sites_secret true
    echo "Sites configuration updated. Run deploy/k8s/deploy.sh to roll it out."
    exit 0
    ;;
  --sites-cloudflare-only)
    create_sites_cloudflare_secret true
    echo "Sites DNS automation updated. Restart Core to load it: kubectl -n nix rollout restart deployment/nix-api"
    exit 0
    ;;
  --push-only)
    create_push_secret
    exit 0
    ;;
  --tls-only)
    create_tls_secret
    echo "Origin certificate updated."
    exit 0
    ;;
  "") ;;
  *)
    echo "usage: deploy/k8s/create-secrets.sh [--backup-offsite-only|--object-store-only|--calendar-only|--sites-only|--sites-cloudflare-only|--push-only|--tls-only|--zitadel-only]" >&2
    exit 2
    ;;
esac

if kubectl -n nix get secret nix-db >/dev/null 2>&1; then
  echo "secret nix-db already exists in namespace nix - refusing to overwrite. Delete it" >&2
  echo "explicitly first if you really mean to start over." >&2
  exit 1
fi

# Hex, not base64: these passwords also get embedded in postgresql:// URLs below (the
# collab service parses its connection string with new URL() and refuses to start on a
# parse failure), and base64's +, / and = characters break that parse silently otherwise.
kubectl -n nix create secret generic nix-db \
  --from-literal=superuser-password="$(openssl rand -hex 24)" \
  --from-literal=app-password="$(openssl rand -hex 24)" \
  --from-literal=migrator-password="$(openssl rand -hex 24)" \
  --from-literal=collab-password="$(openssl rand -hex 24)"

# Core and every internal service must carry the same value: it proves which service is calling.
# The user's own token still proves on whose behalf.
kubectl -n nix create secret generic nix-internal \
  --from-literal=secret="$(openssl rand -hex 32)" \
  --from-literal=public-forms-signing-key="$(openssl rand -hex 32)"

create_object_store_secret false
create_calendar_secret false
create_sites_secret false
create_sites_cloudflare_secret false
create_push_secret
create_tls_secret
create_zitadel_secret

auth_key_file="$(mktemp)"
trap 'rm -f "$auth_key_file"' EXIT
openssl ecparam -name prime256v1 -genkey -noout -out "$auth_key_file"
kubectl -n nix create secret generic nix-auth \
  --from-file=access-token-signing-key.pem="$auth_key_file"

APP_PW=$(kubectl -n nix get secret nix-db -o jsonpath='{.data.app-password}' | base64 -d)
MIG_PW=$(kubectl -n nix get secret nix-db -o jsonpath='{.data.migrator-password}' | base64 -d)
COL_PW=$(kubectl -n nix get secret nix-db -o jsonpath='{.data.collab-password}' | base64 -d)

kubectl -n nix create secret generic nix-connections \
  --from-literal=core="Host=postgres;Port=5432;Database=nix;Username=nix_app;Password=$APP_PW" \
  --from-literal=migrator="Host=postgres;Port=5432;Database=nix;Username=nix_migrator;Password=$MIG_PW" \
  --from-literal=collab="postgresql://nix_collab:$COL_PW@postgres:5432/nix" \
  --from-literal=collab-migrator="postgresql://nix_migrator:$MIG_PW@postgres:5432/nix"

kubectl -n nix create configmap nix-seed \
  --from-file=seed.sql=deploy/seed/seed.sql \
  --from-file=seed_database.sql=deploy/seed/seed_database.sql

echo "Secrets and seed ConfigMap created. Next: deploy/k8s/deploy.sh"
