# Docker Compose

# Docker Compose

The production manifest is `deploy/compose.prod.yml` in the repository. Images come from `ghcr.io/sianachi/nix/<image>:<full commit SHA>`. The packages are public, so the host needs no registry login.

`deploy/install.sh` runs this manifest for you, layered with `deploy/compose.quickstart.yml`, which bundles Zitadel and puts Caddy on the public ports with automatic HTTPS: see [Install in one line](nix://item/01a16030-a2fa-76fd-bef3-cb99a1a146d0). This page describes the manifest itself and running it by hand.

## Services

| Service | Role |
| --- | --- |
| postgres | PostgreSQL 16 with pgvector: all durable state and search |
| rabbitmq | Job transport between Core and the workers |
| nix-versitygw | S3-compatible storage for file bytes |
| nix-api | Core: API, permissions, sign-in and search |
| nix-collab | Collaboration: live editing, history, import and export assembly |
| nix-import-worker | Imports and file inspection; also hosts the optional companion runtime |
| nix-export-worker | Native, Markdown, PDF and Word exports |
| nix-plugin-worker | Signed WebAssembly plugin runs |
| nix-calendar-worker | Google and Outlook calendar sync |
| nix-notify-worker | Web Push delivery |
| nix-sites-worker | Builds published websites (sites profile) |
| nix-sites-serve | Serves published websites to anonymous readers (sites profile) |
| nix-web | The web app, served by Caddy, which also routes the API, collaboration and storage |
| cloudflared | An optional tunnel connector for public ingress |

One-shot jobs prepare each release:

| Job | Purpose |
| --- | --- |
| nix-migrate | Core database migrations |
| nix-template-presets | Seeds the managed templates |
| nix-api-init | Sets ownership on the data-protection key volume |
| nix-storage-init | Creates the storage bucket (maintenance profile) |
| nix-collab-migrate | Document schema migrations (maintenance profile) |

All five workers use the same `worker` image with a different role. Every service drops all Linux capabilities, cannot gain new privileges and, where it can, runs with a read-only filesystem.

## Profiles

Two Compose profiles keep optional services out of a normal `up`:

| Profile | Services | How it is used |
| --- | --- | --- |
| maintenance | nix-storage-init, nix-collab-migrate | Run as one-shot jobs during a release |
| sites | nix-sites-worker, nix-sites-serve | Set COMPOSE\_PROFILES=sites and NIX\_SITES\_DOMAIN to publish websites |

To enable Sites, set the two variables above and a distinct broker password for the sites worker, then point a wildcard hostname for `*.<sites-domain>` at the web container with the `Host` header left as sent. Caddy routes one-label hostnames under the sites domain to `nix-sites-serve`. `nix-storage-init` creates the sites bucket. See [Sites](nix://item/01a130b0-106e-79a7-868c-435fae417b52) and [Configuration](nix://item/01a130b0-14df-721e-b23c-3f24282e0eae).

## The release scripts

`deploy/compose/` holds the scripts that operate a Compose deployment. Each has a test that runs it against a stubbed Docker.

| Script | Purpose |
| --- | --- |
| release.sh | The one-command release: checks, backup, off-site push, deploy, smoke test and a ledger entry. See Upgrades |
| deploy.sh | The deploy step on its own: validate, pull, stop writers, migrate, start in order, smoke test |
| backup.sh | A verified local backup, restored into an isolated database to prove it. See Backups |
| offsite.sh | Pushes verified backups to an encrypted restic repository on S3-compatible storage |
| nightly.sh | A nightly backup, push and retention run, with a systemd timer in deploy/compose/systemd/ |
| drift.sh | Previews which containers Compose will recreate, and stops if that includes PostgreSQL or the object store |
| prune.sh | Lists old release checkouts and backups, and deletes them only with --apply |
| build.sh | Builds local images from a commit, for the rare case you cannot use the published ones |
| smoke.mjs | The end-to-end smoke test, run through nixctl |

## Ingress

Caddy in `nix-web` listens on port 8090 on the private network and routes:

- `/api/*`, `/auth/*` and `/public/v1/auth/token` to Core;
- `/collab/*` to the collaboration service;
- `/<bucket>/*` to the object store;
- everything else to the web app.

Terminate TLS in front of it. The manifest includes a Cloudflare Tunnel connector, which needs no open inbound port: Cloudflare ends TLS and the connector forwards to `nix-web` on the private network; to use your own reverse proxy instead, add a Compose override that publishes the web container's port to the host's loopback interface and leaves out the tunnel:

```yaml
# /srv/nix/compose.override.yml
services:
  nix-web:
    ports:
      - "127.0.0.1:8090:8090"
  cloudflared:
    profiles: [disabled]
```

Pass it with a second `-f` after the main manifest. The manifest still requires `CLOUDFLARE_TUNNEL_TOKEN` to be set; any placeholder will do when the tunnel is disabled.

Then proxy `https://<your-domain>` to `http://127.0.0.1:8090`, passing the original `Host` header. WebSocket upgrades must be allowed for `/collab/*`.

## First start

1. **Check out the release.** Clone the repository and check out the full commit SHA you intend to run. The manifest, RabbitMQ configuration and seed files must match the images. Wait until CI has published images for that commit.
2. **Write the environment file.** Copy `deploy/compose.prod.env.example` to a private path outside the checkout, set its mode to `0600` and replace every placeholder. See [Configuration](nix://item/01a130b0-14df-721e-b23c-3f24282e0eae).

   ```sh
   install -m 600 deploy/compose.prod.env.example /srv/nix/production.env
   openssl ecparam -name prime256v1 -genkey -noout -out /srv/nix/core-access-token.pem
   ```
3. **Set up a shorthand** for the Compose command:

   ```sh
   export NIX_IMAGE_TAG=<full-commit-sha> NIX_WEB_IMAGE_TAG=<full-commit-sha>
   dc() { docker compose -p nix --env-file /srv/nix/production.env \
     -f deploy/compose.prod.yml -f /srv/nix/compose.override.yml "$@"; }
   ```

   Leave out the override file if you use the tunnel.
4. **Start the infrastructure.**

   ```sh
   dc up -d --wait postgres rabbitmq nix-versitygw
   ```
5. **Create the database and roles.** Nix uses three database roles: `nix_migrator` owns the schema and runs migrations, `nix_app` is Core's runtime role, and `nix_collab` is the collaboration service's role. Neither runtime role may bypass row-level security. The repository's seed files create them with your passwords:

   ```sh
   dc exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
     -v migrator_password='<migrator-password>' \
     -v app_password='<app-password>' \
     -v collab_password='<collab-password>' \
     -v db_name=nix -f - < deploy/seed/seed.sql
   dc exec -T postgres psql -U postgres -d postgres -c 'CREATE DATABASE nix OWNER nix_migrator'
   dc exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d nix \
     -v db_name=nix -f - < deploy/seed/seed_database.sql
   ```

   Use the same passwords in the connection strings in your environment file. Do not run the development or demo data seeds against a real deployment.
6. **Prepare storage and run migrations.**

   ```sh
   dc --profile maintenance run --rm --no-deps nix-storage-init
   dc run --rm --no-deps nix-migrate
   dc run --rm --no-deps nix-template-presets
   dc run --rm --no-deps nix-api-init
   dc --profile maintenance run --rm --no-deps nix-collab-migrate
   ```
7. **Start everything.**

   ```sh
   dc up -d --wait
   ```
8. **Sign in** at `https://<your-domain>`. Your first sign-in creates your personal workspace.

## Checking it works

A green health check only proves a process started. After a first start or an upgrade, check by hand:

- sign in, reload a deep link and sign out;
- edit the same note in two browsers and reload;
- upload, open and download a file;
- import a document and export a subtree as `.nix`, PDF and Word.

`nix-api` has no Compose health check, because its image contains no shell. Its liveness route is `/healthz` on port 8080 on the private network. A `200` from the public `/health` path comes from the web container and does not prove Core is up.

## Things never to do

- Never run `docker compose down -v`, `docker volume prune` or `--remove-orphans` against the Nix project. The named volumes hold your data and keys.
- Never print `docker compose config` with resolved secrets. Use `docker compose config --quiet` to validate.
- Never restore an old copy of a document's body in place under its existing ID. Installed apps hold local copies and would merge the removed content back. Use version history instead.

## Properties

- title: Docker Compose

