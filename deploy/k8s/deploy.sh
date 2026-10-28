#!/usr/bin/env bash
# Applies a Nix release to k3s, in the order that keeps a bad step from reaching users:
# database -> object store -> seed -> identity database -> migrations -> identity bootstrap (opt-in) ->
# preset reconciliation ->
# workloads (with Zitadel) -> ingress -> worker -> managed templates.
#
# Run deploy/k8s/create-secrets.sh once per cluster before the first run of this script.
# Run deploy/docker/build-and-push.sh first each time, with the same REGISTRY and TAG.
#
#   REGISTRY=ghcr.io/you/nix TAG=$(git rev-parse HEAD) \
#   OIDC_CLIENT_ID=your-client-id DOMAIN=nix.example.com \
#   deploy/k8s/deploy.sh
#
# SITES_FOREIGN_LABEL_SUFFIX (default -home) is the label suffix a second deployment sharing the
# sites domain owns (<slug>-home.$DOMAIN); slugs ending with it are refused here. Set it empty when
# no other deployment shares the domain.
#
# DOMAIN is the app's apex and also the sites domain: sites are served at <slug>.$DOMAIN. The
# bundled Zitadel answers at auth.$DOMAIN, which is the default OIDC_ISSUER; set OIDC_ISSUER only
# for an external identity provider. OIDC_CLIENT_ID is the Zitadel application's client id: on a
# first install deploy once with a placeholder, create the application, then deploy again.
#
# Managed templates need a workspace, a Zitadel project and a service-account key that a first install
# does not have yet. Set NIX_TEMPLATE_BOOT_ENABLED=false until they exist; the step is then skipped
# and everything else, the Ingress included, is applied. TEMPLATE_BOOT_* is required otherwise.
#
# NIX_BACKUP_OFFSITE (default false): true requires the nix-backup-offsite secret
# (create-secrets.sh --backup-offsite-only) and makes the nightly backup Job fail without it.
# The Job pushes off the node whenever that secret exists, whatever this flag says.
#
# Identity bootstrap (opt-in): a fresh install has no tenant or identity_provider row, so nobody can
# sign in. Once OIDC_CLIENT_ID is the real application id, deploy once with NIX_BOOTSTRAP_IDENTITY=true,
# NIX_BOOTSTRAP_TENANT_NAME and NIX_BOOTSTRAP_OIDC_PROJECT_ID (the identity provider's project id,
# the audience of machine tokens); NIX_BOOTSTRAP_TENANT_ID is optional. After migrations it runs
# deploy/seed/bootstrap_identity.sql in the postgres pod against OIDC_ISSUER/OIDC_CLIENT_ID. Idempotent.
#
# NIX_SITES_REQUIRE_OPERATOR_APPROVAL (default true) holds a site's first publish for an operator.
#
# NIX_MCP_ENABLED (default true) serves remote MCP at /mcp (deploy/k8s/mcp.yaml); false removes it
# and Core stops advertising the endpoint.
#
# POD_CIDR defaults to k3s's stock Flannel range (10.42.0.0/16) - confirm yours with:
#   kubectl -n kube-system get configmap -o yaml | grep -i cluster-cidr
set -euo pipefail
if [ "${NIX_DEPLOY_TARGET:-compose}" != kubernetes ]; then
  echo 'Kubernetes deployment is inactive. Use deploy/compose/deploy.sh.' >&2
  echo 'An explicit NIX_DEPLOY_TARGET=kubernetes is required to return to this target.' >&2
  exit 2
fi
cd "$(dirname "$0")/../.."
source deploy/k8s/template-boot-config.sh

: "${REGISTRY:?set REGISTRY, matching what build-and-push.sh pushed to}"
: "${TAG:?set TAG, matching what build-and-push.sh pushed}"
: "${OIDC_CLIENT_ID:?set OIDC_CLIENT_ID}"
: "${DOMAIN:?set DOMAIN, e.g. nix.example.com}"
OIDC_ISSUER="${OIDC_ISSUER:-https://auth.$DOMAIN}"
export PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-https://$DOMAIN}"
NIX_TEMPLATE_BOOT_ENABLED="${NIX_TEMPLATE_BOOT_ENABLED:-true}"
case "$NIX_TEMPLATE_BOOT_ENABLED" in
  true) require_template_boot_config ;;
  false) ;;
  *) echo "NIX_TEMPLATE_BOOT_ENABLED must be true or false" >&2; exit 1 ;;
