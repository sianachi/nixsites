#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

fake_bin="$test_root/bin"
mkdir -p "$fake_bin"
export KUBECTL_LOG="$test_root/kubectl.log"
export RENDERED_PRESET_JOB="$test_root/template-presets.yaml"
export RENDERED_API="$test_root/api.yaml"
export RENDERED_TEMPLATE_SYNC="$test_root/template-sync.yaml"
export RENDERED_WORKERS="$test_root/workers.yaml"
export RENDERED_WEB="$test_root/web.yaml"
export RENDERED_SITES="$test_root/sites.yaml"
export RENDERED_INGRESS="$test_root/ingress.yaml"
export RENDERED_ALL="$test_root/all.yaml"
export RENDERED_ZITADEL="$test_root/zitadel.yaml"
export RENDERED_BACKUP="$test_root/backup.yaml"
export OFFSITE_ENV_COPY="$test_root/offsite.env"
export EXEC_STDIN="$test_root/exec-stdin.sql"

cat > "$fake_bin/git" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = "rev-parse" ] && [ "\${2:-}" = "--show-toplevel" ]; then
  printf '%s\n' '$repo_root'
  exit 0
fi
exit 2
EOF

cat > "$fake_bin/kubectl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ " $* " == *" get statefulset nix-opensearch "* ]]; then
  printf 'get:%s\n' "$*" >> "$KUBECTL_LOG"
  if [ "${FAIL_RETIRED_SEARCH_LOOKUP:-}" = 1 ]; then exit 1; fi
  if [ "${MISSING_RETIRED_SEARCH:-}" != 1 ]; then printf 'statefulset.apps/nix-opensearch'; fi
  exit 0
fi

if [[ " $* " == *" get statefulset nix-loki "* ]]; then
  printf 'get:%s\n' "$*" >> "$KUBECTL_LOG"
  if [ "${FAIL_RETIRED_LOKI_LOOKUP:-}" = 1 ]; then exit 1; fi
  if [ "${MISSING_RETIRED_LOKI:-}" != 1 ]; then printf 'statefulset.apps/nix-loki'; fi
  exit 0
fi

if [[ " $* " == *" patch statefulset nix-loki "* ]]; then
  printf 'kubectl:%s\n' "$*" >> "$KUBECTL_LOG"
  if [ "${FAIL_RETIRED_LOKI_PATCH:-}" = 1 ]; then exit 1; fi
  exit 0
fi

if [[ " $* " == *" get secret nix-object-store "* && " $* " == *"metadata.resourceVersion"* ]]; then
  printf '67890'
  exit 0
fi

if [[ " $* " == *" get secret nix-sites "* && " $* " == *"metadata.resourceVersion"* ]]; then
  printf '24680'
  exit 0
fi

if [[ " $* " == *" get secret nix-sites "* && " $* " == *" jsonpath="* ]]; then
  if [ "${MISSING_SITES_KEY:-}" = 1 ] && [[ " $* " == *"read-access-key"* ]]; then exit 0; fi
  printf 'dGVzdA=='
  exit 0
fi

if [[ " $* " == *" get secret nix-backup-offsite "* && " $* " == *" jsonpath="* ]]; then
  if [ "${OFFSITE_SECRET:-}" != 1 ]; then echo 'secrets "nix-backup-offsite" not found' >&2; exit 1; fi
  printf 'dGVzdA=='
  exit 0
fi

if [[ " $* " == *" create secret generic nix-backup-offsite "* ]]; then
  printf 'kubectl:%s\n' "$*" >> "$KUBECTL_LOG"
  for argument in "$@"; do
    case "$argument" in --from-env-file=*) cp "${argument#--from-env-file=}" "$OFFSITE_ENV_COPY" ;; esac
  done
  exit 0
fi

if [[ " $* " == *" get secret nix-object-store "* && " $* " == *" jsonpath="* ]]; then
  printf 'dGVzdA=='
  exit 0
fi

if [[ " $* " == *" apply -f - "* ]]; then
  payload="$(</dev/stdin)"
  printf '%s\n---\n' "$payload" >> "$RENDERED_ALL"
  names="$(printf '%s\n' "$payload" | sed -nE \
    -e 's/^metadata: \{ name: ([^,}]+).*$/\1/p' \
    -e 's/^  name: ([^ ]+)$/\1/p' | paste -sd, -)"
  printf 'apply-stdin:%s\n' "$names" >> "$KUBECTL_LOG"
  if [[ "$payload" == *"nix-template-presets-"* ]]; then
    printf '%s\n' "$payload" > "$RENDERED_PRESET_JOB"
  fi
  if [[ "$payload" == *"name: nix-api-data-protection"* ]]; then
    printf '%s\n' "$payload" > "$RENDERED_API"
  fi
  if [[ "$payload" == *"name: nix-template-boot-render-order"* ]]; then
    printf '%s\n' "$payload" > "$RENDERED_TEMPLATE_SYNC"
  fi
  if [[ "$payload" == *"kind: Deployment"* && "$payload" == *"name: nix-node, namespace"* ]]; then
    printf '%s\n' "$payload" > "$RENDERED_WORKERS"
  fi
  if [[ "$payload" == *"name: nix-sites-serve"* && "$payload" == *"kind: Deployment"* ]]; then
    printf '%s\n' "$payload" > "$RENDERED_SITES"
  fi
  if [[ "$payload" == *"name: nix-zitadel-env"* ]]; then
    printf '%s\n' "$payload" > "$RENDERED_ZITADEL"
  fi
  if [[ "$payload" == *"name: nix-backup, namespace"* && "$payload" == *"kind: CronJob"* ]]; then
    printf '%s\n' "$payload" > "$RENDERED_BACKUP"
  fi
  if [[ "$payload" == *"kind: Ingress"* ]]; then
    printf '%s\n' "$payload" > "$RENDERED_INGRESS"
  fi
  if [[ "$payload" == *"name: nix-web"* && "$payload" == *"containerPort: 8090"* ]]; then
    printf '%s\n' "$payload" > "$RENDERED_WEB"
  fi
  exit 0
fi

if [[ " $* " == *" exec "* ]]; then
  printf 'exec:%s\n' "$*" >> "$KUBECTL_LOG"
  cat > "$EXEC_STDIN"
  exit 0
