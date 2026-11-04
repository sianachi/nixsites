#!/usr/bin/env bash
# Starts the Node host for local development: collaboration (8100), the pet companion (8302) and
# the sites build worker (8301) in one process, wired to whatever Zitadel client/project id this
# machine's dev stack currently has. NIX_NODE_ROLES narrows it, e.g. NIX_NODE_ROLES=collab.
#
# Collab needs NIX_COLLAB_OIDC_AUDIENCE built from two values (NIX_OIDC_CLIENT_ID and
# NIX_OIDC_PROJECT_ID) that zitadel-configure.sh writes under different names, so this script
# remaps them and then hands off to the host's own dev script.
#
# Usage: scripts/dev-node.sh
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

oidc_env="deploy/.zitadel/oidc.generated.env"
if [ ! -f "$oidc_env" ]; then
  echo "dev-node: $oidc_env not found - run scripts/dev-stack-up.sh first" >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$oidc_env"

export NIX_API_PORT="${NIX_API_PORT:-5014}"
export NIX_API_ORIGIN="${NIX_API_ORIGIN:-http://localhost:${NIX_API_PORT}}"
# Must match Nix.Api's Nix:InternalSecret user-secret (see README's Debugging section).
internal_secret="${NIX_INTERNAL_SECRET:-nix-dev-internal}"

# Collaboration.
export NIX_COLLAB_DATABASE_URL="${NIX_COLLAB_DATABASE_URL:-postgresql://nix_collab:nix-dev-collab@localhost:5433/nix}"
export NIX_COLLAB_PORT="${NIX_COLLAB_PORT:-8100}"
export NIX_COLLAB_ORIGIN="${NIX_COLLAB_ORIGIN:-http://localhost:${NIX_COLLAB_PORT}}"
export NIX_COLLAB_CORE_BASE_URL="${NIX_COLLAB_CORE_BASE_URL:-$NIX_API_ORIGIN}"
export NIX_COLLAB_INTERNAL_SECRET="${NIX_COLLAB_INTERNAL_SECRET:-$internal_secret}"
export NIX_COLLAB_OIDC_ISSUERS="$NIX_OIDC_ISSUER,$NIX_API_ORIGIN|$NIX_API_ORIGIN/public/v1/auth/jwks"
export NIX_COLLAB_OIDC_AUDIENCE="$NIX_OIDC_CLIENT_ID,$NIX_OIDC_PROJECT_ID,nix"

# Pet companion (wraps codex app-server).
export NIX_COMPANION_API_URL="${NIX_COMPANION_API_URL:-$NIX_API_ORIGIN}"
export NIX_COMPANION_INTERNAL_SECRET="${NIX_COMPANION_INTERNAL_SECRET:-$internal_secret}"
export NIX_COMPANION_ADDRESS="${NIX_COMPANION_ADDRESS:-:8302}"
export NIX_COMPANION_DATA_DIR="${NIX_COMPANION_DATA_DIR:-$repo_root/.local/companion}"
# Local development keeps the full-content pet trace on, so a misbehaving pet can be debugged
# from <data dir>/<account>/traces/*.jsonl. It is off unless set anywhere else.
# traces/ holds private workspace content and may hold provider credentials: never share it.
export NIX_COMPANION_TRACE="${NIX_COMPANION_TRACE:-true}"

# Sites build worker: leases site.build, site.activate and site.purge jobs from Core.
export NIX_SITES_API_URL="${NIX_SITES_API_URL:-$NIX_API_ORIGIN}"
export NIX_SITES_INTERNAL_SECRET="${NIX_SITES_INTERNAL_SECRET:-$internal_secret}"
export NIX_SITES_COLLAB_URL="${NIX_SITES_COLLAB_URL:-$NIX_COLLAB_ORIGIN}"
export NIX_SITES_OBJECT_ORIGINS="${NIX_SITES_OBJECT_ORIGINS:-http://localhost:${VERSITY_PORT:-7070}}"
export NIX_SITES_WORKER_ADDRESS="${NIX_SITES_WORKER_ADDRESS:-:8301}"

exec pnpm --filter @nix/node-host dev
