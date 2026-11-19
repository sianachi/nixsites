# Install in one line

# Install in one line

The quickest way to run Nix is one command. With no argument it is a try-out on your own machine; with a public origin it is a real install. Both use the same images CI publishes for every release.

## Try it on your machine

All you need is Docker (with the Compose plugin) with at least 1 GB of memory, plus `curl`, `openssl` and `jq`. The installer stops if a tool is missing and warns when Docker has less than about 0.75 GiB. For larger groups see [Requirements](nix://item/01a130b0-164c-73bf-b5ab-88cfdaa34bcc).

```sh
curl -fsSL https://raw.githubusercontent.com/sianachi/nixsites/main/deploy/install.sh | bash
```

Then open `http://nix.localhost` in Chrome or Firefox, go to the setup page the installer prints and enter the setup code. Safari does not resolve `.localhost` names on its own: add `127.0.0.1 nix.localhost` to `/etc/hosts` first.

Inside a container `localhost` is the container itself, which is why the try-out uses the reserved `.localhost` domain that browsers treat as loopback.

## Install for real

Point `nix.example.org` at the machine, leave ports 80 and 443 free, and run the same line with the origin:

```sh
curl -fsSL https://raw.githubusercontent.com/sianachi/nixsites/main/deploy/install.sh | bash -s -- https://nix.example.org
```

The installer:

1. generates every secret into `~/nix/nix.env`;
2. starts PostgreSQL and the object store behind Caddy, which fetches the TLS certificates itself;
3. runs the database migrations;
4. starts every service, including the remote MCP service, and prints the address of the setup page with a setup code.

Open `<origin>/setup`, enter the setup code (`NIX_AUTH_SETUP_CODE` in `nix.env`), your email, name and a password. That account is the administrator, and the page closes once an account exists. Add other people from People in the settings: each gets a one-time link, valid for one hour, to choose a password or register a passkey. Nothing is emailed.

Remote MCP is always on at `<origin>/mcp`. An AI client connects with a personal access token, or a hosted connector such as Claude or ChatGPT signs in through the browser with OAuth. Hosted connectors need the public https origin, since they cannot reach a `.localhost` try-out.

Back up `~/nix/nix.env` together with the Docker volumes (`nix-*`). The env file holds every secret and cannot be regenerated.

## Upgrade

Run the same line again with `--version vX.Y.Z`. The env file is kept, migrations run, and services restart on the new images. The installer defaults to the latest release; `--version` also accepts a full commit SHA.

## Options

| Flag | Meaning |
| --- | --- |
| \--version \<tag or sha> | The release to install or upgrade to (default: the latest release) |
| \--dir \<path> | The state directory (default \~/nix) |
| \--kubernetes | Install into the current kubectl context (namespace nix) instead of Docker |
| \--migrate-local-auth | Move an install that used the old bundled Zitadel onto Nix's own sign-in (Docker only). Add --dry-run to report what would move and change nothing |

## Kubernetes

With `--kubernetes` the installer drives the manifests in `deploy/k8s` into the current `kubectl` context. The cluster needs an ingress controller listening on the origin's port and a default StorageClass; the installer reads the IngressClass, StorageClass and pod CIDR from the cluster (`--ingress-class`, `--storage-class` and `--pod-cidr` override). For certificates, pass `--tls-cert` and `--tls-key` with a PEM pair covering `<host>` and `*.<host>`, or `--cluster-issuer <name>` for cert-manager (no wildcard then, so published sites need DNS-01), or let it make a self-signed pair for a try-out. The installer deploys no identity provider; the setup code is printed at the end and kept as `setup-code` in the `nix-auth` secret. State is `~/nix/kubernetes.env` plus the secrets in the namespace. See [Kubernetes](nix://item/01a13137-c1a1-7f79-bfe5-4e7cad094458) for what the manifests create.

## Moving off the old bundled Zitadel

Earlier versions of the installer bundled Zitadel for sign-in. This version no longer includes, starts or upgrades it, so an install that still uses it must move before it can upgrade, and the installer stops until you do. Accounts, password hashes, authenticator apps and passkeys come across onto the same people, so their items, sessions and access tokens survive. Zitadel's own sessions, SMS and email codes, links to outside logins and machine users do not (create access tokens instead).

- **Docker, installer.** Run the installer with `--migrate-local-auth`, adding `--dry-run` first to see what would move. It stops and lists the accounts when two share an email address. It stops the old Zitadel containers and keeps them and their volumes until you remove them.
- **Docker, release scripts.** If Zitadel runs as its own Compose project next to an install made with `deploy/compose/release.sh`, run `deploy/compose/import-zitadel.sh --dry-run`, then without the flag, and switch the env file to `NIX_AUTH_MODE=local`.
- **Kubernetes.** Run `deploy/k8s/deploy.sh` with `NIX_IMPORT_ZITADEL=dry-run`, then with `NIX_AUTH_MODE=local NIX_IMPORT_ZITADEL=run`. The old Zitadel Deployment is scaled to zero, not deleted.

Passkeys were registered for the old `auth.<host>` name, so keep its DNS record: Nix answers only `/.well-known/webauthn` there. The importer supports only Zitadel v4.16.1. An install that already signs in through an identity provider you run yourself is not affected.

## When to use the scripts instead

The installer is the right tool for a new machine or cluster. An existing deployment that you operate by hand, with its own tunnel or release ledger, keeps using the release scripts described under [Docker Compose](nix://item/01a130b0-156d-7ac6-99ed-ebee0b7d7dfe) and [Upgrades](nix://item/01a130b0-16c2-776e-89d2-b80f0e28db40).

## Properties

- title: Install in one line