fi

if [[ " $* " == *" create configmap "* ]]; then
  name=""
  previous=""
  for argument in "$@"; do
    if [ "$previous" = "configmap" ]; then
      name="$argument"
      break
    fi
    previous="$argument"
  done
  printf 'create-configmap:%s\n' "$name" >> "$KUBECTL_LOG"
  printf 'apiVersion: v1\nkind: ConfigMap\nmetadata: { name: %s, namespace: nix }\n' "$name"
  exit 0
fi

case " $* " in
  *" apply -f "*) printf 'apply-file:%s\n' "${!#}" >> "$KUBECTL_LOG" ;;
  *" wait "*) printf 'wait:%s\n' "$*" >> "$KUBECTL_LOG" ;;
  *" rollout status "*) printf 'rollout:%s\n' "$*" >> "$KUBECTL_LOG" ;;
  *" delete "*) printf 'delete:%s\n' "$*" >> "$KUBECTL_LOG" ;;
  *" get "*) printf 'get:%s\n' "$*" >> "$KUBECTL_LOG" ;;
  *) printf 'kubectl:%s\n' "$*" >> "$KUBECTL_LOG" ;;
esac
EOF

chmod +x "$fake_bin/git" "$fake_bin/kubectl"

run_deploy() {
PATH="$fake_bin:$PATH" \
REGISTRY=registry.example.test \
TAG=render-order \
OIDC_ISSUER="${OIDC_ISSUER-https://identity.example.test}" \
OIDC_CLIENT_ID=web-client \
DOMAIN=nix.example.test \
TEMPLATE_BOOT_WORKSPACE_ID=11111111-1111-4111-8111-111111111111 \
TEMPLATE_BOOT_OIDC_AUDIENCE=project-id \
TEMPLATE_BOOT_PVC=template-files \
TEMPLATE_BOOT_SERVICE_KEY_SECRET=template-service-key \
NIX_DEPLOY_TARGET=kubernetes bash "$repo_root/deploy/k8s/deploy.sh" >/dev/null

}
# A first install has no template workspace, Zitadel project or service key yet.
run_first_install() {
PATH="$fake_bin:$PATH" \
REGISTRY=registry.example.test \
TAG=render-order \
OIDC_CLIENT_ID=web-client \
DOMAIN=nix.example.test \
NIX_TEMPLATE_BOOT_ENABLED=false \
NIX_DEPLOY_TARGET=kubernetes bash "$repo_root/deploy/k8s/deploy.sh" >/dev/null
}
run_deploy

line_of() {
  local pattern="$1"
  local line
  line="$(grep -nF "$pattern" "$KUBECTL_LOG" | head -n 1 | cut -d: -f1)"
  if [ -z "$line" ]; then
    echo "deployment did not record: $pattern" >&2
    exit 1
  fi
  printf '%s\n' "$line"
}

assert_before() {
  local earlier="$1"
  local later="$2"
  if [ "$(line_of "$earlier")" -ge "$(line_of "$later")" ]; then
    echo "deployment order is wrong: '$earlier' must precede '$later'" >&2
    exit 1
  fi
}

assert_before \
  "wait:-n nix wait --for=condition=complete job/nix-migrate-documents-render-order" \
  "create-configmap:nix-template-presets"
assert_before \
  "create-configmap:nix-template-presets" \
  "apply-stdin:nix-template-presets-render-order"
assert_before \
  "apply-stdin:nix-template-presets-render-order" \
  "wait:-n nix wait --for=condition=complete job/nix-template-presets-render-order"
assert_before \
  "delete:-n nix delete statefulset/nix-rabbitmq service/nix-rabbitmq networkpolicy/rabbitmq-ingress configmap/nix-rabbitmq-config secret/nix-rabbitmq --ignore-not-found" \
  "apply-stdin:nix-api-data-protection,nix-api,nix-api"
assert_before \
  "wait:-n nix wait --for=condition=complete job/nix-template-presets-render-order" \
  "apply-stdin:nix-api-data-protection,nix-api,nix-api"
assert_before \
  "apply-stdin:nix-api-data-protection,nix-api,nix-api" \
  "rollout:-n nix rollout status deployment/nix-api"

grep -Fq 'name: nix-template-presets-render-order' "$RENDERED_PRESET_JOB"
grep -Fq 'runAsGroup: 999' "$RENDERED_PRESET_JOB"
grep -Fq 'fsGroup: 999' "$RENDERED_PRESET_JOB"
grep -Fq 'automountServiceAccountToken: false' "$RENDERED_PRESET_JOB"
grep -Fq 'configMap: { name: nix-template-presets }' "$RENDERED_PRESET_JOB"
grep -Fq 'name: PGUSER, value: nix_migrator' "$RENDERED_PRESET_JOB"
grep -Fq 'delete:-n nix delete statefulset/nix-rabbitmq service/nix-rabbitmq networkpolicy/rabbitmq-ingress configmap/nix-rabbitmq-config secret/nix-rabbitmq --ignore-not-found' "$KUBECTL_LOG"
# The broker's volume claim is kept.
test "$(grep -Fc 'nix.io/object-store-secret-version: "67890"' "$RENDERED_API")" -eq 1
grep -Fq 'name: Nix__ObjectStorage__PublicOrigin' "$RENDERED_API"
grep -Fq 'key: public-origin' "$RENDERED_API"
# Core refuses a plain-HTTP endpoint off loopback, so it never gets the in-cluster one.
grep -A1 -F 'name: Nix__ObjectStorage__Endpoint' "$RENDERED_API" | grep -Fq 'key: public-origin }'
if grep -Eq 'nix-media|/media:' "$KUBECTL_LOG" "$RENDERED_TEMPLATE_SYNC"; then
  echo 'Deployment still references the retired Media service.' >&2
  exit 1
fi
grep -Fq 'image: registry.example.test/collab:render-order' "$RENDERED_TEMPLATE_SYNC"
grep -Fq 'name: NIX_TEMPLATE_BOOT_CORE_URL, value: http://nix-api:8080' "$RENDERED_TEMPLATE_SYNC"
if grep -Fq 'NIX_TEMPLATE_BOOT_MEDIA_URL' "$RENDERED_TEMPLATE_SYNC"; then
  echo 'Template sync still uses the retired Media URL.' >&2
  exit 1
