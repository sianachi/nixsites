# syntax=docker/dockerfile:1
# Browser processing has its own image and receives only its dedicated ingress secret.
FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS browser
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json THIRD-PARTY-NOTICES.txt ./
COPY apps/browser-worker/package.json apps/browser-worker/
RUN pnpm --filter @nix/browser-worker install --prod --ignore-scripts --frozen-lockfile \
 && pnpm --filter @nix/browser-worker exec playwright install --with-deps --no-shell chromium \
 && chmod -R a+rX /ms-playwright \
 && rm -rf /var/lib/apt/lists/*
COPY apps/browser-worker/ apps/browser-worker/
ENV NIX_BROWSER_LISTEN=0.0.0.0:8313
EXPOSE 8313
USER node
CMD ["node", "--experimental-strip-types", "apps/browser-worker/src/index.ts"]
