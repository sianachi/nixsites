# syntax=docker/dockerfile:1
# Node host image: collaboration, the pet companion and the sites worker run in one process
# (apps/node-host, roles chosen by NIX_NODE_ROLES). The image keeps the name "collab".
FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json THIRD-PARTY-NOTICES.txt ./
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
# The packages are built; reinstall with only what the three services run on. This drops the
# development tools and the web app's dependencies (about 600 MB).
RUN find . -name node_modules -type d -prune -exec rm -rf {} + \
 && pnpm install --prod --frozen-lockfile --ignore-scripts --offline \
      --filter "@nix/node-host..." --filter "@nix/collab..." \
      --filter "@nix/companion-service..." --filter "@nix/sites..."

FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS collab
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NODE_ENV=production
RUN corepack enable
WORKDIR /repo
COPY --from=deps /repo /repo
EXPOSE 8100 8301 8302
USER node
# One migration command still runs from this image: pnpm --filter @nix/collab migrate-documents.
CMD ["node", "--experimental-strip-types", "apps/node-host/src/index.ts"]
