#!/usr/bin/env bash
# Starts the sites build worker (apps/sites) for local development: it leases site.build,
# site.activate and site.purge jobs from Core and builds, activates and purges published sites.
#
# Usage: scripts/dev-sites-worker.sh
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

export NIX_API_PORT="${NIX_API_PORT:-5014}"
export NIX_API_ORIGIN="${NIX_API_ORIGIN:-http://localhost:${NIX_API_PORT}}"
export NIX_COLLAB_PORT="${NIX_COLLAB_PORT:-8100}"
export NIX_COLLAB_ORIGIN="${NIX_COLLAB_ORIGIN:-http://localhost:${NIX_COLLAB_PORT}}"
export NIX_SITES_API_URL="${NIX_SITES_API_URL:-$NIX_API_ORIGIN}"
# Must match Nix.Api's Nix:InternalSecret user-secret, like the other workers.
export NIX_SITES_INTERNAL_SECRET="${NIX_SITES_INTERNAL_SECRET:-nix-dev-internal}"
export NIX_SITES_COLLAB_URL="${NIX_SITES_COLLAB_URL:-$NIX_COLLAB_ORIGIN}"
export NIX_SITES_OBJECT_ORIGINS="${NIX_SITES_OBJECT_ORIGINS:-http://localhost:${VERSITY_PORT:-7070}}"
# :8302 is the Go calendar worker role in the shared dev stack.
export NIX_SITES_WORKER_ADDRESS="${NIX_SITES_WORKER_ADDRESS:-:8303}"

exec pnpm --filter @nix/sites dev:worker
