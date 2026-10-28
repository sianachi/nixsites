#!/usr/bin/env bash
# Configure the development Zitadel instance to the credentials this repo
# expects, so the IdP is reproducible instead of hand-clicked through the
# console.
#
# Idempotent: every object is looked up by name first and only created when
# absent, so running this repeatedly converges rather than duplicating.
#
# What it creates, inside the first-instance org:
#   - a project, NIX_ZITADEL_PROJECT_NAME
#   - a user-agent (SPA) OIDC application for the web app, PKCE, no secret,
#     with the dev redirect URIs. Its generated client ID is written out.
#   - a developer human user with the credentials specified in .env, so tests
#     and manual sign-in always have a known account.
#   - an active SMTP provider pointed at Mailpit and a login policy allowing
#     password reset and passkeys (deploy/seed/zitadel-self-service.sh).
#
# Outputs deploy/.zitadel/oidc.generated.env: issuer, client ID and the dev
# user's credentials, for the API and web app to consume. That file is
# gitignored - it is generated, machine-specific state, not source.
#
# Usage (from anywhere, with the core profile up):
#   deploy/seed/zitadel-configure.sh
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
deploy_dir="$(cd "$script_dir/.." && pwd)"
compose_file="$deploy_dir/compose.dev.yml"
out_dir="$deploy_dir/.zitadel"
out_file="$out_dir/oidc.generated.env"
source "$script_dir/zitadel-machine.sh"

zitadel_port="${ZITADEL_PORT:-8300}"
base_url="http://localhost:${zitadel_port}"

project_name="${NIX_ZITADEL_PROJECT_NAME:-Nix}"
app_name="${NIX_ZITADEL_APP_NAME:-Nix Web}"
web_origin="${NIX_WEB_ORIGIN:-http://localhost:5173}"

dev_username="${NIX_ZITADEL_DEV_USERNAME:-dev@nix.localhost}"
dev_password="${NIX_ZITADEL_DEV_PASSWORD:-NixDev-Password1!}"
dev_given_name="${NIX_ZITADEL_DEV_GIVEN_NAME:-Nix}"
dev_family_name="${NIX_ZITADEL_DEV_FAMILY_NAME:-Developer}"
dev_email="${NIX_ZITADEL_DEV_EMAIL:-dev@nix.localhost}"
template_boot_username="${NIX_ZITADEL_TEMPLATE_BOOT_USERNAME:-template-boot@nix.localhost}"
template_boot_name="${NIX_ZITADEL_TEMPLATE_BOOT_NAME:-Nix Template Boot}"
rotate_template_boot_key="${NIX_ZITADEL_ROTATE_TEMPLATE_BOOT_KEY:-false}"
template_boot_key_expiration="${NIX_ZITADEL_TEMPLATE_BOOT_KEY_EXPIRATION:-2299-12-31T23:59:59Z}"

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "zitadel-configure: '$1' is required but not installed" >&2
    exit 1
  }
}
require curl
require jq

# ── Wait for Zitadel to serve discovery ─────────────────────────────────────
echo "zitadel-configure: waiting for $base_url to serve OIDC discovery"
deadline=$((SECONDS + 180))
until curl -fsS -o /dev/null "$base_url/.well-known/openid-configuration" 2>/dev/null; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "zitadel-configure: Zitadel did not become ready within 180s" >&2
    echo "zitadel-configure: check 'docker compose -f $compose_file logs zitadel'" >&2
    exit 1
  fi
  sleep 3
done
echo "zitadel-configure: Zitadel is serving"

# ── Read the bootstrap PAT ──────────────────────────────────────────────────
# Written by the first-instance bootstrap into the machinekey volume. Read it
# out of the volume rather than the container, which is distroless.
pat="$(docker run --rm \
  -v nix-dev_zitadel-machinekey:/machinekey:ro \
  busybox:1.37 sh -c 'cat /machinekey/pat.txt 2>/dev/null' || true)"
pat="$(printf '%s' "$pat" | tr -d '\r\n')"

if [ -z "$pat" ]; then
  echo "zitadel-configure: no PAT found in the zitadel-machinekey volume." >&2
  echo "zitadel-configure: the first-instance bootstrap writes it on the very" >&2
  echo "  first initialisation only. If this instance predates that bootstrap," >&2
  echo "  recreate it:  docker compose -f $compose_file --profile core down -v" >&2
  exit 1
fi