esac
case "${NIX_MCP_ENABLED:-true}" in
  true) export MCP_PUBLIC_URL="$PUBLIC_ORIGIN/mcp" ;;
  false) export MCP_PUBLIC_URL="" ;;
  *) echo "NIX_MCP_ENABLED must be true or false" >&2; exit 1 ;;
esac
NIX_BOOTSTRAP_IDENTITY="${NIX_BOOTSTRAP_IDENTITY:-false}"
case "$NIX_BOOTSTRAP_IDENTITY" in
  true)
    : "${NIX_BOOTSTRAP_TENANT_NAME:?set NIX_BOOTSTRAP_TENANT_NAME when NIX_BOOTSTRAP_IDENTITY=true}"
    : "${NIX_BOOTSTRAP_OIDC_PROJECT_ID:?set NIX_BOOTSTRAP_OIDC_PROJECT_ID when NIX_BOOTSTRAP_IDENTITY=true}"
    ;;
  false) ;;
  *) echo "NIX_BOOTSTRAP_IDENTITY must be true or false" >&2; exit 1 ;;
esac
SITES_REQUIRE_OPERATOR_APPROVAL="${NIX_SITES_REQUIRE_OPERATOR_APPROVAL:-true}"
case "$SITES_REQUIRE_OPERATOR_APPROVAL" in
  true | false) ;;
  *) echo "NIX_SITES_REQUIRE_OPERATOR_APPROVAL must be true or false" >&2; exit 1 ;;
esac
BACKUP_OFFSITE="${NIX_BACKUP_OFFSITE:-false}"
case "$BACKUP_OFFSITE" in
  true | false) ;;
  *) echo "NIX_BACKUP_OFFSITE must be true or false" >&2; exit 1 ;;
esac
export POD_CIDR="${POD_CIDR:-10.42.0.0/16}"
# Generic clusters (deploy/install.sh --kubernetes) override the k3s and Cloudflare defaults below.
export INGRESS_CLASS="${INGRESS_CLASS:-traefik}"
export STORAGE_CLASS="${STORAGE_CLASS:-local-path}"
export STORAGE_CLASS_RETAIN="${STORAGE_CLASS_RETAIN:-local-path-retain}"
export AUTH_PORT="${AUTH_PORT:-443}"
export AUTH_SECURE="${AUTH_SECURE:-true}"
# external: TLS ends at the ingress. disabled: a plain-http .localhost try-out (tlsMode external
# would still advertise an https issuer).
export ZITADEL_TLS_MODE="${ZITADEL_TLS_MODE:-external}"
export INGRESS_SSL_REDIRECT="${INGRESS_SSL_REDIRECT:-true}"
export TLS_HOSTS="${TLS_HOSTS:-[\"$DOMAIN\", \"*.$DOMAIN\"]}"
# true: only Cloudflare's edge may reach the Ingress and the visitor comes from CF-Connecting-IP.
# false: any ingress controller; the visitor is the X-Forwarded-For it sets.
NIX_INGRESS_CLOUDFLARE_ONLY="${NIX_INGRESS_CLOUDFLARE_ONLY:-true}"
case "$NIX_INGRESS_CLOUDFLARE_ONLY" in
  true) export INGRESS_MIDDLEWARES=nix-cloudflare-only@kubernetescrd CLIENT_IP_HEADER=CF-Connecting-IP ;;
  false) export INGRESS_MIDDLEWARES= CLIENT_IP_HEADER=X-Forwarded-For ;;
  *) echo "NIX_INGRESS_CLOUDFLARE_ONLY must be true or false" >&2; exit 1 ;;
