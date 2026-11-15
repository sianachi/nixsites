#!/usr/bin/env bash
# Starts the Node host for local development: collaboration (8100), the pet companion (8302) and
# the sites build worker (8301) in one process. NIX_NODE_ROLES narrows it, e.g. NIX_NODE_ROLES=collab.
#
# Usage: scripts/dev-node.sh
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

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
# Local sign-in: Core is the only issuer, and its tokens carry the audience "nix".
export NIX_COLLAB_OIDC_ISSUERS="$NIX_API_ORIGIN|$NIX_API_ORIGIN/public/v1/auth/jwks"
export NIX_COLLAB_OIDC_AUDIENCE="nix"

# Pet companion (wraps codex app-server).
export NIX_COMPANION_API_URL="${NIX_COMPANION_API_URL:-$NIX_API_ORIGIN}"
export NIX_COMPANION_INTERNAL_SECRET="${NIX_COMPANION_INTERNAL_SECRET:-$internal_secret}"
export NIX_COMPANION_ADDRESS="${NIX_COMPANION_ADDRESS:-:8302}"
# Server-side pet tools (off | reads | all); the API reads Nix__Pets__ServerTools (scripts/dev-api.sh).
export NIX_COMPANION_SERVER_TOOLS="${NIX_COMPANION_SERVER_TOOLS:-off}"
export NIX_COMPANION_COLLAB_URL="${NIX_COMPANION_COLLAB_URL:-$NIX_COLLAB_ORIGIN}"
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
