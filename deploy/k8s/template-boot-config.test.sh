#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
source "$script_dir/template-boot-config.sh"

if (unset TEMPLATE_BOOT_WORKSPACE_ID TEMPLATE_BOOT_OIDC_AUDIENCE TEMPLATE_BOOT_PVC \
  TEMPLATE_BOOT_SERVICE_KEY_SECRET; require_template_boot_config) 2>/dev/null; then
  echo "missing managed-template configuration was accepted" >&2
  exit 1
fi

TEMPLATE_BOOT_WORKSPACE_ID=11111111-1111-4111-8111-111111111111
TEMPLATE_BOOT_OIDC_AUDIENCE=project-id
TEMPLATE_BOOT_PVC=template-files
TEMPLATE_BOOT_SERVICE_KEY_SECRET=template-key
unset TEMPLATE_BOOT_OIDC_SCOPE
require_template_boot_config
[ "$TEMPLATE_BOOT_OIDC_SCOPE" = \
  "openid urn:zitadel:iam:org:project:id:project-id:aud" ]

# A Core access token needs no identity provider settings, and works in local mode.
(unset TEMPLATE_BOOT_OIDC_AUDIENCE TEMPLATE_BOOT_SERVICE_KEY_SECRET
  AUTH_MODE=local TEMPLATE_BOOT_TOKEN_SECRET=template-token
  require_template_boot_config
  [ "$TEMPLATE_BOOT_ACCESS_TOKEN_FILE" = /var/run/secrets/nix/credential ]
  [ -z "$TEMPLATE_BOOT_SERVICE_KEY_FILE" ] && [ "$TEMPLATE_BOOT_CREDENTIAL_KEY" = token ])
# Without a token, local mode has no machine key to fall back on.
if (AUTH_MODE=local TEMPLATE_BOOT_TOKEN_SECRET= require_template_boot_config) 2>/dev/null; then
  echo "local mode was accepted without a token secret" >&2
  exit 1
fi

echo "template boot configuration self-test passed"
