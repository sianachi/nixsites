#!/usr/bin/env bash
# Post-deploy checks, in order - each fails in a distinguishable way. Run after deploy/k8s/deploy.sh.
#
#   DOMAIN=nix.example.com SITE_HOST=docs.nix.example.com deploy/k8s/verify.sh
#
# SITE_HOST is optional: a published site's hostname under $DOMAIN, checked for the site CSP and
# for the absence of Set-Cookie.
#
# What this script cannot check, because they need a browser: sign-in end to end, two
# browsers editing the same note (exercises the collab WebSocket upgrade through Traefik and
# Caddy - the one thing in this deployment most likely to be wrong), exporting a note as PDF,
# and reloading on a deep route (a 404 there means Caddy's try_files fallback is not in effect).
set -euo pipefail
: "${DOMAIN:?set DOMAIN, e.g. nix.example.com}"

echo "== Pods =="
kubectl -n nix get pods

echo "== Core =="
kubectl -n nix run verify-curl-core --rm -i --image=curlimages/curl --restart=Never -- \
  curl -fsS http://nix-api:8080/healthz
kubectl -n nix run verify-curl-core2 --rm -i --image=curlimages/curl --restart=Never -- \
  curl -fsS http://nix-api:8080/api/v1/health/status

echo "== Core has persistence configured (expect no matches below) =="
kubectl -n nix logs deploy/nix-api | grep -i "persistence" || true
kubectl -n nix logs deploy/nix-api | grep -i "internal surface" || true

echo "== Node host (collab 8100, sites worker 8301, companion 8302) =="
for port in 8100 8301 8302; do
  kubectl -n nix run "verify-curl-node-$port" --rm -i --image=curlimages/curl --restart=Never -- \
    curl -fsS "http://nix-node:$port/healthz"
done

echo "== Object store =="
# The versitygw ingress policy admits a new pod's address a few seconds after it starts.
kubectl -n nix run verify-curl-versitygw --rm -i --image=curlimages/curl --restart=Never \
  --labels=app=nix-storage-init -- \
  curl -fsS --retry 10 --retry-delay 2 --retry-connrefused http://nix-versitygw:7070/health
object_bucket="$(kubectl -n nix get secret nix-object-store -o jsonpath='{.data.bucket}' | base64 -d)"
# An unsigned request reaches versitygw through Caddy and is refused (403), not the app shell (200).
bucket_status="$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/$object_bucket/verify-unsigned")"
echo "$bucket_status unsigned object request (want 403)"
if [ "$bucket_status" != 403 ]; then
  echo "The capability route https://$DOMAIN/$object_bucket/ does not reach the object store." >&2
  exit 1
fi

echo "== Identity provider (https://auth.$DOMAIN) =="
issuer="$(curl -fsS "https://auth.$DOMAIN/.well-known/openid-configuration" | sed -nE 's/.*"issuer":"([^"]+)".*/\1/p')"
echo "issuer $issuer"
if [ "$issuer" != "https://auth.$DOMAIN" ]; then
  echo "Zitadel does not announce https://auth.$DOMAIN as its issuer." >&2
  exit 1
fi

echo "== Sites serve (health answers only a loopback Host) =="

kubectl -n nix run verify-curl-sites-serve --rm -i --image=curlimages/curl --restart=Never -- \
  curl -fsS -H 'Host: localhost' http://nix-sites-serve:8400/healthz

echo "== Single origin (https://$DOMAIN) =="
curl -fsS "https://$DOMAIN/" -o /dev/null -w '%{http_code} app\n'
curl -fsS "https://$DOMAIN/api/v1/health/status" -w ' core\n'
curl -fsS "https://$DOMAIN/auth/session" -w ' browser auth\n'
curl -fsS "https://$DOMAIN/collab/healthz" -w ' collab\n'

echo "== /internal must be unreachable (expect 404) =="
curl -s -o /dev/null -w '%{http_code} internal (want 404)\n' "https://$DOMAIN/internal/authorize"

echo "== Security headers keep provider communication server-side =="
curl -sI "https://$DOMAIN/" | grep -i content-security-policy
if ! curl -sI "https://$DOMAIN/" | grep -qi "^content-security-policy:.*frame-ancestors 'none'" || ! curl -sI "https://$DOMAIN/" | grep -qi '^x-frame-options: DENY'; then
  echo "The app must send frame-ancestors 'none' and X-Frame-Options DENY." >&2
  exit 1
fi

echo "== Sites: the apex stays the app, a site host is anonymous =="
apex_headers="$(curl -sSI "https://$DOMAIN/")"
if printf '%s\n' "$apex_headers" | grep -qi "^content-security-policy: default-src 'none'"; then
  echo "The apex is answered by the sites server instead of the app." >&2
  exit 1
fi
if [ -n "${SITE_HOST:-}" ]; then
  case "$SITE_HOST" in
    *".$DOMAIN") ;;
    *) echo "SITE_HOST must be a hostname under $DOMAIN." >&2; exit 1 ;;
  esac
  site_headers="$(curl -sS -D - -o /dev/null -w '%{http_code}' "https://$SITE_HOST/")"
  site_status="${site_headers##*$'\n'}"
  echo "$site_status site $SITE_HOST"
  if [ "$site_status" != 200 ]; then
    echo "Site $SITE_HOST did not answer 200." >&2
    exit 1
  fi
  if ! printf '%s\n' "$site_headers" | grep -qi "^content-security-policy: default-src 'none'"; then
    echo "Site $SITE_HOST is missing the sites Content-Security-Policy." >&2
    exit 1
  fi
  if printf '%s\n' "$site_headers" | grep -qi '^set-cookie:'; then
    echo "Site $SITE_HOST set a cookie." >&2
    exit 1
  fi
else
  echo "SITE_HOST not set - skipping the published-site check."
fi

echo "== Off-node backup =="
# The nightly Job succeeds only after its offsite push, forget and check, so with the secret present
# its last success is the age of the newest offsite snapshot.
if kubectl -n nix get secret nix-backup-offsite >/dev/null 2>&1; then
  last_backup="$(kubectl -n nix get cronjob nix-backup -o jsonpath='{.status.lastSuccessfulTime}')"
  offsite_since="$(kubectl -n nix get secret nix-backup-offsite -o jsonpath='{.metadata.creationTimestamp}')"
  # RFC 3339 UTC timestamps order as strings; a success before the secret existed pushed nothing.
  if [ -z "$last_backup" ] || [[ "$last_backup" < "$offsite_since" ]]; then
    echo "WARNING: offsite configured but no nix-backup run has succeeded since."
  else
    backup_age_hours=$(( ($(date -u +%s) - $(date -u -d "$last_backup" +%s 2>/dev/null || date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$last_backup" +%s)) / 3600 ))
    echo "last successful offsite snapshot $last_backup (${backup_age_hours}h ago)"
    if [ "$backup_age_hours" -gt 36 ]; then
      echo "WARNING: the last offsite snapshot is older than 36 hours - check: kubectl -n nix logs -l app=nix-backup -c offsite"
    fi
  fi
else
  echo "nix-backup-offsite not configured - backups stay on the node."
fi

echo "Automated checks done. Remaining: sign in, two-browser edit, PDF export, deep-route reload."
