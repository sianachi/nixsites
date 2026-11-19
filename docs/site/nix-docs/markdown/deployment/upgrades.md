# Upgrades

# Upgrades

Every commit on `main` gets a full set of images, tagged with its full 40-character commit SHA, for `linux/amd64` and `linux/arm64`; a release tag adds `vX.Y.Z` and `latest`. An install made by `deploy/install.sh` upgrades by running the installer again with `--version`: see [Install in one line](nix://item/01a16030-a2fa-76fd-bef3-cb99a1a146d0). For a deployment you run by hand, an upgrade means choosing a SHA, checking out the matching manifest and running it. See [Images and tags](nix://item/01a13137-c3f3-7efb-8afc-83357024c5b5).

## Before you start

- Wait until CI has published the images for the commit. Every image the manifest needs must exist.
- Take a verified backup while the current version is still serving. See [Backups](nix://item/01a130b0-1468-74cc-ac27-9468e85f46ff).
- Plan a short maintenance window. Writers are stopped while migrations run.

## The release script

From a clean checkout of the target commit:

```sh
git fetch origin main
git checkout --detach <full-commit-sha>
bash deploy/compose/release.sh <full-commit-sha>
```

`deploy/compose/release.sh` reads non-secret host settings from a `release.conf` file (start from `deploy/compose/release.conf.example`), including the path to your environment file. It then:

1. refuses a short SHA, a checkout at a different commit or modified tracked files;
2. confirms every image exists in the registry;
3. takes a release lock and shows you the plan, asking for confirmation;
4. takes and verifies a backup, and pushes it off-site if configured;
5. previews which services Compose will recreate, and refuses to recreate PostgreSQL or the object store unless you allow it;
6. stops the application, runs migrations and starts the services in order;
7. runs a smoke test through `nixctl` that imports a document, exports it as `.nix`, PDF and Word, and checks the results.

Each attempt is recorded in a release ledger with its outcome.

The smoke test needs a `nixctl` profile with a dedicated access token (read and write scopes only) belonging to an account whose only membership is a disposable workspace.

## Doing it by hand

If you prefer not to use the script, the order matters:

```sh
export NIX_IMAGE_TAG=<full-commit-sha> NIX_WEB_IMAGE_TAG=<full-commit-sha>
dc pull
dc stop nix-web nix-node nix-api
dc up -d --wait postgres nix-versitygw
dc --profile maintenance run --rm --no-deps nix-storage-init
dc run --rm --no-deps nix-migrate
dc run --rm --no-deps nix-template-presets
dc run --rm --no-deps nix-api-init
dc --profile maintenance run --rm --no-deps nix-collab-migrate
dc up -d --no-deps --wait nix-api nix-node
dc up -d --wait
```

`dc` is the Compose shorthand from [Docker Compose](nix://item/01a130b0-156d-7ac6-99ed-ebee0b7d7dfe). The script also creates the `nix_backup` database role if it is missing, which a migration needs, and removes the containers of services that older releases ran. If a migration fails, leave the application stopped and investigate before starting anything.

## On Kubernetes

Check out the target commit and run `deploy/k8s/deploy.sh` again with the new `TAG`, then `deploy/k8s/verify.sh`. The script applies migrations as jobs named after the tag before it rolls out the new workloads, and waits for each rollout. There is no built-in backup step: make sure the night's backup has completed, or trigger the CronJob by hand, before you start. `deploy.sh` also removes workloads that older releases ran, such as the broker and the per-role workers, and keeps their volumes.

## Coming from an older release

Three removals are breaking. Read them before you upgrade an install made earlier.

- **RabbitMQ and the Go workers are gone.** Background jobs run inside Core, and one `nix-node` service replaces `nix-collab`, `nix-companion` and `nix-sites-worker`. The deploy scripts remove the old containers or objects once and keep their volumes. Delete every `NIX_RABBITMQ_*` and `NIX_WORKER_IMAGE_TAG` line from your environment file. The old `nix-rabbitmq-data` volume (Compose) or broker volume claim (Kubernetes) stays until you delete it, and you need it only to roll back to a release that had the broker.
- **WebAssembly plugins and the finance feature are gone.** Existing finance records stay as ordinary items, and a saved finance view becomes a sheet view. Keep money records in CSV files.
- **Zitadel is no longer bundled or managed.** Nix signs people in itself. An install that still uses the bundled Zitadel must move before it can upgrade, and accounts, password hashes, authenticator apps and passkeys come across:

  - installer: run `install.sh --migrate-local-auth --dry-run`, then without `--dry-run`. The installer stops until you do;
  - Compose by hand, with Zitadel in its own project: run `deploy/compose/import-zitadel.sh --dry-run`, then without it, after releasing a version that has local sign-in. It needs `NIX_DEPLOY_ENV`, `NIX_IMAGE_TAG`, `NIX_AUTH_PASSKEY_RP_ID`, `NIX_ZITADEL_DB_PASSWORD` and `NIX_ZITADEL_MASTERKEY`. Then set `NIX_AUTH_MODE=local` in the environment file and release again;
  - Kubernetes: run `deploy/k8s/deploy.sh` with `NIX_IMPORT_ZITADEL=dry-run`, then with `NIX_AUTH_MODE=local` and `NIX_IMPORT_ZITADEL=run`. `deploy.sh` refuses to run while the old `nix-zitadel` Deployment has replicas, and scales it to zero after the import.

  Passkeys were registered for the old sign-in hostname, so that hostname must keep sending exactly `/.well-known/webauthn` to Nix. Keep its DNS record. The old Zitadel containers, objects and data are left for you to delete. Moving back to Zitadel needs a restore of the backup taken before the upgrade. An install that already uses an identity provider you run yourself is not affected.

## Installed apps

The installed app caches its own shell, so a new version reaches each device when the person accepts the "An update is ready" prompt. Pending work is saved before the app reloads.

## Rolling back

If the new version's database schema is compatible with the old one, check out the previous commit and release it again in the same way. If a migration has changed the schema incompatibly, stop the application and restore the backup taken before the upgrade. Image rollback alone cannot reverse a migration.

Keep the previous release's checkout and backup until the new version has been checked in a browser: sign in, edit in two browsers, upload and open a file, import and export.

## Cleaning up

`deploy/compose/prune.sh` lists old release checkouts and backups it would remove, keeping the running release and the one before it. Add `--apply` to delete them. It never touches volumes.

## Properties

- title: Upgrades