api() {
  # api <method> <path> [json-body]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -fsS -X "$method" "$base_url$path" \
      -H "Authorization: Bearer $pat" \
      -H 'Content-Type: application/json' \
      -d "$body"
  else
    curl -fsS -X "$method" "$base_url$path" \
      -H "Authorization: Bearer $pat" \
      -H 'Content-Type: application/json'
  fi
}

# Idempotent deletion is required by rotation recovery: a crash can happen after Zitadel deleted
# the old key but before the local journal advanced. A retrying 404 therefore means converged.
delete_machine_key_if_present() {
  local user_id="$1" key_id="$2" response_file http_code
  response_file="$(mktemp)"
  if ! http_code="$(curl -sS -o "$response_file" -w '%{http_code}' -X DELETE \
    "$base_url/v2/users/$user_id/keys/$key_id" \
    -H "Authorization: Bearer $pat" \
    -H 'Content-Type: application/json')"; then
    rm -f "$response_file"
    return 1
  fi
  rm -f "$response_file"
  case "$http_code" in
    200|204|404) return ;;
    *) return 1 ;;
  esac
}

list_machine_key_ids() {
  local user_id="$1" response total returned
  response="$(api POST /v2/users/keys/search '{"pagination":{"limit":1000}}')"
  total="$(jq -r '(.pagination.totalResult // 0) | tonumber' <<<"$response")"
  returned="$(jq -r '(.result // []) | length' <<<"$response")"
  if [ "$returned" -lt "$total" ]; then
    echo "zitadel-configure: refusing incomplete service-account key reconciliation" >&2
    return 1
  fi
  jq -r --arg user_id "$user_id" \
    '(.result // [])[]? | select(.userId == $user_id) | (.id // empty)' \
    <<<"$response"
}

# ── Instance features ───────────────────────────────────────────────────────
# Turn off the v2 login UI.
#
# A fresh Zitadel instance sets loginV2.required = true, which routes every
# sign-in to /ui/v2/login. That UI is a SEPARATE service shipped as its own
# container, and this compose stack does not run it - so the redirect lands on a
# route with no handler and the browser gets a bare gRPC status:
#
#     /oauth/v2/authorize -> 302 -> /ui/v2/login/login?authRequest=...
#                                -> {"code":5, "message":"Not Found"}
#
# which says nothing about the actual cause. Disabling the flag makes Zitadel
# serve its own built-in login, which is what this stack expects and what the
# registered redirect URIs are for.
#
# The alternative is adding the login-v2 container to compose. That is closer to
# where Zitadel is heading and worth revisiting, but it is another service to
# run and keep in step for a development stack whose whole point is one command.
echo "zitadel-configure: disabling the v2 login UI (no login-v2 service in this stack)"
api PUT /v2/features/instance '{"loginV2":{"required":false}}' >/dev/null
echo "zitadel-configure: instance will use the built-in login"

# ── Project ─────────────────────────────────────────────────────────────────
project_id="$(api POST /management/v1/projects/_search \
  "$(jq -nc --arg n "$project_name" \
    '{queries:[{nameQuery:{name:$n,method:"TEXT_QUERY_METHOD_EQUALS"}}]}')" \
  | jq -r --arg n "$project_name" \
      'first(.result[]? | select(.name == $n) | .id) // empty')"

if [ -n "$project_id" ]; then
  echo "zitadel-configure: project '$project_name' already present ($project_id)"
else
  project_id="$(api POST /management/v1/projects \
    "$(jq -nc --arg n "$project_name" '{name:$n}')" | jq -r '.id')"
  echo "zitadel-configure: created project '$project_name' ($project_id)"
fi

# ── OIDC application (SPA, PKCE, no secret) ─────────────────────────────────
# Both dev redirect URIs are registered: the login callback, and the hidden
# iframe target that automatic silent renewal navigates to with prompt=none.
# Tokens are held in memory only (packages/web-platform/src/auth/oidc-config.ts), so every
# page reload depends on a silent renew - and Zitadel answers an authorize
# request naming an unregistered redirect_uri with a hard 400, which turns a
# missing entry here into a session that cannot survive a reload.
redirect_uris="$(jq -nc \
  --arg callback "$web_origin/auth/callback" \
  --arg silent "$web_origin/auth/silent-renew" \
  '[$callback, $silent]')"

