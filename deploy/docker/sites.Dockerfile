# syntax=docker/dockerfile:1
# Sites image: the build worker (default command) and the anonymous serving process
# (override the command with src/serve/index.ts). Both run from source under Node's
# type stripping; the workspace packages they import are built by the root "prepare".
FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json THIRD-PARTY-NOTICES.txt ./
COPY packages/ packages/
COPY apps/sites/ apps/sites/

RUN pnpm install --frozen-lockfile
# The packages are built; reinstall with only what runs. This drops the development tools.
RUN find . -name node_modules -type d -prune -exec rm -rf {} + \
 && pnpm install --prod --frozen-lockfile --ignore-scripts --offline --filter "@nix/sites..."

FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS sites
ENV NODE_ENV=production
WORKDIR /repo/apps/sites
COPY --from=deps /repo /repo
EXPOSE 8301 8400
USER node
CMD ["node", "--experimental-strip-types", "src/worker/index.ts"]