esac
# The web app's public front door (packages/web-foundation/src/lib/web-config.ts): a landing page for anonymous
# visitors at / and a /demo over sample data in the browser. Both off unless the install asks.
export NIX_WEB_LANDING="${NIX_WEB_LANDING:-false}" NIX_WEB_DEMO="${NIX_WEB_DEMO:-false}"
case "$NIX_WEB_LANDING:$NIX_WEB_DEMO" in
  true:true | true:false | false:true | false:false) ;;
  *) echo "NIX_WEB_LANDING and NIX_WEB_DEMO must be true or false" >&2; exit 1 ;;
esac
SITES_FOREIGN_LABEL_SUFFIX="${SITES_FOREIGN_LABEL_SUFFIX--home}"
export REGISTRY TAG OIDC_ISSUER OIDC_CLIENT_ID DOMAIN SITES_REQUIRE_OPERATOR_APPROVAL SITES_FOREIGN_LABEL_SUFFIX BACKUP_OFFSITE

render() { envsubst '${REGISTRY} ${TAG} ${OIDC_ISSUER} ${OIDC_CLIENT_ID} ${DOMAIN} ${SITES_FOREIGN_LABEL_SUFFIX} ${POD_CIDR} ${SITES_REQUIRE_OPERATOR_APPROVAL} ${BACKUP_OFFSITE} ${RABBITMQ_SECRET_VERSION} ${OBJECT_STORE_SECRET_VERSION} ${SITES_SECRET_VERSION} ${TEMPLATE_BOOT_WORKSPACE_ID} ${TEMPLATE_BOOT_OIDC_AUDIENCE} ${TEMPLATE_BOOT_OIDC_SCOPE} ${TEMPLATE_BOOT_PVC} ${TEMPLATE_BOOT_SERVICE_KEY_SECRET} ${INGRESS_CLASS} ${INGRESS_MIDDLEWARES} ${STORAGE_CLASS} ${STORAGE_CLASS_RETAIN} ${AUTH_PORT} ${AUTH_SECURE} ${ZITADEL_TLS_MODE} ${INGRESS_SSL_REDIRECT} ${PUBLIC_ORIGIN} ${MCP_PUBLIC_URL} ${TLS_HOSTS} ${CLIENT_IP_HEADER} ${NIX_WEB_LANDING} ${NIX_WEB_DEMO}' < "$1"; }

if ! kubectl -n nix get secret nix-db >/dev/null 2>&1; then
  echo "secret nix-db not found in namespace nix - run deploy/k8s/create-secrets.sh first" >&2
  exit 1
fi
if ! kubectl -n nix get secret nix-auth >/dev/null 2>&1; then
  echo "secret nix-auth not found in namespace nix - run deploy/k8s/create-secrets.sh first" >&2
  exit 1
fi
if ! kubectl -n nix get secret nix-rabbitmq >/dev/null 2>&1; then
  echo "secret nix-rabbitmq not found in namespace nix - run deploy/k8s/create-secrets.sh first" >&2
  exit 1
fi
if ! kubectl -n nix get secret nix-object-store >/dev/null 2>&1; then
  echo "secret nix-object-store not found in namespace nix - run deploy/k8s/create-secrets.sh first" >&2
  exit 1
fi
for required_secret in nix-sites nix-tls nix-zitadel; do
  if ! kubectl -n nix get secret "$required_secret" >/dev/null 2>&1; then
    echo "secret $required_secret not found in namespace nix - run deploy/k8s/create-secrets.sh --${required_secret#nix-}-only" >&2
    exit 1
  fi
done
for rabbitmq_key in api-password import-password export-password plugin-password calendar-password notify-password sites-password worker-password api-url import-url export-url plugin-url calendar-url notify-url sites-url worker-url; do
  rabbitmq_value="$(kubectl -n nix get secret nix-rabbitmq -o "jsonpath={.data['$rabbitmq_key']}")"
  if [ -z "$rabbitmq_value" ]; then
    echo "secret nix-rabbitmq is missing $rabbitmq_key - run deploy/k8s/create-secrets.sh --rabbitmq-only" >&2
    exit 1
  fi
