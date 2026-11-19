# Backups

A Nix backup is only complete if it contains the database, the file bytes and the keys needed to use them. A database dump on its own cannot restore uploaded files, and the data cannot always be used without the keys that protected it.

## What to back up

| What | Where it lives | Why it matters |
| --- | --- | --- |
| The Nix database and its roles | postgres | All items, properties, views, document history, settings, accounts and passkeys |
| File bytes | the nix-versity-data volume, or your external store | Uploads, images and attachments |
| Data-protection keys | the nix-api-data-protection volume | Calendar connections and protected sign-in state |
| Companion data | the nix-companion-data volume | The companion runtime's state, including ChatGPT connections |
| The environment file | your private path | Passwords, keys and identity settings |
| The access-token signing key | your private path | Tokens and sessions |
| The manifest and proxy configuration you ran | your checkout | Rebuilding the same deployment |

Nix signs people in itself, so accounts, password hashes and passkeys are in the Nix database. If you sign in through an identity provider you run, back up its database too. `backup.sh` also dumps and verifies a leftover Zitadel database from an older install while its container runs; set `NIX_REQUIRE_ZITADEL=1` to make that mandatory.

There is no message broker to back up: background jobs are rows in PostgreSQL. Search runs inside PostgreSQL, so the database backup covers it.

## Taking a backup

Take a logical dump of PostgreSQL with `pg_dump` in custom format, together with the cluster roles from `pg_dumpall --roles-only`. Take the dump from a single consistent snapshot. Archive the volumes alongside it, pausing the object store while you copy its volume so the files are consistent.

The repository's `deploy/compose/backup.sh` does all of this from a release checkout, writes a private backup directory with checksums, and then proves the backup by restoring it into a throwaway, network-isolated database and comparing table and row counts. `backup.sh <full-commit-sha>` writes `pre-<sha>` and `backup.sh --nightly` writes `nightly-<timestamp>`. `backup.sh --check <directory>` verifies an existing backup before you rely on it. `NIX_BACKUP_ROOT` chooses where backups are written, and `NIX_DEPLOY_ENV` names your environment file.

Treat every backup as a secret: it contains your passwords and keys. Keep backup directories readable only by you.

## Off-site copies

Keep at least one encrypted copy off the machine. The repository includes `deploy/compose/offsite.sh`, which pushes verified backup directories to an encrypted restic repository on any S3-compatible service, and `deploy/compose/nightly.sh`, which takes a verified nightly backup, pushes it and applies a retention policy. Credentials live in a private mode `0600` file named by `NIX_BACKUP_OFFSITE_ENV`, holding `RESTIC_REPOSITORY`, `RESTIC_PASSWORD`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_DEFAULT_REGION`. Run `offsite.sh init` once to create the repository. `deploy/compose/systemd/` has a timer and service for the nightly run; local nightly backups older than seven days are deleted after a successful push. Keep the repository password in a password manager: without it no snapshot can be restored.

## Restoring

1. Restore into isolation first: an empty directory and a throwaway database container with no network.
2. Verify checksums and counts before going further.
3. Keep the old volumes until the restored instance has been checked in a browser.
4. Restore roles before the dump, and restore the volumes and keys together with the database they belong to.

An image rollback cannot undo a database migration. If you need to go back across a migration, restore from the backup taken before the upgrade.

Do not restore an old copy of a single document in place under its existing ID. Installed apps hold local copies and would merge the removed content back. To recover an earlier state of a document, use its version history, which adds the old state as a new revision.

## On Kubernetes

The `nix-backup` CronJob in `deploy/k8s/backup.yaml` runs every night at 02:00 and never overlaps itself. Each run writes the cluster roles, a custom-format dump of the Nix database, an archive of the object store volume with its extended attributes, and a checksum file, into a dated directory on the retained `nix-backup` volume. A leftover Zitadel database is dumped too while one exists. Directories older than 14 days are removed.

That volume lives on the same node as the data, so on its own it protects against mistakes, not against losing the node. To push each night's directory to an encrypted restic repository, create the `nix-backup-offsite` secret with `deploy/k8s/create-secrets.sh --backup-offsite-only` and create the repository once with `deploy/compose/offsite.sh init`. The job then keeps 7 daily, 4 weekly and 6 monthly snapshots and checks the repository after every push. Deploy with `NIX_BACKUP_OFFSITE=true` to make a missing secret fail the job.

The CronJob does not cover the Kubernetes Secrets or the `nix-api-data-protection` volume. Back those up yourself: without the Secrets the dumps cannot be used, and losing the key volume means every calendar connection has to be made again.

## Exports are not backups

A `.nix` export is a faithful, portable copy of a subtree that Nix can import again. It is useful for moving content and for personal archives, but it does not contain every user, workspace, permission and history entry. Use both.

## Properties

- title: Backups