fi
# The node Deployment hosts collab, the companion and the sites worker: no broker or worker-role configuration.
if grep -Eq 'NIX_RABBITMQ_URL|NIX_WORKER_ROLES|NIX_WORKER_OBJECT_ORIGINS' "$RENDERED_WORKERS"; then
  echo 'The companion host still carries worker-role configuration.' >&2
  exit 1
fi
grep -Fq 'name: NIX_COMPANION_DATA_DIR' "$RENDERED_WORKERS"
grep -Fq 'delete:-n nix delete deployment/nix-import-worker' "$KUBECTL_LOG"
grep -Fq 'rollout:-n nix rollout status deployment/nix-node ' "$KUBECTL_LOG"
if grep -Eq 'rollout:.*nix-(import|export|plugin|calendar|notify)-worker' "$KUBECTL_LOG"; then
  echo 'Deployment still waits for retired per-role workers.' >&2
  exit 1
fi
grep -Fq 'name: NIX_OBJECT_STORE_PUBLIC_ORIGIN' "$RENDERED_WEB"
grep -Fq 'key: public-origin' "$RENDERED_WEB"
test "$(grep -Fc 'nix.io/object-store-secret-version: "67890"' "$RENDERED_WEB")" -eq 1

# Sites (ADR-0063): own image, broker identity, read-only bucket key, host-routed ingress.
grep -Fq 'image: registry.example.test/sites:render-order' "$RENDERED_SITES"
if grep -Fq 'NIX_SITES_RABBITMQ_URL' "$RENDERED_SITES"; then
  echo 'The sites worker still reads a broker URL.' >&2
  exit 1
fi
grep -Fq 'key: read-access-key' "$RENDERED_SITES"
grep -Fq 'value: "nix.example.test"' "$RENDERED_SITES"
grep -Fq 'nix.io/sites-secret-version: "24680"' "$RENDERED_SITES"
grep -Fq 'command: ["node", "--experimental-strip-types", "src/serve/index.ts"]' "$RENDERED_SITES"
test "$(grep -Fc 'readOnlyRootFilesystem: true' "$RENDERED_SITES")" -eq 1
test "$(grep -Fc 'httpHeaders: [{ name: Host, value: localhost }]' "$RENDERED_SITES")" -eq 2
serve_section="$(sed -n '/name: nix-sites-serve, namespace/,$p' "$RENDERED_SITES")"
if printf '%s\n' "$serve_section" | grep -Eq 'nix-internal|nix-connections|key: access-key|key: secret-key'; then
  echo 'The anonymous sites server received a Core, database, broker or write credential.' >&2
  exit 1
fi
grep -Fq 'name: Nix__Sites__Domain' "$RENDERED_API"
grep -Fq 'name: Nix__Sites__SharedAppDomain' "$RENDERED_API"
grep -A1 -F 'name: Nix__Sites__ForeignLabelSuffixes__0' "$RENDERED_API" | grep -Fq 'value: "-home"'
grep -Fq 'key: reserved-owner-nix, optional: true' "$RENDERED_API"
grep -Fq 'hosts: ["nix.example.test", "*.nix.example.test"]' "$RENDERED_INGRESS"
grep -Fq 'host: "*.nix.example.test"' "$RENDERED_INGRESS"
grep -Fq 'service: { name: nix-sites-serve, port: { number: 8400 } }' "$RENDERED_INGRESS"
# Custom hostnames: one host-less rule at the lowest priority, so it never outranks a named host.
custom_ingress="$(awk '/name: nix-sites-custom-hosts/,0' "$RENDERED_INGRESS")"
grep -Fq 'traefik.ingress.kubernetes.io/router.priority: "1"' <<<"$custom_ingress"
grep -Fq 'nix-cloudflare-only@kubernetescrd' <<<"$custom_ingress"
grep -Fq 'service: { name: nix-sites-serve, port: { number: 8400 } }' <<<"$custom_ingress"
if grep -Eq '^ *- host:|hosts:' <<<"$custom_ingress"; then
  echo 'The custom-hostname Ingress must not name a host.' >&2
  exit 1
fi
assert_before "apply-stdin:nix-sites-serve,nix-sites-serve,sites-serve-egress" "rollout:-n nix rollout status deployment/nix-sites-serve"
# Every first-party image the manifests pull is one CI publishes (ci-images.yml plan lines).
published="$(sed -nE 's/^ *plan ([a-z-]+) deploy\/docker\/.*/\1/p' "$repo_root/.github/workflows/ci-images.yml" | sort -u)"
pulled="$(sed -nE 's/^ *image: registry\.example\.test\/([^:]+):render-order$/\1/p' "$RENDERED_ALL" | sort -u)"
test -n "$published" && test -n "$pulled"
unpublished="$(comm -23 <(printf '%s\n' "$pulled") <(printf '%s\n' "$published"))"
if [ -n "$unpublished" ]; then
  echo "Manifests pull images CI does not publish: $unpublished" >&2
  exit 1
fi
if grep -E '^ *image: registry\.example\.test/' "$RENDERED_ALL" | grep -vqE ':render-order$'; then
  echo 'A first-party image is not tagged with the release TAG.' >&2
  exit 1