# devMode allows the plain-http localhost redirects the dev server uses.
# Access tokens are JWTs so the API can validate them against JWKS, and role
# assertion is off on purpose: roles live in the database, never in a token.
oidc_config="$(jq -nc \
  --argjson redirects "$redirect_uris" \
  --arg logout "$web_origin" \
  '{
    redirectUris: $redirects,
    postLogoutRedirectUris: [$logout],
    responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
    grantTypes: ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE", "OIDC_GRANT_TYPE_REFRESH_TOKEN"],
    appType: "OIDC_APP_TYPE_USER_AGENT",
    authMethodType: "OIDC_AUTH_METHOD_TYPE_NONE",
    devMode: true,
    accessTokenType: "OIDC_TOKEN_TYPE_JWT",
    accessTokenRoleAssertion: false,
    idTokenRoleAssertion: false,
    idTokenUserinfoAssertion: true
  }')"

app_json="$(api POST "/management/v1/projects/$project_id/apps/_search" \
  "$(jq -nc '{queries:[]}')" \
  | jq -c --arg n "$app_name" 'first(.result[]? | select(.name == $n)) // empty')"

if [ -n "$app_json" ]; then
  client_id="$(jq -r '.oidcConfig.clientId' <<<"$app_json")"
  app_id="$(jq -r '.id' <<<"$app_json")"
  echo "zitadel-configure: application '$app_name' already present"

  # Re-assert the OIDC configuration when a URI this script now registers is
  # missing, so an application created by an older run converges - the same
  # reason the developer password below is re-asserted. Guarded rather than
  # unconditional, because Zitadel answers an update that changes nothing with
  # an error, not a no-op.
  missing="$(jq -r --argjson want "$redirect_uris" \
    '(.oidcConfig.redirectUris // []) as $have | $want - $have | length' <<<"$app_json")"
  if [ "$missing" != "0" ]; then
    api PUT "/management/v1/projects/$project_id/apps/$app_id/oidc_config" \
      "$oidc_config" >/dev/null
    echo "zitadel-configure: re-asserted the redirect URIs (silent-renew was missing)"
  fi
else
  app_payload="$(jq -nc \
    --arg name "$app_name" \
    --argjson config "$oidc_config" \
    '{name: $name} + $config')"
  client_id="$(api POST "/management/v1/projects/$project_id/apps/oidc" \
    "$app_payload" | jq -r '.clientId')"
  echo "zitadel-configure: created application '$app_name' (client $client_id)"
fi

# ── Developer human user with specified credentials ─────────────────────────
user_id="$(api POST /v2/users \
  "$(jq -nc --arg u "$dev_username" \
    '{query:{offset:"0",limit:100},queries:[{userNameQuery:{userName:$u,method:"TEXT_QUERY_METHOD_EQUALS"}}]}')" \
  2>/dev/null | jq -r 'first(.result[]?.userId) // empty' || true)"

if [ -n "$user_id" ]; then
  echo "zitadel-configure: developer user '$dev_username' already present"
  # Re-assert the password so rotating it in .env takes effect.
  api POST "/v2/users/$user_id/password" \
    "$(jq -nc --arg p "$dev_password" \
      '{newPassword:{password:$p,changeRequired:false}}')" >/dev/null
  echo "zitadel-configure: reset developer password to the configured value"
else
  user_payload="$(jq -nc \
    --arg u "$dev_username" \
    --arg g "$dev_given_name" \
    --arg f "$dev_family_name" \
    --arg e "$dev_email" \
    --arg p "$dev_password" \
    '{
      username: $u,
      profile: {givenName: $g, familyName: $f},
      email: {email: $e, isVerified: true},
      password: {password: $p, changeRequired: false}
    }')"
  user_id="$(api POST /v2/users/human "$user_payload" | jq -r '.userId')"
  echo "zitadel-configure: created developer user '$dev_username' ($user_id)"
fi

# ── Managed-template service account and JWT-profile key ────────────────────
template_boot_user_json="$(api POST /v2/users \
  "$(jq -nc --arg u "$template_boot_username" \
    '{query:{offset:"0",limit:100},queries:[{userNameQuery:{userName:$u,method:"TEXT_QUERY_METHOD_EQUALS"}}]}')" \
  | jq -c --arg u "$template_boot_username" \
      'first(.result[]? | select((.username == $u) and (.machine != null))) // empty')"
template_boot_user_id="$(jq -r '.userId // empty' <<<"$template_boot_user_json")"

if [ -n "$template_boot_user_id" ]; then
  echo "zitadel-configure: template boot service account already present ($template_boot_user_id)"
  ensure_machine_jwt_access_token "$template_boot_user_json" "$template_boot_user_id"
