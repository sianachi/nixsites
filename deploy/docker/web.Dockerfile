# syntax=docker/dockerfile:1
FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/ packages/
COPY apps/web/ apps/web/
COPY apps/collab/package.json apps/collab/
RUN pnpm install --frozen-lockfile

RUN pnpm --filter @nix/web build

FROM caddy:2-alpine@sha256:78bd35025c7ba85961dd149ae670315129954e77abe2383ac47c89106b35ade9 AS web
COPY --from=build /repo/apps/web/dist /srv/nix/web
# Served at /THIRD-PARTY-NOTICES.txt: the bundle goes to every browser that loads it.
COPY THIRD-PARTY-NOTICES.txt /srv/nix/web/
# The Caddyfile arrives from a ConfigMap at /etc/caddy/Caddyfile (deploy/k8s/Caddyfile),
# so proxy targets can change without a rebuild.
EXPOSE 8090
