#!/usr/bin/env bash
# Starts Core with the local Zitadel client, BFF session policy and Core signing key.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

dev_state_dir="${NIX_DEV_STATE_DIR:-$repo_root/deploy}"
oidc_env="$dev_state_dir/.zitadel/oidc.generated.env"
if [ ! -f "$oidc_env" ]; then
  echo "dev-api: $oidc_env not found - run scripts/dev-stack-up.sh first" >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$oidc_env"

signing_key="$dev_state_dir/.dev-access-token-key.pem"
if [ ! -f "$signing_key" ]; then
  openssl ecparam -name prime256v1 -genkey -noout -out "$signing_key"
  chmod 600 "$signing_key"
fi
mkdir -p "$dev_state_dir/.dev-data-protection"

export ConnectionStrings__Nix="${ConnectionStrings__Nix:-Host=localhost;Port=5433;Database=nix;Username=nix_app;Password=nix-dev-app}"
export Nix__InternalSecret="${Nix__InternalSecret:-nix-dev-internal}"
export Nix__Pets__WorkerUrl="${Nix__Pets__WorkerUrl:-http://localhost:8301}"
export Nix__ObjectStorage__Endpoint="${Nix__ObjectStorage__Endpoint:-http://localhost:${VERSITY_PORT:-7070}}"
export Nix__ObjectStorage__Region="${Nix__ObjectStorage__Region:-us-east-1}"
export Nix__ObjectStorage__Bucket="${Nix__ObjectStorage__Bucket:-nix-worker-jobs}"
export Nix__ObjectStorage__AccessKey="${Nix__ObjectStorage__AccessKey:-${VERSITY_ROOT_ACCESS_KEY:-nix-dev-access}}"
export Nix__ObjectStorage__SecretKey="${Nix__ObjectStorage__SecretKey:-${VERSITY_ROOT_SECRET_KEY:-nix-dev-secret-key}}"
# Sites stay off locally unless you opt in: Nix__Sites__Enabled=true pnpm dev
export Nix__Sites__Enabled="${Nix__Sites__Enabled:-false}"
export Nix__Sites__Domain="${Nix__Sites__Domain:-sites.localhost}"
export Nix__Sites__Bucket="${Nix__Sites__Bucket:-nix-sites}"
export Nix__Sites__PublicScheme="${Nix__Sites__PublicScheme:-http}"
export Nix__Sites__PublicPort="${Nix__Sites__PublicPort:-8400}"
export NIX_API_PORT="${NIX_API_PORT:-5014}"
export NIX_API_ORIGIN="${NIX_API_ORIGIN:-http://localhost:${NIX_API_PORT}}"
export NIX_WEB_PORT="${NIX_WEB_PORT:-5173}"
export NIX_WEB_ORIGIN="${NIX_WEB_ORIGIN:-http://localhost:${NIX_WEB_PORT}}"
export NIX_COLLAB_PORT="${NIX_COLLAB_PORT:-8100}"
export NIX_COLLAB_ORIGIN="${NIX_COLLAB_ORIGIN:-http://localhost:${NIX_COLLAB_PORT}}"
export Nix__Collaboration__BaseUrl="${Nix__Collaboration__BaseUrl:-$NIX_COLLAB_ORIGIN}"
export Nix__Bff__Authority="$NIX_OIDC_ISSUER"
export Nix__Bff__ClientId="$NIX_OIDC_CLIENT_ID"
export Nix__Bff__PublicOrigin="$NIX_WEB_ORIGIN"
export Nix__Bff__AccountPage="${Nix__Bff__AccountPage:-$NIX_OIDC_ISSUER/ui/console/users/me?id=security}"
export Nix__Bff__DataProtectionKeysPath="$dev_state_dir/.dev-data-protection"
export Nix__AccessTokens__Issuer="$NIX_API_ORIGIN"
export Nix__AccessTokens__Audience="nix"
export Nix__AccessTokens__KeyId="nix-dev-access-tokens"
export Nix__AccessTokens__SigningKeyPemFile="$signing_key"

export ASPNETCORE_ENVIRONMENT="${ASPNETCORE_ENVIRONMENT:-Development}"

exec dotnet run --project backend/src/Nix.Api --no-launch-profile --urls "$NIX_API_ORIGIN"
