# Install Nix

The short path is in the [README](../README.md#run-it-for-real). Read
[deploy/install.sh](../deploy/install.sh) before you run it. This page is the rest of that install:
what the script does, the flags, upgrades, Kubernetes and image tags.

## Try it on your machine

Needs Docker with the Compose plugin, `curl`, `openssl`, `jq`, and about 8 GB of memory for
Docker. The stack runs Postgres, RabbitMQ, an object store, the identity provider and five Nix
services (API, collaboration, web, and the import and plugin
workers). A default Docker Desktop VM is often 2 to 4 GB, and a smaller limit thrashes. The script
stops if a tool is missing, and warns when Docker has less than about 8 GB.

```sh
curl -fsSL https://raw.githubusercontent.com/sianachi/nixsites/main/deploy/install.sh | bash
```

Then open <http://nix.localhost> in Chrome or Firefox and sign in with the details it prints.
Safari does not resolve `.localhost` names: add `127.0.0.1 nix.localhost auth.nix.localhost` to
`/etc/hosts` first.

## Install for real

The same line with a public origin is a real install, from the CI-built multi-architecture images
at `ghcr.io/sianachi/nix`:

```sh
curl -fsSL https://raw.githubusercontent.com/sianachi/nixsites/main/deploy/install.sh | bash -s -- https://nix.example.org
```

**Before you run it:** point `nix.example.org` and `auth.nix.example.org` at the machine and leave
ports 80 and 443 free. The tools and the 8 GB of Docker memory are the same as the try-out above.

## What it does

The installer generates every secret into `~/nix/nix.env`, starts Postgres, RabbitMQ, the object
store and a bundled identity provider (Zitadel) behind Caddy, which fetches the TLS certificates
itself; registers the web application with the identity provider; runs the database migrations;
starts every service; prints the administrator sign-in (`admin@nix.auth.<host>` and a one-time
password you must change at first sign-in).

Back up `~/nix/nix.env` together with the Docker volumes (`nix-*`). The env file holds every secret
and cannot be regenerated.

## Options

| Flag | Meaning |
| --- | --- |
| `--version vX.Y.Z` | Install that release instead of the latest; the same flag upgrades a running install. A full commit SHA is also accepted |
| `--dir <path>` | State directory (default `~/nix`) |
| `--kubernetes` | Install into the current `kubectl` context (namespace `nix`) instead of Docker |
| `--ingress-class <name>` | Kubernetes: IngressClass. Default is the first one on the cluster |
| `--storage-class <name>` | Kubernetes: StorageClass. Default is the cluster default |
| `--pod-cidr <cidr>` | Kubernetes: pod network. Default is the first node's pod CIDR |
| `--tls-cert` / `--tls-key <file>` | Kubernetes: a PEM pair covering `<host>` and `*.<host>` |
| `--cluster-issuer <name>` | Kubernetes: cert-manager issuer. No wildcard then, so published sites need DNS-01 |

The header of [deploy/install.sh](../deploy/install.sh) is the source for these flags, including
`--ingress-service` for a Kubernetes `.localhost` try-out.

## Upgrade

Run the same line again with `--version <newer release>`. The env file is kept, migrations run, and
services restart on the new images. Back up `~/nix/nix.env` together with the Docker volumes
(`nix-*`); the env file holds every secret and cannot be regenerated.

## Signing in from the iOS app

The iOS app refuses any `http://` address, including one hop in the middle of the sign-in
redirects; the sign-in page then fails with an App Transport Security error. Desktop browsers
often upgrade that hop silently, so the web app can look fine while the phone cannot sign in.
Check the chain from `/auth/login` with `curl -sI` and follow each `location` until it reaches
the sign-in form: every hop must be `https://`.

The bundled install is https end to end. The usual cause is an identity provider of your own
behind a tunnel or proxy that reaches it over plain http. Zitadel's separate login UI
(`/ui/v2/login`) builds its redirects from `X-Forwarded-Proto`, and Traefik replaces that header
with `http` on a plain entrypoint unless it trusts the sender. Set the header on the login
router, for example with Traefik Docker labels:

```yaml
traefik.http.middlewares.login-proto.headers.customrequestheaders.X-Forwarded-Proto: https
traefik.http.routers.<login-router>.middlewares: login-proto
```

or list the tunnel or proxy addresses in the entrypoint's `forwardedHeaders.trustedIPs`.

## Kubernetes

```sh
curl -fsSL https://raw.githubusercontent.com/sianachi/nixsites/main/deploy/install.sh | bash -s -- --kubernetes https://nix.example.org
```

The cluster needs an ingress controller listening on the origin's port and a default StorageClass.
The installer reads the IngressClass, StorageClass and pod CIDR from the cluster (`--ingress-class`,
`--storage-class`, `--pod-cidr` override). Certificates: pass `--tls-cert`/`--tls-key` with a PEM
pair covering `<host>` and `*.<host>`, or `--cluster-issuer <name>` for cert-manager (no wildcard
then, so published sites need DNS-01), or let it make a self-signed pair for a try-out. State is
`~/nix/kubernetes.env` plus the secrets in the namespace. The manifests are in
[deploy/k8s](../deploy/k8s).

Operating an install by hand, after the installer or instead of it, is covered in
[deploy/README.md](../deploy/README.md).

## Images and tags

Every commit on `main` is published as `ghcr.io/sianachi/nix/<image>:<sha>`. The images are `api`,
`migrator`, `collab`, `worker`, `web`, `sites` and `release-tools`. Pushing a `vX.Y.Z` tag names
that commit's images `vX.Y.Z` and `latest`, which the installer uses by default. `--version` also
accepts a full commit SHA.

Published packages are listed on the [repository packages page](https://github.com/sianachi/nixsites/packages).