done
for object_store_key in endpoint public-origin region bucket access-key secret-key; do
  object_store_value="$(kubectl -n nix get secret nix-object-store -o "jsonpath={.data['$object_store_key']}")"
  if [ -z "$object_store_value" ]; then
    echo "secret nix-object-store is missing $object_store_key - run deploy/k8s/create-secrets.sh --object-store-only" >&2
    exit 1
  fi
done
for sites_key in bucket read-access-key read-secret-key; do
  sites_value="$(kubectl -n nix get secret nix-sites -o "jsonpath={.data['$sites_key']}")"
  if [ -z "$sites_value" ]; then
    echo "secret nix-sites is missing $sites_key - run deploy/k8s/create-secrets.sh --sites-only" >&2
    exit 1
  fi
done
if [ "$BACKUP_OFFSITE" = true ]; then
  for offsite_key in RESTIC_REPOSITORY RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION; do
    offsite_value="$(kubectl -n nix get secret nix-backup-offsite -o "jsonpath={.data['$offsite_key']}" 2>/dev/null || true)"
    if [ -z "$offsite_value" ]; then
      echo "NIX_BACKUP_OFFSITE=true but secret nix-backup-offsite is missing or lacks $offsite_key - run deploy/k8s/create-secrets.sh --backup-offsite-only" >&2
      exit 1
    fi
  done
fi
RABBITMQ_SECRET_VERSION="$(kubectl -n nix get secret nix-rabbitmq -o jsonpath='{.metadata.resourceVersion}')"
if [ -z "$RABBITMQ_SECRET_VERSION" ]; then
  echo "secret nix-rabbitmq has no resource version" >&2
  exit 1
fi
OBJECT_STORE_SECRET_VERSION="$(kubectl -n nix get secret nix-object-store -o jsonpath='{.metadata.resourceVersion}')"
if [ -z "$OBJECT_STORE_SECRET_VERSION" ]; then
  echo "secret nix-object-store has no resource version" >&2
  exit 1
fi
SITES_SECRET_VERSION="$(kubectl -n nix get secret nix-sites -o jsonpath='{.metadata.resourceVersion}')"
if [ -z "$SITES_SECRET_VERSION" ]; then
  echo "secret nix-sites has no resource version" >&2
  exit 1
fi
export RABBITMQ_SECRET_VERSION OBJECT_STORE_SECRET_VERSION SITES_SECRET_VERSION

# Retire workloads explicitly; leave all PersistentVolumeClaims intact.
kubectl -n nix delete deployment/nix-indexer --ignore-not-found
# The per-role Go workers became one nix-worker Deployment (deploy/k8s/worker.yaml).
kubectl -n nix delete deployment/nix-import-worker deployment/nix-export-worker deployment/nix-plugin-worker \
  deployment/nix-calendar-worker deployment/nix-notify-worker \
  service/nix-import-worker service/nix-export-worker service/nix-plugin-worker \
  service/nix-calendar-worker service/nix-notify-worker \
  networkpolicy/go-workers-egress networkpolicy/plugin-worker-egress \
  networkpolicy/calendar-worker-egress networkpolicy/notify-worker-egress --ignore-not-found
retired_search=$(kubectl -n nix get statefulset nix-opensearch --ignore-not-found -o name)
if [ -n "$retired_search" ]; then
  kubectl -n nix patch statefulset nix-opensearch --type=merge \
    -p '{"spec":{"persistentVolumeClaimRetentionPolicy":{"whenDeleted":"Retain","whenScaled":"Retain"}}}'
fi
kubectl -n nix delete statefulset/nix-opensearch --ignore-not-found
kubectl -n nix delete service/nix-indexer service/nix-opensearch networkpolicy/opensearch-ingress --ignore-not-found

