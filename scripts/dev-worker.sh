#!/usr/bin/env bash
# Starts the local pet companion host (the Go process that wraps codex app-server).
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root/apps/go-workers"

export NIX_API_PORT="${NIX_API_PORT:-5014}"
export NIX_API_ORIGIN="${NIX_API_ORIGIN:-http://localhost:${NIX_API_PORT}}"
export NIX_WORKER_API_URL="${NIX_WORKER_API_URL:-$NIX_API_ORIGIN}"
export NIX_WORKER_INTERNAL_SECRET="${NIX_WORKER_INTERNAL_SECRET:-nix-dev-internal}"
export NIX_WORKER_ADDRESS="${NIX_WORKER_ADDRESS:-:8301}"
export NIX_COMPANION_DATA_DIR="${NIX_COMPANION_DATA_DIR:-$repo_root/.local/companion}"
# Local development keeps the full-content pet trace on, so a misbehaving pet can be debugged
# from <data dir>/<account>/traces/*.jsonl. It is off unless set anywhere else.
# traces/ holds private workspace content and may hold provider credentials: never share it.
export NIX_COMPANION_TRACE="${NIX_COMPANION_TRACE:-true}"

exec go run ./cmd/nix-worker
