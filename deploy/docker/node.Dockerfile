# syntax=docker/dockerfile:1
# Collaboration service image.
FROM node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/ packages/
COPY deploy/template-sync/ deploy/template-sync/
COPY apps/collab/ apps/collab/
COPY apps/web/package.json apps/web/

# Installs the workspace and runs the root "prepare", which builds every package
# collaboration imports. Skipping it leaves those packages with empty dist/ folders.
RUN pnpm install --frozen-lockfile

FROM node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS collab
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NODE_ENV=production
RUN corepack enable
WORKDIR /repo
COPY --from=deps /repo /repo
EXPOSE 8100
USER node
CMD ["pnpm", "--filter", "@nix/collab", "start"]
