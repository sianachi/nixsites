# Install Nix

The short path is in the [README](../README.md#run-it-for-real). Read
[deploy/install.sh](../deploy/install.sh) before you run it. This page is the rest of that install:
what the script does, the flags, upgrades, Kubernetes and image tags.

## Try it on your machine

Needs Docker with the Compose plugin, `curl`, `openssl`, `jq`, and about 4 GB of memory for
Docker. The stack runs Postgres, an object store and three Nix
services (API, web, and one Node service for collaboration, the pet
companion and the sites worker). A default Docker Desktop VM can be as small as 2 GB, which is too little. The script
stops if a tool is missing, and warns when Docker has less than about 4 GB.

```sh
curl -fsSL https://raw.githubusercontent.com/sianachi/nixsites/main/deploy/install.sh | bash
```

Then open <http://nix.localhost> in Chrome or Firefox, go to the setup page the script prints and
enter the setup code. Safari does not resolve `.localhost` names: add `127.0.0.1 nix.localhost` to
`/etc/hosts` first.

## Install for real

The same line with a public origin is a real install, from the CI-built multi-architecture images
at `ghcr.io/sianachi/nix`:

```sh
curl -fsSL https://raw.githubusercontent.com/sianachi/nixsites/main/deploy/install.sh | bash -s -- https://nix.example.org
```

**Before you run it:** point `nix.example.org` at the machine and leave ports 80 and 443 free. That
is the only hostname a new install needs. The tools and the 4 GB of Docker memory are the same as
the try-out above.

## What it does

The installer generates every secret into `~/nix/nix.env`, starts Postgres and the object
store behind Caddy, which fetches the TLS certificates itself, runs the database migrations, starts
every service and prints the address of the setup page with a setup code.

Back up `~/nix/nix.env` together with the Docker volumes (`nix-*`). The env file holds every secret
and cannot be regenerated.

## Signing in

Nix signs people in itself. Nobody can sign up on their own; accounts come from two places.

- **The first account.** Open the setup page the installer printed (`<origin>/setup`), enter the
  setup code (`NIX_AUTH_SETUP_CODE` in `nix.env`), your email, name and a password. That account
  is the administrator. The page closes once an account exists.
- **Adding people.** An administrator opens People in the settings, enters an email and a name and
  gets a one-time link to send them. The link is valid for one hour and works once. The person
  opens it and chooses a password or registers a passkey. Nothing is emailed: you send the link.

The email address is the sign-in name, and it is unique across the install. Passwords are at least
10 characters. A passkey is a full sign-in on its own, and a person who has one can remove their
password. An authenticator app (a six-digit code) is asked for after the password. Ten wrong
passwords in five minutes pause that account's sign-in for five minutes.

**Reset.** An administrator issues a new link from the People page, after entering their own
password; using it signs the person out everywhere. Nobody can issue a link for themselves. If the only administrator is locked out, run this on the host and send the link it
prints:

```sh
docker compose -p nix --env-file ~/nix/nix.env -f <release>/deploy/compose.prod.yml \
  -f <release>/deploy/compose.quickstart.yml run --rm --no-deps nix-migrate \
  account reset-link --email you@example.org
```

Each person manages their own passwords, passkeys and authenticator app under Settings > Security,
and can sign out of every device there. Scripts and tools use access tokens
(`account service-token --name <name>` on the host creates one without a person's account).

### Moving an install off the bundled Zitadel

Installs made before this change use Zitadel for sign-in and keep doing so; running the installer
again changes nothing about that. To move one onto Nix's own sign-in:

```sh
curl -fsSL https://raw.githubusercontent.com/sianachi/nixsites/main/deploy/install.sh \
  | bash -s -- --migrate-local-auth --dry-run https://nix.example.org   # report only
curl -fsSL https://raw.githubusercontent.com/sianachi/nixsites/main/deploy/install.sh \
  | bash -s -- --migrate-local-auth https://nix.example.org
```

It supports only the Zitadel version the installer bundled (v4.16.1) and refuses any other. It
moves accounts and profiles, verified-email state, password hashes, authenticator apps, passkeys and
second-step security keys onto the existing people, so their items, sessions and access tokens
survive. It stops and lists the accounts when two share an email address. Not moved: Zitadel's own
sessions, SMS and email codes, links to outside logins, and machine users (create access tokens
instead).

Passkeys were registered for the old `auth.<host>` name, so that name stays the passkey hostname.
The web server keeps answering on it, serving only `/.well-known/webauthn`, so keep its DNS record.
Browsers that do not support related origins fall back to the password.

Zitadel's volumes are left as they are. To roll back, copy `~/nix/nix.env.pre-local-auth` back over
`~/nix/nix.env` and run the installer again; it starts the Zitadel containers again.

### Moving a Compose install off a Zitadel you run yourself

This is for an install made with `deploy/compose/release.sh` whose Zitadel runs as its own Compose
project next to it. Run the steps on the host. Zitadel must be v4.16.1; the import refuses any
other version.

1. Release a version that has local sign-in, as usual, so Nix's schema is current. Sign-in stays
   on Zitadel until you change the env file.
2. Set `NIX_DEPLOY_ENV` (the env file), `NIX_IMAGE_TAG` (the release you just made),
   `NIX_AUTH_PASSKEY_RP_ID` (the identity provider's public hostname, for example
   `auth.example.org`), and the Zitadel database password and master key as
   `NIX_ZITADEL_DB_PASSWORD` and `NIX_ZITADEL_MASTERKEY`, or as files named by `..._FILE`.
   The script finds the Zitadel database container as `backup.sh` does; set
   `NIX_ZITADEL_DB_CONTAINER`, `NIX_ZITADEL_DB_NAME` or `NIX_ZITADEL_DB_USER` if yours differ.
3. See what would move, then move it:

   ```sh
   bash deploy/compose/import-zitadel.sh --dry-run
   bash deploy/compose/import-zitadel.sh
   ```

   It stops and lists the accounts when two share an email address. Zitadel is only read.
4. In the env file, set `NIX_AUTH_MODE=local`, `NIX_AUTH_PASSKEY_RP_ID` to the same hostname,
   empty `NIX_OIDC_ISSUER` and `NIX_OIDC_CLIENT_ID`, `NIX_COLLAB_OIDC_ISSUERS` to
   `<NIX_CORE_TOKEN_ISSUER>|http://nix-api:8080/public/v1/auth/jwks`, and
   `NIX_COLLAB_OIDC_AUDIENCE` to `NIX_CORE_TOKEN_AUDIENCE`. Run the release again.

Passkeys were registered for the identity provider's hostname, so that name stays the passkey
hostname. Point exactly `/.well-known/webauthn` on it at Nix's web service (any Host header is
accepted there). You can retire the rest of that hostname's routes. Browsers that do not support
related origins fall back to the password.

Not moved: Zitadel's own sessions, SMS and email codes, links to outside logins, and machine users
(create access tokens instead). Backups keep working with no Zitadel container; `backup.sh` only
warns unless `NIX_REQUIRE_ZITADEL=1`.

To go back, restore the previous env file and release again. Zitadel's data is untouched, so start
it again if you stopped it.

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

## Signing in from the iOS app (installs that use an outside identity provider)

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

A new Kubernetes install also signs in locally and deploys no Zitadel; the setup code is printed at
the end and kept as `setup-code` in the `nix-auth` secret. Managed template sync there is off by
default: it needs a Core access token (`account service-token --name <name> --scopes read,write`,
run with the migrator image) stored as key `token` in a secret you name in `TEMPLATE_BOOT_TOKEN_SECRET`.
An existing cluster install that passes `OIDC_CLIENT_ID` to `deploy.sh` stays on OIDC.

### Moving a cluster install off Zitadel

An install that uses the bundled Zitadel can switch to Nix's own sign-in and keep its accounts,
password hashes, authenticator apps and passkeys. Run `deploy/k8s/deploy.sh` as usual, with these
extra settings:

1. Dry run: add `NIX_IMPORT_ZITADEL=dry-run`. After the migrations it prints what would move, any
   clashes and anything that blocks the import, then stops. Nothing else changes. Fix what it reports
   and run it again until it is clean.
2. Run it: add `NIX_AUTH_MODE=local` and `NIX_IMPORT_ZITADEL=run`. A failed import prints its log
   and stops before anything is switched. Set `NIX_AUTH_PASSKEY_RP_ID` only if your passkeys were
   registered for a host other than `auth.<host>`.
3. The import job runs on the same node as Core, because it reads Core's key ring. Core must be running.

Zitadel's database, secret and volume stay in place, and its Deployment is scaled to zero. Keep the
DNS record for `auth.<host>`: browsers check migrated passkeys there, and Core answers only
`/.well-known/webauthn` on that name. To go back, deploy again with `NIX_AUTH_MODE=oidc` and
`OIDC_CLIENT_ID`.

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
`migrator`, `collab`, `web`, `sites` and `release-tools`. Pushing a `vX.Y.Z` tag names
that commit's images `vX.Y.Z` and `latest`, which the installer uses by default. `--version` also
accepts a full commit SHA.

Published packages are listed on the [repository packages page](https://github.com/sianachi/nixsites/packages).