fi
# Client address: Caddy trusts the pod network for CF-Connecting-IP; the ingress admits Cloudflare only.
grep -Fq 'name: NIX_TRUSTED_PROXY_CIDR' "$RENDERED_WEB"
grep -Fq 'value: "10.42.0.0/16"' "$RENDERED_WEB"
grep -Fq 'router.middlewares: "nix-cloudflare-only@kubernetescrd"' "$RENDERED_INGRESS"
test "$(grep -A1 -xF 'apply-file:deploy/k8s/cloudflare-only.yaml' "$KUBECTL_LOG" | tail -n 1)" = 'apply-stdin:nix,nix-sites,nix-sites-custom-hosts'
grep -Fq 'client_ip_headers {$NIX_CLIENT_IP_HEADER}' "$repo_root/deploy/k8s/Caddyfile"
# In-cluster object store: buckets and the sites read account exist before anything uses them.
assert_before "apply-stdin:nix-versitygw,nix-versitygw,versitygw-ingress" "wait:-n nix wait --for=condition=complete job/nix-storage-init-render-order"
assert_before "wait:-n nix wait --for=condition=complete job/nix-storage-init-render-order" "apply-stdin:nix-api-data-protection,nix-api,nix-api"
grep -Fq 'handle /{$NIX_OBJECT_STORE_BUCKET}/*' "$repo_root/deploy/k8s/Caddyfile"
grep -Fq 'name: NIX_OBJECT_STORE_BUCKET' "$RENDERED_WEB"
# Site builds upload through the app origin, so the sites bucket needs the same route.
grep -Fq 'handle /{$NIX_SITES_BUCKET}/*' "$repo_root/deploy/k8s/Caddyfile"
grep -A1 -F 'name: NIX_SITES_BUCKET' "$RENDERED_WEB" | grep -Fq 'name: nix-sites, key: bucket'
# Zitadel: own database created before it starts, invite-only, served at auth.$DOMAIN.
assert_before "wait:-n nix wait --for=condition=complete job/nix-db-seed" "wait:-n nix wait --for=condition=complete job/nix-zitadel-db-render-order"
grep -Fq 'ZITADEL_EXTERNALDOMAIN: "auth.nix.example.test"' "$RENDERED_ZITADEL"
grep -Fq 'ZITADEL_DEFAULTINSTANCE_LOGINPOLICY_ALLOWREGISTER: "false"' "$RENDERED_ZITADEL"
grep -Fq 'key: masterkey' "$RENDERED_ZITADEL"
if grep -Fq 'ZITADEL_DATABASE_POSTGRES_ADMIN' "$RENDERED_ZITADEL"; then
  echo 'Zitadel received database administrator credentials.' >&2
  exit 1
fi
grep -Fq 'host: "auth.nix.example.test"' "$RENDERED_INGRESS"
grep -Fq 'service: { name: nix-zitadel, port: { number: 8080 } }' "$RENDERED_INGRESS"
grep -Fq 'rollout:-n nix rollout status deployment/nix-zitadel --timeout=900s' "$KUBECTL_LOG"
grep -Fq 'apply-stdin:nix-backup,nix-backup' "$KUBECTL_LOG"
# Third-party images are pinned to a version.
if grep -E '^ *image: ' "$RENDERED_ALL" | grep -vE ':[A-Za-z0-9._-]+$|registry\.example\.test/' | grep -q .; then
  echo 'An image is not pinned to a tag.' >&2
  exit 1
fi
: > "$KUBECTL_LOG"
if MISSING_SITES_KEY=1 run_deploy 2>/dev/null; then
  echo 'Deployment accepted a sites secret without the read key.' >&2
  exit 1
fi
if grep -Fq 'apply-stdin:' "$KUBECTL_LOG"; then
  echo 'Deployment applied workloads before validating the sites secret.' >&2
  exit 1
fi
run_deploy
# Without OIDC_ISSUER, Core trusts the bundled Zitadel.
OIDC_ISSUER= run_deploy
grep -Fq 'value: "https://auth.nix.example.test"' "$RENDERED_API"

if grep -Eq 'nix-indexer|OpenSearch|opensearch|index-password|index-url' "$RENDERED_WORKERS" "$RENDERED_API"; then
  echo 'Deployment still renders retired search components.' >&2
  exit 1
fi
assert_before "kubectl:-n nix patch statefulset nix-opensearch" "delete:-n nix delete statefulset/nix-opensearch"
grep -Fq '"whenDeleted":"Retain","whenScaled":"Retain"' "$KUBECTL_LOG"
assert_before "delete:-n nix delete deployment/nix-indexer" "delete:-n nix delete statefulset/nix-rabbitmq service/nix-rabbitmq networkpolicy/rabbitmq-ingress configmap/nix-rabbitmq-config secret/nix-rabbitmq --ignore-not-found"
if grep -Eq 'delete.*(persistentvolume|pvc)' "$KUBECTL_LOG"; then
  echo 'Deployment attempted to delete retained storage.' >&2
  exit 1
fi
assert_before "kubectl:-n nix patch statefulset nix-loki" "delete:-n nix delete statefulset/nix-loki"
grep -Fq 'kubectl:-n nix patch statefulset nix-loki --type=merge -p {"spec":{"persistentVolumeClaimRetentionPolicy":{"whenDeleted":"Retain","whenScaled":"Retain"}}}' "$KUBECTL_LOG"
assert_before "delete:-n nix delete deployment/nix-alloy deployment/nix-grafana" "delete:-n nix delete statefulset/nix-loki"
assert_before "delete:-n nix delete statefulset/nix-loki" "delete:-n nix delete statefulset/nix-rabbitmq service/nix-rabbitmq networkpolicy/rabbitmq-ingress configmap/nix-rabbitmq-config secret/nix-rabbitmq --ignore-not-found"
grep -Fq 'delete:-n nix delete service/nix-loki service/nix-grafana --ignore-not-found' "$KUBECTL_LOG"
grep -Fq 'serviceaccount/nix-alloy role/nix-alloy rolebinding/nix-alloy configmap/nix-loki-config configmap/nix-alloy-config configmap/nix-grafana-provisioning secret/nix-observability --ignore-not-found' "$KUBECTL_LOG"
if grep -Eq '(create-configmap|apply-file|apply-stdin|rollout):.*(loki|alloy|grafana|observability)' "$KUBECTL_LOG"; then
  echo 'Deployment still starts retired observability components.' >&2
  exit 1
fi
if grep -Eq 'rabbitmq.*(pvc|persistentvolume)' "$KUBECTL_LOG"; then
  echo 'Deployment touched the RabbitMQ volume claim.' >&2
  exit 1
fi
: > "$KUBECTL_LOG"
if FAIL_RETIRED_SEARCH_LOOKUP=1 run_deploy; then
  echo 'Deployment ignored a failed retained-storage lookup.' >&2
  exit 1
fi
if grep -Eq 'delete:.*nix-opensearch' "$KUBECTL_LOG"; then
  echo 'Deployment deleted search before ensuring its storage is retained.' >&2
  exit 1
fi
: > "$KUBECTL_LOG"
MISSING_RETIRED_SEARCH=1 run_deploy
if grep -Fq 'patch statefulset nix-opensearch' "$KUBECTL_LOG"; then
  echo 'Deployment patched a missing retired search set.' >&2
  exit 1