# Retire the log stack without deleting Loki or Grafana storage.
retired_loki=$(kubectl -n nix get statefulset nix-loki --ignore-not-found -o name)
if [ -n "$retired_loki" ]; then
  kubectl -n nix patch statefulset nix-loki --type=merge \
    -p '{"spec":{"persistentVolumeClaimRetentionPolicy":{"whenDeleted":"Retain","whenScaled":"Retain"}}}'
fi
kubectl -n nix delete deployment/nix-alloy deployment/nix-grafana --ignore-not-found
kubectl -n nix delete statefulset/nix-loki --ignore-not-found
kubectl -n nix delete service/nix-loki service/nix-grafana --ignore-not-found
kubectl -n nix delete serviceaccount/nix-alloy role/nix-alloy rolebinding/nix-alloy \
  configmap/nix-loki-config configmap/nix-alloy-config configmap/nix-grafana-provisioning \
  secret/nix-observability --ignore-not-found

echo "== Postgres =="
render deploy/k8s/postgres.yaml | kubectl apply -f -
kubectl -n nix rollout status statefulset/postgres --timeout=180s

echo "== Object store =="
render deploy/k8s/objectstore.yaml | kubectl apply -f -
kubectl -n nix rollout status statefulset/nix-versitygw --timeout=180s
kubectl -n nix delete "job/nix-storage-init-$TAG" --ignore-not-found
render deploy/k8s/job-storage-init.yaml | kubectl apply -f -
kubectl -n nix wait --for=condition=complete "job/nix-storage-init-$TAG" --timeout=180s

echo "== RabbitMQ =="
kubectl -n nix create configmap nix-rabbitmq-config \
  --from-file=rabbitmq.conf=deploy/rabbitmq/rabbitmq.conf \
  --from-file=definitions.json=deploy/rabbitmq/definitions.json \
  --from-file=start.sh=deploy/rabbitmq/start.sh \
  --dry-run=client -o yaml | kubectl apply -f -
render deploy/k8s/rabbitmq.yaml | kubectl apply -f -
# Apply startup topology and account retirement even when the secret version is unchanged.
kubectl -n nix rollout restart statefulset/nix-rabbitmq
kubectl -n nix rollout status statefulset/nix-rabbitmq --timeout=180s

echo "== Seed =="
kubectl apply -f deploy/k8s/job-seed.yaml
kubectl -n nix wait --for=condition=complete job/nix-db-seed --timeout=180s

echo "== Identity provider (database now; rollout waits with the workloads) =="
kubectl -n nix delete "job/nix-zitadel-db-$TAG" --ignore-not-found
render deploy/k8s/zitadel.yaml | kubectl apply -f -
kubectl -n nix wait --for=condition=complete "job/nix-zitadel-db-$TAG" --timeout=180s

echo "== Migrations (tag $TAG) =="
render deploy/k8s/job-migrate.yaml | kubectl apply -f -
kubectl -n nix wait --for=condition=complete "job/nix-migrate-$TAG" --timeout=300s
kubectl -n nix wait --for=condition=complete "job/nix-migrate-documents-$TAG" --timeout=300s

if [ "$NIX_BOOTSTRAP_IDENTITY" = true ]; then
  echo "== Identity bootstrap =="
  kubectl -n nix exec -i statefulset/postgres -c postgres -- \
    psql -X -v ON_ERROR_STOP=1 -U postgres -d nix \
    -v tenant_name="$NIX_BOOTSTRAP_TENANT_NAME" -v tenant_id="${NIX_BOOTSTRAP_TENANT_ID:-}" \
    -v oidc_issuer="$OIDC_ISSUER" -v oidc_client_id="$OIDC_CLIENT_ID" \
    -v oidc_project_id="$NIX_BOOTSTRAP_OIDC_PROJECT_ID" \
    -f - < deploy/seed/bootstrap_identity.sql
fi

echo "== Template presets (tag $TAG) =="
kubectl -n nix delete "job/nix-template-presets-$TAG" --ignore-not-found
kubectl -n nix create configmap nix-template-presets \
  --from-file=seed_template_presets.sql=deploy/seed/seed_template_presets.sql \
  --dry-run=client -o yaml | kubectl apply -f -
