#!/usr/bin/env bash
# Builds the container-free release files that .github/workflows/release-artifacts.yml attaches
# to a GitHub release. Runs locally too, from the repository root:
#
#   scripts/release-artifacts.sh node <tag> <out-dir>         after pnpm install --frozen-lockfile
#   scripts/release-artifacts.sh core <tag> <out-dir> <rid>   rid: linux-x64, osx-arm64, win-x64, ...
#
# "node" ends by replacing node_modules with the production install, so run it in a checkout
# you can reinstall (CI, or a copy).
set -euo pipefail

kind="${1:?node or core}"
tag="${2:?tag}"
out="${3:?output directory}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"

case "$kind" in
  node)
    pnpm --filter @nix/web build
    cp THIRD-PARTY-NOTICES.txt apps/web/dist/
    tar -czf "$out/nix-web-$tag.tar.gz" -C apps/web/dist .

    # shortcut: sync-core ships TypeScript source, which Node will not run from node_modules;
    # the consumer bundles it. Give the package a build when something needs it unbundled.
    pnpm --filter @nix/sync-core --filter @nix/api-client exec pnpm pack --pack-destination "$out"

    # The same tree deploy/docker/node.Dockerfile ships, without the codex binary. Start with:
    #   node --experimental-strip-types apps/node-host/src/index.ts
    find . -name node_modules -type d -prune -exec rm -rf {} +
    pnpm install --prod --frozen-lockfile --ignore-scripts --offline \
      --filter "@nix/node-host..." --filter "@nix/collab..." \
      --filter "@nix/companion-service..." --filter "@nix/sites..."
    tar -czf "$out/nix-node-$tag.tar.gz" \
      package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json THIRD-PARTY-NOTICES.txt \
      node_modules packages deploy/template-sync \
      apps/collab apps/companion apps/sites apps/node-host
    ;;
  core)
    rid="${4:?runtime identifier}"
    # Without these Core still runs: search is full-text only and PDFs lack the CJK fallback.
    sh scripts/fetch-embedding-model.sh backend/models/bge-small-en-v1.5
    sh scripts/fetch-pdf-fonts.sh backend/fonts
    stage="$(mktemp -d)"
    # Both into one folder: the migrator references Core's assembly, so separate folders would
    # carry the runtime and every library twice (280 MB each).
    for project in Api Migrator; do
      # One MSBuild node: parallel nodes fail with MSB4166 on some machines.
      dotnet publish "backend/src/Nix.$project/Nix.$project.csproj" -c Release -r "$rid" --self-contained \
        -m:1 -nodeReuse:false -o "$stage"
    done
    cp THIRD-PARTY-NOTICES.txt "$stage/"
    tar -czf "$out/nix-core-$tag-$rid.tar.gz" -C "$stage" .
    rm -rf "$stage"
    ;;
  *)
    echo "unknown kind: $kind (node or core)" >&2
    exit 2
    ;;
esac

ls -lh "$out"
