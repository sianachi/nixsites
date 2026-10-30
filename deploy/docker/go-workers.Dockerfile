# syntax=docker/dockerfile:1

FROM golang:1.26-alpine@sha256:a2012b4a1d1f9f7e9f44e0d39b805a901e856b1dd80b4e6ee4338db547050308 AS build
WORKDIR /src
COPY apps/go-workers/go.mod ./
COPY apps/go-workers ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags='-s -w' -o /out/nix-worker ./cmd/nix-worker

FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS codex
ARG CODEX_VERSION=0.153.4
RUN npm install --global @openai/codex@${CODEX_VERSION}

FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates poppler-utils util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 65532 nonroot \
    && useradd --system --uid 65532 --gid nonroot --no-create-home nonroot \
    && install -d -o nonroot -g nonroot -m 0700 /var/lib/nix-worker/spool /var/lib/nix-worker/companion
COPY --from=codex /usr/local/lib/node_modules/@openai/codex /opt/codex
# Copy the native runtime/resources for this architecture; Node is build-time only.
RUN arch="$(uname -m)" && case "$arch" in x86_64) package_arch=x64 ;; aarch64) package_arch=arm64 ;; *) exit 1 ;; esac \
    && cp -a "/opt/codex/node_modules/@openai/codex-linux-${package_arch}/vendor/${arch}-unknown-linux-musl" /opt/nix-codex \
    && ln -s /opt/nix-codex/bin/codex /usr/local/bin/codex \
    && rm -rf /opt/codex
COPY --from=build --chown=nonroot:nonroot /out/nix-worker /nix-worker
ENV TMPDIR=/var/lib/nix-worker/spool
STOPSIGNAL SIGTERM
USER 65532:65532
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=12 CMD ["/nix-worker", "--healthcheck"]
ENTRYPOINT ["/nix-worker"]