fi
: > "$KUBECTL_LOG"
MISSING_RETIRED_LOKI=1 run_deploy
if grep -Fq 'patch statefulset nix-loki' "$KUBECTL_LOG"; then
  echo 'Deployment patched a missing retired Loki set.' >&2
  exit 1
fi
for failed_loki_step in FAIL_RETIRED_LOKI_LOOKUP FAIL_RETIRED_LOKI_PATCH; do
  : > "$KUBECTL_LOG"
  if (export "$failed_loki_step=1"; run_deploy); then
    echo "Deployment ignored $failed_loki_step." >&2
    exit 1
  fi
  if grep -Eq 'delete:.*(nix-loki|nix-grafana|nix-alloy)' "$KUBECTL_LOG"; then
    echo 'Deployment retired observability before ensuring its storage is retained.' >&2
    exit 1
  fi
done
# Production sites and push settings come from the manifest, not hand edits.
OIDC_ISSUER= run_deploy
grep -A1 -F 'name: Nix__Sites__RequireOperatorApproval' "$RENDERED_API" | grep -Fq 'value: "true"'
grep -Fq 'key: api-token, optional: true' "$RENDERED_API"
grep -Fq 'name: Nix__Sites__Cloudflare__ManagedZones__0__WorkspaceId' "$RENDERED_API"
grep -Fq 'name: Nix__Sites__CustomHostnameTarget' "$RENDERED_API"
grep -A1 -F 'name: Nix__Push__VapidPublicKey' "$RENDERED_API" | grep -Fq 'name: nix-push-vapid, key: public-key, optional: true'
grep -Fq 'automountServiceAccountToken: false' "$RENDERED_API"
grep -A1 -F 'name: Nix__Push__VapidPrivateKey' "$RENDERED_API" | grep -Fq 'name: nix-push-vapid, key: private-key, optional: true'
NIX_SITES_REQUIRE_OPERATOR_APPROVAL=false run_deploy
grep -A1 -F 'name: Nix__Sites__RequireOperatorApproval' "$RENDERED_API" | grep -Fq 'value: "false"'
if NIX_SITES_REQUIRE_OPERATOR_APPROVAL=maybe run_deploy 2>/dev/null; then
  echo 'Deployment accepted an invalid operator-approval flag.' >&2
  exit 1
fi
# The template sync job receives every variable its script requires.
test -n "$(sed -nE "s/.*required\\('(NIX_TEMPLATE_BOOT_[A-Z_]+)'\\).*/\\1/p" "$repo_root/deploy/template-sync/sync-managed-templates.mjs")"
for required_variable in $(sed -nE "s/.*required\('(NIX_TEMPLATE_BOOT_[A-Z_]+)'\).*/\1/p" "$repo_root/deploy/template-sync/sync-managed-templates.mjs"); do
  if ! grep -Fq "name: $required_variable" "$RENDERED_TEMPLATE_SYNC"; then
    echo "Template sync job does not set $required_variable." >&2
    exit 1
  fi
done
grep -A1 -F 'name: NIX_TEMPLATE_BOOT_REVISION' "$RENDERED_TEMPLATE_SYNC" | grep -Fq 'value: "render-order"'
grep -Fq 'value: "$(NIX_OBJECT_STORE_ENDPOINT),$(NIX_OBJECT_STORE_PUBLIC_ORIGIN)"' "$RENDERED_TEMPLATE_SYNC"
# A first install skips managed templates and still applies the origin lock and Ingress.
: > "$KUBECTL_LOG"
rm -f "$RENDERED_INGRESS"
run_first_install
if grep -Fq 'nix-template-boot' "$KUBECTL_LOG"; then
  echo 'A first install ran the managed-template step.' >&2
  exit 1
fi
assert_before "rollout:-n nix rollout status deployment/nix-zitadel --timeout=900s" "apply-file:deploy/k8s/cloudflare-only.yaml"
test "$(grep -A1 -xF 'apply-file:deploy/k8s/cloudflare-only.yaml' "$KUBECTL_LOG" | tail -n 1)" = 'apply-stdin:nix,nix-sites,nix-sites-custom-hosts'
grep -Fq 'host: "auth.nix.example.test"' "$RENDERED_INGRESS"
if (PATH="$fake_bin:$PATH" REGISTRY=r TAG=t OIDC_CLIENT_ID=c DOMAIN=nix.example.test \
  NIX_DEPLOY_TARGET=kubernetes bash "$repo_root/deploy/k8s/deploy.sh" >/dev/null 2>&1); then
  echo 'Deployment ran without template configuration while managed templates are enabled.' >&2
  exit 1
fi
# The kubelet cannot verify runAsNonRoot against a named image user (the node images run as "node").
if awk 'BEGIN { RS = "\n---\n" } /runAsNonRoot: true/ && !/runAsUser:/ { found = 1 } END { exit !found }' "$RENDERED_ALL"; then
  echo 'A runAsNonRoot pod has no numeric runAsUser.' >&2
  exit 1
