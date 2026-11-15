#!/usr/bin/env bash

# The sync signs in with a Core access token (secret TEMPLATE_BOOT_TOKEN_SECRET, key "token", made
# with the migrator's "account service-token") or, when none is given, an identity provider's
# service-account key. The token works in either sign-in mode; the key needs oidc.
require_template_boot_config() {
  : "${TEMPLATE_BOOT_WORKSPACE_ID:?set TEMPLATE_BOOT_WORKSPACE_ID to the managed-template workspace UUID}"
  : "${TEMPLATE_BOOT_PVC:?set TEMPLATE_BOOT_PVC to the claim containing managed .nix files}"
  TEMPLATE_BOOT_SERVICE_KEY_FILE="" TEMPLATE_BOOT_ACCESS_TOKEN_FILE=""
  if [ -n "${TEMPLATE_BOOT_TOKEN_SECRET:-}" ]; then
    TEMPLATE_BOOT_CREDENTIAL_SECRET=$TEMPLATE_BOOT_TOKEN_SECRET TEMPLATE_BOOT_CREDENTIAL_KEY=token
    TEMPLATE_BOOT_ACCESS_TOKEN_FILE=/var/run/secrets/nix/credential
  else
    [ "${AUTH_MODE:-oidc}" = oidc ] || {
      echo "NIX_TEMPLATE_BOOT_ENABLED=true in local mode needs TEMPLATE_BOOT_TOKEN_SECRET (a secret with a Core access token as key \"token\"); use false to skip" >&2
      return 1
    }
    : "${TEMPLATE_BOOT_OIDC_AUDIENCE:?set TEMPLATE_BOOT_OIDC_AUDIENCE to the Zitadel project ID}"
    : "${TEMPLATE_BOOT_SERVICE_KEY_SECRET:?set TEMPLATE_BOOT_SERVICE_KEY_SECRET to the secret holding service-account-key.json}"
    TEMPLATE_BOOT_OIDC_SCOPE="${TEMPLATE_BOOT_OIDC_SCOPE:-openid urn:zitadel:iam:org:project:id:${TEMPLATE_BOOT_OIDC_AUDIENCE}:aud}"
    TEMPLATE_BOOT_CREDENTIAL_SECRET=$TEMPLATE_BOOT_SERVICE_KEY_SECRET TEMPLATE_BOOT_CREDENTIAL_KEY=service-account-key.json
    TEMPLATE_BOOT_SERVICE_KEY_FILE=/var/run/secrets/nix/credential
  fi
  export TEMPLATE_BOOT_WORKSPACE_ID TEMPLATE_BOOT_OIDC_AUDIENCE TEMPLATE_BOOT_OIDC_SCOPE TEMPLATE_BOOT_PVC
  export TEMPLATE_BOOT_CREDENTIAL_SECRET TEMPLATE_BOOT_CREDENTIAL_KEY TEMPLATE_BOOT_SERVICE_KEY_FILE TEMPLATE_BOOT_ACCESS_TOKEN_FILE
}
