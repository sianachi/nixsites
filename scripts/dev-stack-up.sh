#!/usr/bin/env bash
# Bring up the whole local dev stack: infra, schema, Zitadel, seed data.
#
# The cold-start sequence described by the historical native docs/dev-signing-in.md
# note, as one command. Every step here is independently idempotent (seed.sh and
# zitadel-configure.sh say so in their own header comments; EF Core migrations
# no-op on an up-to-date schema; `docker compose up -d` no-ops on running
# containers), so this is safe to run before every "Full Stack" launch, not
# only on a cold machine.
#
# Usage: scripts/dev-stack-up.sh
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

docker compose -f deploy/compose.dev.yml --profile core up -d
export NIX_OBJECT_STORE_ENDPOINT="${NIX_OBJECT_STORE_ENDPOINT:-http://localhost:${VERSITY_PORT:-7070}}"
export NIX_OBJECT_STORE_REGION="${NIX_OBJECT_STORE_REGION:-us-east-1}"
export NIX_OBJECT_STORE_BUCKET="${NIX_OBJECT_STORE_BUCKET:-nix-worker-jobs}"
export NIX_OBJECT_STORE_ACCESS_KEY="${NIX_OBJECT_STORE_ACCESS_KEY:-${VERSITY_ROOT_ACCESS_KEY:-nix-dev-access}}"
export NIX_OBJECT_STORE_SECRET_KEY="${NIX_OBJECT_STORE_SECRET_KEY:-${VERSITY_ROOT_SECRET_KEY:-nix-dev-secret-key}}"
node --experimental-strip-types scripts/ensure-dev-object-store.mts
deploy/seed/seed.sh
scripts/dev-migrate.sh
scripts/fetch-embedding-model.sh   # pet retrieval's local model; full-text only without it
deploy/seed/zitadel-configure.sh
deploy/seed/seed.sh   # second pass: the schema exists now, seeds tenants + identity_provider

echo "dev-stack-up: start Core (scripts/dev-api.sh), Collaboration (scripts/dev-collab.sh), the Go worker (scripts/dev-worker.sh), the sites worker and server (scripts/dev-sites-worker.sh, scripts/dev-sites-serve.sh), and web (pnpm --filter @nix/web dev)"