fi
# Collab reads NIX_COLLAB_PORT, which the nix-node Service's link variables would overwrite.
awk 'BEGIN { RS = "\n---\n" } /name: nix-node, namespace/ && /kind: Deployment/ && /enableServiceLinks: false/ { found = 1 } END { exit !found }' "$RENDERED_ALL"
# The worker's readiness needs the public origin, so the Ingress precedes its rollout wait.
: > "$KUBECTL_LOG"
run_deploy
assert_before "apply-file:deploy/k8s/cloudflare-only.yaml" "rollout:-n nix rollout status deployment/nix-node"
assert_before "rollout:-n nix rollout status deployment/nix-node" "apply-stdin:nix-template-boot,nix-template-boot-render-order"
# auth.$DOMAIN must not fall to the sites wildcard: it sits in its own lowest-priority Ingress.
awk 'BEGIN { RS = "\n---\n" } /name: nix-sites\n/ && /host: "\*\.nix\.example\.test"/ && /router.priority: "1"/ && !/host: "auth\./ { found = 1 } END { exit !found }' "$RENDERED_INGRESS"
awk 'BEGIN { RS = "\n---\n" } /name: nix\n/ && /host: "auth\.nix\.example\.test"/ && !/host: "\*\./ { found = 1 } END { exit !found }' "$RENDERED_INGRESS"
# nixctl exchanges its PAT at Core's public route; without it the SPA fallback answers 405.
grep -Fq 'handle /public/v1/auth/token {' "$repo_root/deploy/k8s/Caddyfile"
# Off-node backup: optional by default, required by NIX_BACKUP_OFFSITE=true, never on argv.
: > "$KUBECTL_LOG"
run_deploy
grep -Fq 'name: OFFSITE_REQUIRED, value: "false"' "$RENDERED_BACKUP"
grep -Fq 'secretRef: { name: nix-backup-offsite, optional: true }' "$RENDERED_BACKUP"
grep -Eq 'image: restic/restic:[0-9]+\.[0-9]+\.[0-9]+@sha256:[0-9a-f]{64}$' "$RENDERED_BACKUP"
grep -Fq 'readOnlyRootFilesystem: true' "$RENDERED_BACKUP"
grep -Fq '{ name: backup, mountPath: /backup, readOnly: true }' "$RENDERED_BACKUP"
# Step outcomes travel in an emptyDir: dump and offsite are init containers, record is the main container.
grep -Fq 'emptyDir: { sizeLimit: 1Mi }' "$RENDERED_BACKUP"
awk '/^ +initContainers:/ { init = 1 } /^ +containers:/ { init = 0; main = 1 } init && /- name: (dump|offsite)$/ { n++ } main && /- name: record$/ { m++ } END { exit !(n == 2 && m == 1) }' "$RENDERED_BACKUP"
if grep -Fq 'nix-backup-offsite' "$KUBECTL_LOG"; then
  echo 'Deployment looked up the offsite secret without NIX_BACKUP_OFFSITE=true.' >&2
  exit 1
fi
: > "$KUBECTL_LOG"
if NIX_BACKUP_OFFSITE=true run_deploy 2>/dev/null; then
  echo 'Deployment accepted NIX_BACKUP_OFFSITE=true without the offsite secret.' >&2
  exit 1
fi
if grep -Fq 'apply-stdin:' "$KUBECTL_LOG"; then
  echo 'Deployment applied workloads before validating the offsite secret.' >&2
  exit 1
fi
if NIX_BACKUP_OFFSITE=maybe run_deploy 2>/dev/null; then
  echo 'Deployment accepted an invalid NIX_BACKUP_OFFSITE.' >&2
  exit 1
fi
OFFSITE_SECRET=1 NIX_BACKUP_OFFSITE=true run_deploy
grep -Fq 'name: OFFSITE_REQUIRED, value: "true"' "$RENDERED_BACKUP"

# The three backup scripts (dump, offsite, record), run against stub tools with /backup, /objects,
# /status and /tmp moved under a temporary root. They always exit 0 after leaving their outcome in
# /status, except record, which fails the Job when a step failed.
bk="$test_root/backup-scripts"
mkdir -p "$bk/bin" "$bk/backup" "$bk/objects" "$bk/status" "$bk/tmp"
extract_backup_script() {
  awk -v name="$1" '$0 ~ "- name: " name "$" { inside = 1 } inside && /^ *- \|$/ { script = 1; next }
    script && !/^ {18}/ { exit } script { sub(/^ {18}/, ""); print }' "$RENDERED_BACKUP" \
    | ROOT="$bk" perl -pe 's{(?<![\w.-])/(backup|objects|status|tmp)\b}{$ENV{ROOT}/$1}g' > "$bk/$1.sh"
  test -s "$bk/$1.sh"
}
for script in dump offsite record; do extract_backup_script "$script"; done
grep -Fq 'restic backup --json --host nix-k8s --tag kind=nightly' "$bk/offsite.sh"
printf '%s\n' '#!/bin/sh' 'echo roles' > "$bk/bin/pg_dumpall"
printf '%s\n' '#!/bin/sh' '[ -z "${FAIL_PGDUMP:-}" ] || exit 3' 'echo dump' > "$bk/bin/pg_dump"
printf '%s\n' '#!/bin/sh' 'while [ $# -gt 0 ]; do [ "$1" != -czf ] || { : > "$2"; exit 0; }; shift; done' > "$bk/bin/tar"
printf '%s\n' '#!/bin/sh' 'echo "restic $*" >> "$RESTIC_LOG"' 'case "$1" in' \
  '  cat) exit "${RESTIC_CAT_STATUS:-0}" ;;' \
  '  backup)' \
  '    if [ "${RESTIC_BACKUP_STATUS:-0}" != 0 ]; then' \
  '      echo "s3:https://SECRET-ACCOUNT.r2.example.test/bucket AWSAccessKeyId SECRET" >&2' \
  '      exit "$RESTIC_BACKUP_STATUS"' \
  '    fi' \
  '    echo "{\"message_type\":\"status\",\"percent_done\":0.5}"' \
  '    echo "{\"message_type\":\"summary\",\"files_new\":1,\"snapshot_id\":\"0123abcd4567\"}" ;;' \
  'esac' > "$bk/bin/restic"
printf '%s\n' '#!/bin/sh' 'for arg in "$@"; do printf "ARG %s\n" "$arg" >> "$PSQL_LOG"; done' 'cat >> "$PSQL_LOG"' \
  '[ -z "${FAIL_PSQL:-}" ]' > "$bk/bin/psql"
chmod +x "$bk/bin/"*
export RESTIC_LOG="$bk/restic.log" PSQL_LOG="$bk/psql.log"
run_script() { # run_script <shell> <script> [VAR=value ...]
  local shell=$1 script=$2
  shift 2
  env -u RESTIC_REPOSITORY PATH="$bk/bin:$PATH" OFFSITE_REQUIRED=false KEEP_DAYS=14 "$@" \
    "$shell" -ec "$(cat "$bk/$script.sh")" >"$bk/out" 2>&1
}

