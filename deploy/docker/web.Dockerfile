# syntax=docker/dockerfile:1
FROM node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/ packages/
COPY apps/web/ apps/web/
COPY apps/collab/package.json apps/collab/
RUN pnpm install --frozen-lockfile

RUN pnpm --filter @nix/web build

FROM caddy:2-alpine@sha256:e70b164da81ef698b3ad19af799ea6086ce6d9e48ed4079eb9fe26f6fbf14ee5 AS web
COPY --from=build /repo/apps/web/dist /srv/nix/web
# The Caddyfile arrives from a ConfigMap at /etc/caddy/Caddyfile (deploy/k8s/Caddyfile),
# so proxy targets can change without a rebuild.
EXPOSE 8090