else
  template_boot_user_id="$(api POST /management/v1/users/machine \
    "$(jq -nc \
      --arg u "$template_boot_username" \
      --arg n "$template_boot_name" \
      '{userName:$u,name:$n,description:"Imports repository-managed Nix templates",accessTokenType:"ACCESS_TOKEN_TYPE_JWT"}')" \
    | jq -r '.userId')"
  echo "zitadel-configure: created template boot service account ($template_boot_user_id)"
fi

mkdir -p "$out_dir"
template_boot_key_file="$out_dir/template-boot-service-account-key.json"
previous_template_boot_key_file="$out_dir/template-boot-service-account-key.previous"
template_boot_rotation_journal="$out_dir/template-boot-service-account-key.rotation.json"
pending_key_file="$out_dir/.template-boot-service-account-key.pending"
self_service_pat="$out_dir/.bootstrap.pat"
cleanup_key_tempfiles() {
  rm -f "$self_service_pat"
  if [ -n "${pending_key_file:-}" ]; then
    rm -f "$pending_key_file"
  fi
  rm -f "${pending_key_file}.tmp" \
    "${template_boot_rotation_journal}.tmp" \
    "${template_boot_key_file}.tmp"
}
trap cleanup_key_tempfiles EXIT
trap 'exit 1' HUP INT TERM

existing_key_user=""
existing_key_id=""
if [ -f "$template_boot_key_file" ]; then
  existing_key_user="$(jq -r '.userId // empty' "$template_boot_key_file" 2>/dev/null || true)"
  existing_key_id="$(jq -r '.keyId // empty' "$template_boot_key_file" 2>/dev/null || true)"
fi
recovered_key_rotation=false
resume_key_action=""
journal_phase="$(jq -r '.phase // empty' "$template_boot_rotation_journal" 2>/dev/null || true)"
if [ -f "$pending_key_file" ]; then
  if jq -e --arg u "$template_boot_user_id" \
    '.type == "serviceaccount" and .userId == $u and (.keyId | type == "string") and (.key | type == "string")' \
    "$pending_key_file" >/dev/null 2>&1; then
    if [ "$journal_phase" = create-intent ]; then
      record_machine_key_creation "$template_boot_rotation_journal" "$pending_key_file"
    elif [ ! -f "$template_boot_rotation_journal" ]; then
      begin_machine_key_rotation \
        "$template_boot_rotation_journal" \
        "$template_boot_user_id" \
        "$existing_key_id" \
        "$pending_key_file"
    fi
  fi
  rm -f "$pending_key_file"
fi
if [ -f "$previous_template_boot_key_file" ] && [ ! -f "$template_boot_rotation_journal" ]; then
  previous_key_id="$(tr -d '\r\n' < "$previous_template_boot_key_file")"
  begin_machine_key_rotation \
    "$template_boot_rotation_journal" \
    "$template_boot_user_id" \
    "$previous_key_id" \
    "$template_boot_key_file"
  rm -f "$previous_template_boot_key_file"
fi
journal_phase="$(jq -r '.phase // empty' "$template_boot_rotation_journal" 2>/dev/null || true)"
tracked_key_id=""
if [ "$journal_phase" != create-intent ]; then
  tracked_key_id="$(jq -r '.newKeyId // empty' "$template_boot_rotation_journal" 2>/dev/null || true)"
fi
reconcile_machine_remote_keys "$template_boot_user_id" "$existing_key_id" "$tracked_key_id"
if [ "$journal_phase" = create-intent ]; then
  intent_old_key_id="$(jq -r '.oldKeyId // empty' "$template_boot_rotation_journal")"
  if [ -n "$intent_old_key_id" ]; then
    resume_key_action=rotate
  else
    resume_key_action=create
  fi
  rm -f "$template_boot_rotation_journal" "${template_boot_rotation_journal}.tmp"
elif [ -f "$template_boot_rotation_journal" ]; then
  converge_machine_key_rotation "$template_boot_rotation_journal" "$template_boot_key_file"
  rm -f "$previous_template_boot_key_file"
  recovered_key_rotation=true
fi
existing_key_user="$(jq -r '.userId // empty' "$template_boot_key_file" 2>/dev/null || true)"
existing_key_id="$(jq -r '.keyId // empty' "$template_boot_key_file" 2>/dev/null || true)"
key_action="$(template_boot_key_action \
  "$existing_key_user" \
  "$template_boot_user_id" \
  "$rotate_template_boot_key")"
if [ -n "$resume_key_action" ]; then
  key_action="$resume_key_action"