render deploy/k8s/job-template-presets.yaml | kubectl apply -f -
if ! kubectl -n nix wait --for=condition=complete "job/nix-template-presets-$TAG" --timeout=180s; then
  kubectl -n nix describe "job/nix-template-presets-$TAG" >&2 || true
  kubectl -n nix logs -l job-name="nix-template-presets-$TAG" --tail=200 >&2 || true
  exit 1
fi

echo "== Caddyfile =="
kubectl -n nix create configmap nix-caddy --from-file=Caddyfile=deploy/k8s/Caddyfile \
  --dry-run=client -o yaml | kubectl apply -f -

echo "== Workloads =="
render deploy/k8s/api.yaml | kubectl apply -f -
render deploy/k8s/collab.yaml | kubectl apply -f -
render deploy/k8s/worker.yaml | kubectl apply -f -
render deploy/k8s/web.yaml | kubectl apply -f -
render deploy/k8s/sites.yaml | kubectl apply -f -
if [ -n "$MCP_PUBLIC_URL" ]; then
  render deploy/k8s/mcp.yaml | kubectl apply -f -
else
  kubectl -n nix delete ingress/nix-mcp service/nix-mcp deployment/nix-mcp --ignore-not-found
fi
# The broker restarted above and the Go workers' consumers do not reconnect; an unchanged template
# would keep the cut-off pods, so restart them the way Compose restarts its writers.
kubectl -n nix rollout restart deployment/nix-worker deployment/nix-sites-worker

kubectl -n nix rollout status deployment/nix-api --timeout=180s
kubectl -n nix rollout status deployment/nix-collab --timeout=180s
kubectl -n nix rollout status deployment/nix-web --timeout=180s
kubectl -n nix rollout status deployment/nix-sites-worker --timeout=180s
kubectl -n nix rollout status deployment/nix-sites-serve --timeout=180s
# A first install runs Zitadel's instance setup before it listens; that can take several minutes.
kubectl -n nix rollout status deployment/nix-zitadel --timeout=900s

# The worker's readiness probes the object store's public origin, which is this Ingress, and managed
# templates upload through it too: on a first install nothing answers there until it is applied.
echo "== Ingress =="
if [ "$NIX_INGRESS_CLOUDFLARE_ONLY" = true ]; then kubectl apply -f deploy/k8s/cloudflare-only.yaml; fi
render deploy/k8s/ingress.yaml | kubectl apply -f -
kubectl -n nix rollout status deployment/nix-worker --timeout=180s
render deploy/k8s/backup.yaml | kubectl apply -f -

if [ "$NIX_TEMPLATE_BOOT_ENABLED" = true ]; then
  kubectl -n nix get "persistentvolumeclaim/$TEMPLATE_BOOT_PVC" >/dev/null
  kubectl -n nix get "secret/$TEMPLATE_BOOT_SERVICE_KEY_SECRET" >/dev/null

  kubectl -n nix create configmap nix-template-boot-script \
    --from-file=sync-managed-templates.mjs=deploy/template-sync/sync-managed-templates.mjs \
    --dry-run=client -o yaml | kubectl apply -f -

  echo "== Managed templates (tag $TAG) =="
  kubectl -n nix delete "job/nix-template-boot-$TAG" --ignore-not-found
  render deploy/k8s/job-template-sync.yaml | kubectl apply -f -
  if ! kubectl -n nix wait --for=condition=complete "job/nix-template-boot-$TAG" --timeout=300s; then
    kubectl -n nix describe "job/nix-template-boot-$TAG" >&2 || true
    kubectl -n nix get pods -l job-name="nix-template-boot-$TAG" -o wide >&2 || true
    kubectl -n nix logs -l job-name="nix-template-boot-$TAG" --all-containers --tail=200 >&2 || true
    exit 1
  fi
else
  echo "== Managed templates skipped (NIX_TEMPLATE_BOOT_ENABLED=false) =="
fi


echo "Deployed tag $TAG. Next: DOMAIN=$DOMAIN deploy/k8s/verify.sh"
