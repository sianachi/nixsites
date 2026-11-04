# Install in one line

# Install in one line

The quickest way to run Nix is one command. With no argument it is a try-out on your own machine; with a public origin it is a real install. Both use the same images CI publishes for every release.

## Try it on your machine

All you need is Docker (with the Compose plugin), plus `curl`, `openssl` and `jq`:

```sh
curl -fsSL https://raw.githubusercontent.com/sianachi/nixsites/main/deploy/install.sh | bash
```

Then open `http://nix.localhost` in Chrome or Firefox and sign in with the details the installer prints. Safari does not resolve `.localhost` names on its own: add `127.0.0.1 nix.localhost auth.nix.localhost` to `/etc/hosts` first.

Inside a container `localhost` is the container itself, which is why the try-out uses the reserved `.localhost` domain that browsers treat as loopback.

## Install for real

Point `nix.example.org` and `auth.nix.example.org` at the machine, leave ports 80 and 443 free, and run the same line with the origin:

```sh
curl -fsSL https://raw.githubusercontent.com/sianachi/nixsites/main/deploy/install.sh | bash -s -- https://nix.example.org
```

The installer:

1. generates every secret into `~/nix/nix.env`;
2. starts PostgreSQL, the object store and a bundled identity provider (Zitadel) behind Caddy, which fetches the TLS certificates itself;
3. registers the web application with the identity provider;
4. runs the database migrations and the identity bootstrap;
5. starts every service and prints the administrator sign-in: `admin@nix.auth.<host>` and a one-time password you must change at first sign-in.

Back up `~/nix/nix.env` together with the Docker volumes (`nix-*`). The env file holds every secret and cannot be regenerated.

## Upgrade

Run the same line again with `--version vX.Y.Z`. The env file is kept, migrations run, and services restart on the new images. The installer defaults to the latest release; `--version` also accepts a full commit SHA.

## Options

| Flag | Meaning |
| --- | --- |
| \--version \<tag or sha> | The release to install or upgrade to (default: the latest release) |
| \--dir \<path> | The state directory (default \~/nix) |
| \--kubernetes | Install into the current kubectl context (namespace nix) instead of Docker |

## Kubernetes

With `--kubernetes` the installer drives the manifests in `deploy/k8s` into the current `kubectl` context. The cluster needs an ingress controller listening on the origin's port and a default StorageClass; the installer reads the IngressClass, StorageClass and pod CIDR from the cluster (`--ingress-class`, `--storage-class` and `--pod-cidr` override). For certificates, pass `--tls-cert` and `--tls-key` with a PEM pair covering `<host>` and `*.<host>`, or `--cluster-issuer <name>` for cert-manager (no wildcard then, so published sites need DNS-01), or let it make a self-signed pair for a try-out. State is `~/nix/kubernetes.env` plus the secrets in the namespace. See [Kubernetes](nix://item/01a13137-c1a1-7f79-bfe5-4e7cad094458) for what the manifests create.

## When to use the scripts instead

The installer is the right tool for a new machine or cluster. An existing deployment that you operate by hand, with its own identity provider, tunnel or release ledger, keeps using the release scripts described under [Docker Compose](nix://item/01a130b0-156d-7ac6-99ed-ebee0b7d7dfe) and [Upgrades](nix://item/01a130b0-16c2-776e-89d2-b80f0e28db40).

## Properties

- title: Install in one line