elif [ "$recovered_key_rotation" = true ] && [ "$key_action" = rotate ]; then
  # The prior run already created and installed the replacement. This run completed that same
  # rotation by revoking its predecessor; rotating again would create a new predecessor forever.
  key_action=reuse
fi

if [ "$key_action" = reuse ]; then
  echo "zitadel-configure: template boot service-account key already present"
else
  begin_machine_key_creation_intent \
    "$template_boot_rotation_journal" \
    "$template_boot_user_id" \
    "$existing_key_id"
  key_response="$(api POST "/v2/users/$template_boot_user_id/keys" \
    "$(jq -nc --arg expiration "$template_boot_key_expiration" '{expirationDate:$expiration}')")"
  key_content="$(jq -r '.keyContent // empty' <<<"$key_response")"
  if [ -z "$key_content" ]; then
    echo "zitadel-configure: Zitadel did not return the new service-account key" >&2
    exit 1
  fi
  rm -f "$pending_key_file" "${pending_key_file}.tmp"
  jq -r '.keyContent | @base64d' <<<"$key_response" > "${pending_key_file}.tmp"
  chmod 600 "${pending_key_file}.tmp"
  mv "${pending_key_file}.tmp" "$pending_key_file"
  if ! jq -e --arg u "$template_boot_user_id" \
    '.type == "serviceaccount" and .userId == $u and (.keyId | type == "string") and (.key | type == "string")' \
    "$pending_key_file" >/dev/null; then
    rm -f "$pending_key_file"
    echo "zitadel-configure: the returned service-account key was invalid" >&2
    exit 1
  fi
  record_machine_key_creation "$template_boot_rotation_journal" "$pending_key_file"
  rm -f "$pending_key_file"
  converge_machine_key_rotation "$template_boot_rotation_journal" "$template_boot_key_file"
  echo "zitadel-configure: wrote a $key_action template boot service-account key"
fi

# ── Self-service: password reset mail and passkeys ──────────────────────────
# The same script an operator runs against production, pointed at Mailpit so a
# reset code or passkey link is readable at http://localhost:8325.
( umask 077 && printf '%s\n' "$pat" > "$self_service_pat" )
ZITADEL_URL="$base_url" \
ZITADEL_PAT_FILE="$self_service_pat" \
NIX_SMTP_HOST="${NIX_DEV_SMTP_HOST:-mailpit:1025}" \
NIX_SMTP_SENDER="${NIX_DEV_SMTP_SENDER:-no-reply@nix.localhost}" \
NIX_SMTP_TLS=false \
  "$script_dir/zitadel-self-service.sh"
rm -f "$self_service_pat"

# ── Write the generated configuration ───────────────────────────────────────
cat > "$out_file" <<EOF
# Generated by deploy/seed/zitadel-configure.sh. Do not edit; re-run instead.
# Machine-specific state, not source: this file is gitignored.
NIX_OIDC_ISSUER=$base_url
NIX_OIDC_DISCOVERY=$base_url/.well-known/openid-configuration
NIX_OIDC_CLIENT_ID=$client_id
NIX_OIDC_PROJECT_ID=$project_id
NIX_TEMPLATE_BOOT_SERVICE_USER_ID=$template_boot_user_id
NIX_TEMPLATE_BOOT_SERVICE_KEY_FILE=$template_boot_key_file
NIX_TEMPLATE_BOOT_OIDC_SCOPE="openid urn:zitadel:iam:org:project:id:$project_id:aud"
NIX_OIDC_REDIRECT_URI=$web_origin/auth/callback
NIX_OIDC_POST_LOGOUT_REDIRECT_URI=$web_origin
NIX_DEV_USERNAME=$dev_username
NIX_DEV_PASSWORD=$dev_password
# The issuer's subject claim for the developer user. seed.sh maps the Acme
# administrator principal onto it, because Core resolves a token's subject claim
# against principal.external_subject and refuses a subject nobody provisioned -
# a token alone must never mint an identity.
# (No backticks in this comment: the heredoc is unquoted so the shell can
# interpolate the values above, which makes a backtick a command substitution.)
NIX_DEV_USER_ID=$user_id
EOF

echo
echo "zitadel-configure: complete."
echo "  issuer    : $base_url"
echo "  client ID : $client_id"
echo "  dev login : $dev_username / $dev_password"
echo "  written   : ${out_file#"$(cd "$deploy_dir/.." && pwd)/"}"
echo "zitadel-configure: re-running this script is a no-op."
