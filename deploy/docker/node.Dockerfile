# syntax=docker/dockerfile:1
# Node host image: collaboration, the pet companion and the sites worker run in one process
# (apps/node-host, roles chosen by NIX_NODE_ROLES). The image keeps the name "collab".
FROM node:22-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/ packages/
COPY deploy/template-sync/ deploy/template-sync/
COPY apps/collab/ apps/collab/
COPY apps/companion/ apps/companion/
COPY apps/sites/ apps/sites/
COPY apps/node-host/ apps/node-host/
COPY apps/web/package.json apps/web/

# Installs the workspace and runs the root "prepare", which builds every package
# collaboration imports. Skipping it leaves those packages with empty dist/ folders.
RUN pnpm install --frozen-lockfile

FROM node:22-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS codex
ARG CODEX_VERSION=0.153.4
RUN npm install --global @openai/codex@${CODEX_VERSION}
# Keep only the native runtime for this architecture; Node is build-time only here.
RUN arch="$(uname -m)" && case "$arch" in x86_64) package_arch=x64 ;; aarch64) package_arch=arm64 ;; *) exit 1 ;; esac \
    && cp -a "/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-${package_arch}/vendor/${arch}-unknown-linux-musl" /opt/nix-codex

FROM node:22-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS collab
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NODE_ENV=production
RUN corepack enable
WORKDIR /repo
COPY --from=deps /repo /repo
COPY --from=codex /opt/nix-codex /opt/nix-codex
RUN ln -s /opt/nix-codex/bin/codex /usr/local/bin/codex
EXPOSE 8100 8301 8302
USER node
# One migration command still runs from this image: pnpm --filter @nix/collab migrate-documents.
CMD ["node", "--experimental-strip-types", "apps/node-host/src/index.ts"]