# dump: a success leaves status=succeeded and LATEST; a failure leaves the exit code and no new LATEST.
: > "$bk/status/local"
run_script /bin/bash dump
grep -qx 'status=succeeded' "$bk/status/local"
grep -Eqx 'bytes=[0-9]+' "$bk/status/local"
grep -Eqx 'started_at=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z' "$bk/status/local"
test "$(cat "$bk/backup/LATEST")" = "$(date +%F)"
cp "$bk/backup/LATEST" "$bk/latest.before"
run_script /bin/bash dump FAIL_PGDUMP=1
grep -qx 'status=failed' "$bk/status/local"
grep -qx 'error=local dump failed (exit 3)' "$bk/status/local"
cmp -s "$bk/backup/LATEST" "$bk/latest.before"

# offsite: against a stub restic and a hand-made backup directory.
mkdir -p "$bk/backup/2026-01-04"
printf 'dump\n' > "$bk/backup/2026-01-04/nix.dump"
(cd "$bk/backup/2026-01-04" && sha256sum ./* > SHA256SUMS)
printf '2026-01-04\n' > "$bk/backup/LATEST"
write_local() { printf 'started_at=2026-01-04T02:00:00Z\nfinished_at=2026-01-04T02:01:00Z\nstatus=%s\nbytes=2048\nerror=\n' "$1" > "$bk/status/local"; }
run_offsite() { rm -f "$bk/status/offsite"; : > "$RESTIC_LOG"; run_script /bin/sh offsite "$@"; }
configured=(RESTIC_REPOSITORY=s3:https://r2.example.test/bucket RESTIC_PASSWORD=p
  AWS_ACCESS_KEY_ID=k AWS_SECRET_ACCESS_KEY=s AWS_DEFAULT_REGION=auto)
expect_offsite_failure() { # expect_offsite_failure <error text> [VAR=value ...]
  local error=$1
  shift
  run_offsite "$@"
  grep -qx 'status=failed' "$bk/status/offsite"
  grep -Fqx "error=$error" "$bk/status/offsite"
  if grep -q SECRET "$bk/status/offsite"; then echo 'Tool output reached the offsite status.' >&2; exit 1; fi
  if grep -q '^restic forget' "$RESTIC_LOG"; then echo "The offsite step applied retention after: $error" >&2; exit 1; fi
}
write_local failed
run_offsite "${configured[@]}"
test ! -s "$RESTIC_LOG" && test ! -e "$bk/status/offsite"
write_local succeeded
run_offsite
test ! -s "$RESTIC_LOG" && test ! -e "$bk/status/offsite"
expect_offsite_failure 'offsite secret missing' OFFSITE_REQUIRED=true
run_offsite "${configured[@]}"
test "$(cut -d' ' -f2 "$RESTIC_LOG" | paste -sd' ' -)" = 'cat backup forget check'
grep -Fq "restic backup --json --host nix-k8s --tag kind=nightly $bk/backup/2026-01-04" "$RESTIC_LOG"
grep -Fq 'restic forget --host nix-k8s --tag kind=nightly --group-by host --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune' "$RESTIC_LOG"
grep -qx 'status=succeeded' "$bk/status/offsite"
grep -qx 'snapshot_id=0123abcd4567' "$bk/status/offsite"
grep -qx 'bytes=2048' "$bk/status/offsite"
grep -qx 'error=' "$bk/status/offsite"
expect_offsite_failure "restic backup of $bk/backup/2026-01-04 failed" "${configured[@]}" RESTIC_BACKUP_STATUS=1
expect_offsite_failure 'the repository does not exist; initialize it once with deploy/compose/offsite.sh init' "${configured[@]}" RESTIC_CAT_STATUS=10
expect_offsite_failure 'could not open the repository (restic exit 4)' "${configured[@]}" RESTIC_CAT_STATUS=4
expect_offsite_failure 'nix-backup-offsite does not set AWS_DEFAULT_REGION' "${configured[@]}" AWS_DEFAULT_REGION=
printf 'tampered\n' > "$bk/backup/2026-01-04/nix.dump"
expect_offsite_failure "$bk/backup/2026-01-04 does not match its SHA256SUMS" "${configured[@]}"
printf '../etc\n' > "$bk/backup/LATEST"
expect_offsite_failure 'unexpected backup directory name' "${configured[@]}"

# record: one psql session per step, values only through -v, and the Job fails when a step failed.
write_record_status() { # write_record_status <step> <status> <error>
  printf 'started_at=2026-01-04T02:00:00Z\nfinished_at=2026-01-04T02:01:00Z\nstatus=%s\nsnapshot_id=\nbytes=2048\nerror=%s\n' "$2" "$3" > "$bk/status/$1"
}
reset_record() { rm -f "$bk/status/local" "$bk/status/offsite"; : > "$PSQL_LOG"; }
reset_record
write_record_status local succeeded ''
write_record_status offsite failed "it's \"quoted\"; DROP TABLE backup_runs; --"
if run_script /bin/sh record; then echo 'record passed with a failed step.' >&2; exit 1; fi
test "$(grep -c '^ARG b_step=' "$PSQL_LOG")" = 2
grep -Fqx 'ARG b_step=local' "$PSQL_LOG"
grep -Fqx 'ARG b_status=failed' "$PSQL_LOG"
grep -Fqx "ARG b_error=it's \"quoted\"; DROP TABLE backup_runs; --" "$PSQL_LOG"
grep -Fq "SET LOCAL ROLE nix_backup; SELECT nix_record_backup_run(:'b_started'" "$PSQL_LOG"
if grep -vx 'ARG b_error=.*' "$PSQL_LOG" | grep -q 'DROP TABLE'; then echo 'A recorded value reached the SQL text.' >&2; exit 1; fi
reset_record
write_record_status local succeeded ''
run_script /bin/sh record
test "$(grep -c '^ARG b_step=' "$PSQL_LOG")" = 1
reset_record
if run_script /bin/sh record; then echo 'record passed with no local status.' >&2; exit 1; fi
test ! -s "$PSQL_LOG"
write_record_status local succeeded ''
run_script /bin/sh record FAIL_PSQL=1
grep -Fq 'record: backup status not recorded: local succeeded' "$bk/out"

# create-secrets.sh --backup-offsite-only reads values from the environment and never prints them.
: > "$KUBECTL_LOG"
offsite_output="$(PATH="$fake_bin:$PATH" RESTIC_REPOSITORY=s3:https://r2.example.test/repo-value \
  RESTIC_PASSWORD=password-value AWS_ACCESS_KEY_ID=key-id-value AWS_SECRET_ACCESS_KEY=secret-value \
  bash "$repo_root/deploy/k8s/create-secrets.sh" --backup-offsite-only 2>&1)"
grep -qx 'AWS_DEFAULT_REGION=auto' "$OFFSITE_ENV_COPY"
grep -qx 'RESTIC_PASSWORD=password-value' "$OFFSITE_ENV_COPY"
if grep -q -- '-value' <<<"$offsite_output" || grep -q -- '-value' "$KUBECTL_LOG"; then
  echo 'create-secrets.sh exposed an offsite credential.' >&2
  exit 1
fi
if (PATH="$fake_bin:$PATH" RESTIC_REPOSITORY=r bash "$repo_root/deploy/k8s/create-secrets.sh" --backup-offsite-only >/dev/null 2>&1); then
  echo 'create-secrets.sh accepted incomplete offsite credentials.' >&2
  exit 1
fi
# Identity bootstrap is opt-in, runs after migrations and before presets, and needs its values.
: > "$KUBECTL_LOG"
run_deploy
if grep -Fq 'exec:' "$KUBECTL_LOG"; then
  echo 'Deployment bootstrapped identity without NIX_BOOTSTRAP_IDENTITY=true.' >&2
  exit 1
fi
: > "$KUBECTL_LOG"
NIX_BOOTSTRAP_IDENTITY=true NIX_BOOTSTRAP_TENANT_NAME='Example Tenant' NIX_BOOTSTRAP_OIDC_PROJECT_ID=project-id run_deploy
assert_before "wait:-n nix wait --for=condition=complete job/nix-migrate-documents-render-order" "exec:-n nix exec -i statefulset/postgres"
assert_before "exec:-n nix exec -i statefulset/postgres" "create-configmap:nix-template-presets"
grep -Fq 'exec:-n nix exec -i statefulset/postgres -c postgres -- psql -X -v ON_ERROR_STOP=1 -U postgres -d nix -v tenant_name=Example Tenant -v tenant_id= -v oidc_issuer=https://identity.example.test -v oidc_client_id=web-client -v oidc_project_id=project-id -f -' "$KUBECTL_LOG"
cmp -s "$EXEC_STDIN" "$repo_root/deploy/seed/bootstrap_identity.sql"
for incomplete in NIX_BOOTSTRAP_TENANT_NAME NIX_BOOTSTRAP_OIDC_PROJECT_ID; do
  : > "$KUBECTL_LOG"
  if (export NIX_BOOTSTRAP_IDENTITY=true NIX_BOOTSTRAP_TENANT_NAME=t NIX_BOOTSTRAP_OIDC_PROJECT_ID=p; unset "$incomplete"; run_deploy 2>/dev/null); then
    echo "Identity bootstrap ran without $incomplete." >&2
    exit 1
  fi
  if [ -s "$KUBECTL_LOG" ]; then
    echo "Deployment touched the cluster before validating $incomplete." >&2
    exit 1
  fi
done
if NIX_BOOTSTRAP_IDENTITY=yes run_deploy 2>/dev/null; then
  echo 'Deployment accepted an invalid NIX_BOOTSTRAP_IDENTITY.' >&2
  exit 1
fi
# A generic cluster (deploy/install.sh --kubernetes): no Cloudflare origin lock, any ingress class.
: > "$KUBECTL_LOG"
INGRESS_CLASS=nginx NIX_INGRESS_CLOUDFLARE_ONLY=false STORAGE_CLASS=standard STORAGE_CLASS_RETAIN=standard \
  AUTH_PORT=80 AUTH_SECURE=false run_first_install
grep -Fq 'ingressClassName: nginx' "$RENDERED_INGRESS"
grep -Fq 'ssl-redirect: "true"' "$RENDERED_INGRESS"
grep -Fq 'value: "https://nix.example.test"' "$RENDERED_API"
grep -Fq 'https://nix.example.test|http://nix-api:8080/public/v1/auth/jwks' "$RENDERED_ALL"
grep -Fq 'router.middlewares: ""' "$RENDERED_INGRESS"
grep -Fq 'value: "X-Forwarded-For"' "$RENDERED_WEB"
grep -Fq 'ZITADEL_EXTERNALSECURE: "false"' "$RENDERED_ZITADEL"
grep -Fq '"--tlsMode", "external"' "$RENDERED_ZITADEL"
assert_before "delete:-n nix delete statefulset/nix-rabbitmq service/nix-rabbitmq networkpolicy/rabbitmq-ingress configmap/nix-rabbitmq-config secret/nix-rabbitmq --ignore-not-found" "kubectl:-n nix rollout restart deployment/nix-node"
if grep -Fq 'cloudflare-only.yaml' "$KUBECTL_LOG"; then
  echo 'Deployment applied the Cloudflare origin lock on a generic cluster.' >&2
  exit 1
fi
# Remote MCP is on by default: its own Ingress routes /mcp and Core advertises the endpoint.
: > "$KUBECTL_LOG"; : > "$RENDERED_ALL"
run_deploy
grep -Fq 'apply-stdin:nix-mcp,nix-mcp,nix-mcp' "$KUBECTL_LOG"
grep -A1 -F 'name: Nix__Mcp__PublicUrl' "$RENDERED_API" | grep -Fq 'value: "https://nix.example.test/mcp"'
# NIX_MCP_ENABLED=false removes it and Core advertises nothing.
: > "$KUBECTL_LOG"; : > "$RENDERED_ALL"
NIX_MCP_ENABLED=false run_deploy
grep -Fq 'delete:-n nix delete ingress/nix-mcp service/nix-mcp deployment/nix-mcp --ignore-not-found' "$KUBECTL_LOG"
grep -A1 -F 'name: Nix__Mcp__PublicUrl' "$RENDERED_API" | grep -Fq 'value: ""'
if grep -Fq 'nix-mcp' "$RENDERED_ALL"; then
  echo 'Deployment applied remote MCP with NIX_MCP_ENABLED=false.' >&2
  exit 1
fi
if NIX_MCP_ENABLED=yes run_deploy 2>/dev/null; then
  echo 'Deployment accepted an invalid NIX_MCP_ENABLED.' >&2
  exit 1
fi
echo "deployment render-order self-test passed"
