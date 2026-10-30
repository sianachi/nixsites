# syntax=docker/dockerfile:1
# Release verification tools: nixctl and the Compose smoke runner, so the production host
# needs only Docker, not Node, pnpm or a built checkout.
#
#   docker run --rm --user "$(id -u):$(id -g)" \
#     -v "$HOME/.config/nixctl/config.json:/config/nixctl/config.json:ro" \
#     -e NIXCTL_PROFILE -e NIX_SMOKE_WORKSPACE -e NIX_SMOKE_ORIGIN \
#     ghcr.io/sianachi/nix/release-tools:<sha> smoke [--preflight]
#   docker run --rm ... ghcr.io/sianachi/nix/release-tools:<sha> nixctl <args>
#
# nixctl reads $XDG_CONFIG_HOME/nixctl/config.json, so the host profile file is mounted
# read-only at /config/nixctl/config.json.
FROM node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/ packages/
COPY deploy/template-sync/ deploy/template-sync/
COPY apps/cli/ apps/cli/
COPY apps/web/package.json apps/web/
COPY apps/collab/package.json apps/collab/

# Installs the workspace and runs the root "prepare", which builds the packages nixctl imports.
RUN pnpm install --frozen-lockfile

FROM node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS release-tools
# smoke.mjs runs verify-artifact.py (python3), which uses pdftotext for the PDF content check.
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production XDG_CONFIG_HOME=/config
WORKDIR /repo
COPY --from=deps /repo /repo
COPY deploy/compose/smoke.mjs deploy/compose/nixctl.sh deploy/compose/verify-artifact.py deploy/compose/
COPY deploy/docker/release-tools-entrypoint.sh /usr/local/bin/release-tools
RUN chmod 0755 /usr/local/bin/release-tools deploy/compose/nixctl.sh \
 && mkdir -p /config/nixctl && chmod 0755 /config /config/nixctl
USER node
ENTRYPOINT ["/usr/local/bin/release-tools"]
CMD ["--help"]
