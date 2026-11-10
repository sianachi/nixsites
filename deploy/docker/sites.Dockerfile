# syntax=docker/dockerfile:1
# Sites image: the build worker (default command) and the anonymous serving process
# (override the command with src/serve/index.ts). Both run from source under Node's
# type stripping; the workspace packages they import are built by the root "prepare".
FROM node:22-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/ packages/
COPY apps/sites/ apps/sites/

RUN pnpm install --frozen-lockfile

FROM node:22-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS sites
ENV NODE_ENV=production
WORKDIR /repo/apps/sites
COPY --from=deps /repo /repo
EXPOSE 8301 8400
USER node
CMD ["node", "--experimental-strip-types", "src/worker/index.ts"]
