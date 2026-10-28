# Deploying Nix with Docker Compose

Docker Compose is the default build, release and operations target. Kubernetes manifests are
retained for a future explicit switch; do not run `deploy/k8s/*` during a Compose release.
Start here rather than treating a green container health check as a successful deployment.

## One-line install

A new machine (or cluster) needs none of the hand steps below: `deploy/install.sh` generates every
secret, bundles Zitadel behind Caddy with automatic HTTPS (`compose.quickstart.yml` over
`compose.prod.yml`), registers the web application, migrates and starts. Re-running upgrades.

```sh
curl -fsSL https://raw.githubusercontent.com/sianachi/nixsites/main/deploy/install.sh | bash   # try-out at http://nix.localhost
curl -fsSL https://raw.githubusercontent.com/sianachi/nixsites/main/deploy/install.sh | bash -s -- https://nix.example.org
# or, into the current kubectl context (deploy/k8s with generic-cluster defaults):
curl -fsSL https://raw.githubusercontent.com/sianachi/nixsites/main/deploy/install.sh | bash -s -- --kubernetes https://nix.example.org
```

The header of `deploy/install.sh` lists the options. State lives in `~/nix` (`nix.env` on
Compose, `kubernetes.env` plus the cluster's secrets on Kubernetes). The rest of this guide is
for operating an install by hand, and still applies afterwards: backups, drift, rollback.

## Production baseline

As verified on 2026-09-05, production is `operator@release-host` (Linux ARM64), Compose project
`nix`, public origin `https://nix.example.org`. Cloudflare Tunnel reaches Caddy on port 8090;
Caddy routes Core, collaboration and `/nix-worker-jobs/*`. The storage route preserves the
bucket path and signed Host header and reaches `nix-versitygw:7070`. Core and workers sign/use
HTTPS capabilities through the public origin. Never send bearer tokens to object storage.

Versity v1.7.0 owns `nix-versity-data`. MinIO and the old Node Media service are retired.
Do not delete their retained rollback volumes or restart them as part of a normal release.
Postgres, RabbitMQ, data-protection keys, companion state and Caddy also use named persistent volumes.
Never use `docker compose down -v`, `volume prune`, or `--remove-orphans` during deployment.

The last verified deployment uses `/home/nix/nix-release-14e0a39d/deploy/compose.host.yml`
and its private `.env`. API/collab/web are `14e0a39d`; all four Go roles are `77ef824a`.
These are historical recovery references, not tags to copy into a new release.
The checked-in manifest now contains Versity, the storage route and the explicit Caddy volume
name previously supplied by that host override. Before the first rollout of this manifest,
compare the effective services, image IDs, volume names and routes against the current host.
Do not apply the old override blindly: it pins old worker images. Keep a private backup of it.

## Prerequisites and configuration

Use Docker Engine with Compose v2 supporting `up --wait`, Git and Python 3 on the release host;
it needs no Node, pnpm or `pdftotext`. `nixctl` and the smoke runner ship in the `release-tools`
image (`release-tools smoke [--preflight]`, `release-tools nixctl <args>`), which `deploy.sh`
runs at the release tag with the host profile file mounted read-only at
`/config/nixctl/config.json`. It reads `$NIXCTL_CONFIG`, defaulting to
`${XDG_CONFIG_HOME:-~/.config}/nixctl/config.json`.

Copy `deploy/compose.prod.env.example` to a private absolute path, restrict it to mode 0600,
and replace every placeholder. Never commit it or print `docker compose config` with resolved
secrets. Use `config --quiet` for validation. Preserve existing passwords, signing keys,
OIDC identity, storage credentials and data-protection keys on upgrades.

For bundled Versity, set both object-store endpoint and public origin to the application's
HTTPS origin and bucket to `nix-worker-jobs`. The release creates a missing bucket using the
configured keys; it does not migrate objects from another provider. A provider migration requires
separate inventory, copy, size/hash verification, a final write freeze and a retained rollback.
The storage initializer uses AWS CLI on the private network; application transfers still use
public HTTPS so the smoke check exercises the actual edge path.

`NIX_CORE_TOKEN_SIGNING_KEY_FILE` must be an absolute host path. Supply the separate privileged
`NIX_COLLAB_MIGRATOR_CONNECTION_STRING` only for the one-shot document migration service.
It must not replace the restricted collaboration runtime connection. The Core migrator is also
separate from the runtime. The Compose manifest assumes the database and restricted roles already
exist. For a new host, provision those roles, ownership, credentials and OIDC outside this upgrade
procedure; never run development/demo seed scripts against production.

Password changes, passkeys and second factors live at the identity provider, not in Nix. The
profile menu links to `Nix__Bff__AccountPage`, which defaults to the Zitadel console's own-account
page (`$NIX_OIDC_ISSUER/ui/console/users/me?id=security`); set `NIX_OIDC_ACCOUNT_URL` for another provider.
"Reset Password" on the Zitadel login only works with an active SMTP provider. Converge that and
the passkey-allowing login policy with `deploy/seed/zitadel-self-service.sh`, the one seed-directory
script meant for production: it changes only the instance SMTP provider and login policy, and is
safe to re-run. Give it an IAM_OWNER token and the SMTP password as mode-0600 files, never as
arguments:

```sh
ZITADEL_URL="$NIX_OIDC_ISSUER" ZITADEL_PAT_FILE=~/zitadel-owner.pat \
NIX_SMTP_HOST=smtp.example.org:587 NIX_SMTP_SENDER=no-reply@example.org \
NIX_SMTP_USER=<user> NIX_SMTP_PASSWORD_FILE=~/smtp.password \
  deploy/seed/zitadel-self-service.sh
```

Prove it by choosing "Reset Password" for a test account and following the emailed link.

Release checks use a dedicated release-check token, never a personal working token: a revoked
personal token broke the last smoke run. The release operator owns it and records its expiry
date. Tokens narrow scopes but not workspaces, so mint it as a separate, non-administrator release-check principal
whose only membership is the dedicated `release-checks` workspace (`NIX_SMOKE_WORKSPACE`); that
confines its reach to disposable smoke items. Mint it in the web app under Settings > Access
tokens with `read` and `write` scopes only (no `admin`), named `release-check`, with a 90-day
expiry. Store it with `nixctl --profile <profile> auth login --api-url <public origin> --token
"$TOKEN"`, reading `TOKEN` from a silent prompt (`read -rs TOKEN`) so it stays out of shell history
and logs; the PAT then lives only in the mode-0600 profile on the release host. Rotate at least 14
days before expiry, and at once after any suspected exposure or operator change: mint the
replacement, log the profile in again, run `smoke.mjs --preflight`, then revoke the old token.
Core does not report a token's expiry to the token itself, so preflight cannot warn in advance;
it fails before any image pull or writer stop and names the profile when the token is revoked,
expired or unrecognised. No production profile is checked in. The default smoke runner uses
`deploy/compose/nixctl.sh`; `NIXCTL_BIN` can select an installed executable. It must act through
Core, never query application tables directly.

### Current roles and retired services

The current manifest has five Go roles: import, export, plugin-events, calendar and notify.
The import instance also hosts the optional companion HTTP runtime. Native, Markdown, DOCX
and PDF export remain implemented in Go; only the unused TypeScript converters were removed.
Core searches PostgreSQL directly; OpenSearch and its indexing role are retired.

Speech, browser recording, transcription APIs, dictation and voice UI are retired. There is no
speech profile, model installer, GPU requirement or speech image in the current release. The
`20261009200000_RetireSpeechJobs` migration cancels queued/running transcription jobs and marks
pending transcription commands processed without dropping recordings, file versions or
historical transcript rows. Its Down method does not resume cancelled work.

`deploy.sh` stops old `nix-speech-worker`, `nix-indexer`, `nix-opensearch`, `grafana`, `alloy`,
`loki` and `docker-socket-proxy` containers by Compose project/service labels after preflight.
It preserves their volumes. Do not restart them or remove their retained data during a normal
release. Current diagnostics use application/Docker logs, CLI operation state and Collab metrics;
there is no central Grafana/Loki/Alloy stack or replacement alert backend in this manifest.

## Build and release

Release images are built by CI, not on the host. On every push to `main` (and on manual
dispatch) the CI images workflow (`.github/workflows/ci-images.yml`) publishes six images:
`api`, `migrator`, `collab`, `worker`, `web` and `release-tools`, for linux/amd64 and linux/arm64,
to `ghcr.io/sianachi/nix/<image>:<full commit SHA>`. Speech variants are no longer built.
Every `main` SHA ends up with every image, but not every image is rebuilt: a `plan` job diffs
the push range against each image's source paths and retags the previous SHA's manifest for
images whose inputs did not change. Everything is rebuilt on manual dispatch, on a first or
force push, when `.dockerignore` or the workflow itself changes, or when the previous image is
missing. The packages are public, so the host needs no registry login. Wait for that workflow
to succeed for the commit before deploying it. `release.sh` resolves every application image
the current Compose manifest needs and refuses the release up front if any is unpublished.
The host needs the matching checkout for its manifest/scripts but no `pnpm install`; smoke
tools come from the `release-tools` image.

### Backend integration tests in CI

`ci-backend.yml` runs the Postgres integration suite (`backend/tests/Nix.Integration.Tests`) in two jobs:

- **backend integration** (every PR and push): everything except `Category=PlanEvidence`, about 8 minutes locally.
- **backend plan evidence** (pushes to `main` only): the `*PlanEvidenceTests` classes, which assert `EXPLAIN (ANALYZE, BUFFERS)` plans over large seeded corpora. They measure index use, not behaviour, so a plan regression is caught after merge, not on the PR. Treat a red run as a blocker for the next release, and run it before tagging.

How the suite stays fast, which a new test must respect:

- Test classes sit in one of two serial collections, `postgres` and `postgres-secondary`. Each has its own Testcontainers Postgres and the two run in parallel. Balance by measured time when adding a class; never split a class across them.
- Most classes reset the database before every test (Respawn). A class that only reads what its seed built may use `SeedOnce` (`Harness/SeedOnce.cs`) to reset and seed once. A test there that writes rows another test reads needs the per-test reset back.
- `StructureRuleParityHttpTests` must keep a web host per test: the API rate-limits token exchange per host, so a shared host returns 429.
- New plan-evidence classes need `[Trait("Category", "PlanEvidence")]`.

A release is one command, `deploy/compose/release.sh <full-40-char-sha>`, run on the host from a
checkout of that SHA. Secrets and release details stay apart: the secrets file is never edited
per release, and the image tags come from the SHA argument.

Setup once. Keep one canonical secrets file at `~/nix-production/production.env` (mode 0600),
prepared as described above. Copy `deploy/compose/release.conf.example` to
`~/nix-production/release.conf` and fill in the non-secret host settings: `NIX_DEPLOY_ENV` (the
absolute path of that secrets file), `NIXCTL_PROFILE`, `NIX_SMOKE_WORKSPACE`, `NIX_BACKUP_ROOT`,
`NIX_RELEASE_LEDGER`, `NIX_RELEASE_LOCK`, `NIX_IMAGE_REGISTRY` and `NIX_OFFSITE_REQUIRED` (see
[Off-host backups](#off-host-backups)). The script sources it as
shell, so keep it operator-owned and free of secrets. `NIX_RELEASE_CONF` selects another path.

Per release, check out the SHA and run the script:

```sh
git fetch origin main
git checkout --detach <full-40-char-sha>
bash deploy/compose/release.sh <full-40-char-sha>
```

`release.sh` refuses a short or non-hex SHA, a checkout whose `HEAD` is not that SHA, or modified
tracked files, because the manifest and smoke tools must match the images. It resolves the
release image matrix through Compose and confirms every image exists in the registry
(`docker manifest inspect`) before anything else, takes the host release lock with `flock`,
prints the plan and asks for confirmation before any writer stops (`--yes` skips the prompt; a
non-interactive run without `--yes` is refused). It runs `backup.sh <sha>` and checks the result,
unless `NIX_BACKUP_REFERENCE` already names a directory that passes `backup.sh --check`, then
pushes that directory off-host with `offsite.sh push` (a failure aborts before any writer stops
while `NIX_OFFSITE_REQUIRED=1`, the default, and only warns when it is `0`). It then
exports `NIX_IMAGE_TAG` and `NIX_WEB_IMAGE_TAG` as the SHA and runs `deploy.sh`. Compose
interpolation prefers shell variables over `--env-file` values (verified with
`docker compose config --images` on Compose v2.35), so the tag placeholders in the secrets file
are ignored. Every confirmed attempt appends one tab-separated line to the ledger: UTC time,
SHA, backup directory, result (`succeeded`, `failed:backup`, `failed:offsite` or `failed:deploy`) and
`operator=$USER`.

Normally leave `NIX_WORKER_IMAGE_TAG` unset. For a reviewed worker-only hotfix it may select
another immutable worker image in the secrets file while other services take the release SHA;
the printed plan shows the resulting matrix and `release.sh` checks it like the others. The
images are pulled before any writer stops.

To run an unpublished tree instead, build it on the host with `bash deploy/compose/build.sh HEAD`
and set `NIX_IMAGE_REGISTRY=localhost/nix` in `release.conf`; the release then checks those local
images exist rather than querying a registry. The build uses `git archive`, so uncommitted
secrets never enter a context.

Before rollout, take and verify a backup with `deploy/compose/backup.sh`, run on the host from
the release checkout while the current release is still serving. It writes
`~/nix-backups/pre-<sha>` (base directory `NIX_BACKUP_ROOT`), refuses an existing directory and
never deletes anything. The directory (mode 700, files mode 600) holds a custom-format `nix.dump`,
`roles.sql`, tar archives of `nix-versity-data` (taken with Versity paused, always unpaused
afterwards), `nix-api-data-protection` and `nix-companion-data`, copies of the private env file,
the core access-token key (found from the `nix-api` mount, or `NIX_CORE_ACCESS_TOKEN_PEM`), the
running compose file and Caddyfile, `containers.private.json` and `SHA256SUMS`. When the Zitadel
Postgres container runs (Compose project `zitadel`, found by service name, or named by
`NIX_ZITADEL_DB_CONTAINER`) it also holds `zitadel.dump` and `zitadel-roles.sql`; without it the
backup warns, or fails when `NIX_REQUIRE_ZITADEL=1`. It then restores
roles and the dump into an isolated `--network none` pgvector container, and the Zitadel roles and
dump into a second one built from the Zitadel database's own image, comparing its table count. The dump runs on a
snapshot exported from a held `REPEATABLE READ` transaction that also records the table count and
the largest tables' row counts, so the restored counts must match exactly even with writers live.
It compares each archive's file count with its volume (drift in the companion volume is only a
warning) and records the outcome in `verified.txt`. These files contain secrets; the script never
prints them. After a failure, rerun under a new `NIX_BACKUP_ROOT` rather than editing the
directory. Check schema
rollback compatibility separately. `deploy.sh` requires `NIX_BACKUP_REFERENCE` to be that
absolute directory and runs `backup.sh --check` on it before anything else; the check fails
unless every file is present, `SHA256SUMS` verifies and `verified.txt` records a passed restore.
Backups made before Zitadel capture lack the two Zitadel files; `--check` still accepts them and
prints a note (it rejects them only under `NIX_REQUIRE_ZITADEL=1`).

### Remote MCP (optional)

The `mcp` Compose profile serves the `nixctl mcp` tool contract over Streamable HTTP at
`https://<app>/mcp`, from the `release-tools` image (`nixctl mcp --listen 0.0.0.0:8500`). It holds
no credential: every request carries its own personal access token (`Authorization: Bearer
nixpat_...`), which the service exchanges with Core exactly as the CLI does, so a call runs as that
principal within that token's scopes and revoking the token stops the client on its next request. A
request without a bearer is refused before any tool server is built. To enable, add `mcp` to
`COMPOSE_PROFILES`, set `NIX_MCP_UPSTREAM=nix-mcp:8500` so Caddy proxies `/mcp`, and set
`NIX_MCP_PUBLIC_URL` to the public address, which Core advertises to Settings > MCP. Hosted
claude.ai connectors need OAuth discovery, which this endpoint does not offer yet; Claude Code,
Cursor and Claude Desktop (through `mcp-remote`) send the header. People make and revoke MCP
tokens under Settings > MCP; the stdio server (`nixctl mcp`) keeps working without the profile.

### Off-host backups

[deploy/backup/production.md](backup/production.md) is the operator guide to the whole backup
system: what each backup contains and leaves out, how it is verified, health checks, restore and
disaster recovery, credentials and troubleshooting. This section covers setup.

`deploy/compose/offsite.sh` copies verified backup directories to an encrypted restic repository
on Cloudflare R2, using the pinned restic image in a hardened container (read-only root, no
capabilities beyond reading files, private tmpfs cache, default bridge network only). It pushes
only directories that pass `backup.sh --check`, runs `restic check` after each push and prints the
snapshot id. Credentials live only in `~/nix-production/backup.env` (`NIX_BACKUP_OFFSITE_ENV`
selects another path), which reaches restic through `--env-file`; the scripts never source,
print or copy it, and refuse it unless it is owned by the operator and mode 600.

Setup once. Create the credentials file with exactly restic's variables, then initialize the
repository (`init` refuses an existing one). Keep `RESTIC_PASSWORD` in a password manager: without
it no snapshot can be restored, and it must never be regenerated.

```sh
install -m 600 /dev/null ~/nix-production/backup.env
# edit it: RESTIC_REPOSITORY=s3:https://<account>.r2.cloudflarestorage.com/<bucket>/<prefix>,
# RESTIC_PASSWORD, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION=auto
bash deploy/compose/offsite.sh init
```

Per release this is automatic: `release.sh` pushes the release backup tagged `kind=release` and
`sha=<sha>` before `deploy.sh`. Set `NIX_OFFSITE_REQUIRED=0` in `release.conf` only while the
repository is unavailable; the release then warns and continues.

Nightly, `deploy/compose/nightly.sh` holds the release lock, runs `backup.sh --nightly` (a verified
`~/nix-backups/nightly-<UTC stamp>` with the same contents), pushes it tagged `kind=nightly`, runs
`offsite.sh forget` (release snapshots keep the last 10; nightly ones keep 7 daily, 4 weekly and
6 monthly; each kind is its own group, then pruned) and deletes local `nightly-*` directories
older than 7 days. It never deletes `pre-*` directories, and `prune.sh` never deletes `nightly-*`.
A failed step is logged to the journal by name, stops the later steps and exits nonzero. Install
the systemd user timer (02:30 local, persistent, up to 10 minutes random delay) from the release
checkout. The service runs a copy of the scripts so a pruned checkout cannot break it; every
successful `release.sh` refreshes that copy, so it follows the deployed release:

```sh
install -d -m 700 ~/nix-production/backup-tools ~/.config/systemd/user
install -m 700 deploy/compose/backup.sh deploy/compose/offsite.sh deploy/compose/nightly.sh ~/nix-production/backup-tools/
install -m 644 deploy/compose/systemd/nix-backup-nightly.service deploy/compose/systemd/nix-backup-nightly.timer ~/.config/systemd/user/
sudo loginctl enable-linger "$USER"   # run user timers without a login session
systemctl --user daemon-reload
systemctl --user enable --now nix-backup-nightly.timer
systemctl --user start nix-backup-nightly.service   # first run now; then check the journal
journalctl --user -u nix-backup-nightly.service --since today
```

Two host prerequisites are easy to miss. The systemd user manager keeps the groups it started
with, so if the operator was added to `docker` after it started, the timer cannot reach Docker
even though SSH sessions can; `nightly.sh` says so and names the fix
(`sudo systemctl restart user@$(id -u).service`, or a reboot). And a user journal kept only in
`/run` loses each night's log at reboot; keep it on disk with
`sudo mkdir -p /var/log/journal && sudo systemd-tmpfiles --create --prefix /var/log/journal && sudo journalctl --flush`.

Every complete nightly run rewrites `~/nix-production/last-nightly-success` (override with
`NIX_NIGHTLY_MARKER` in `release.conf`). `release.sh` reads it in its plan and warns, without
stopping, when no nightly has succeeded or the last success is older than
`NIX_NIGHTLY_MAX_AGE_HOURS` (default 36), so a silently failing timer surfaces at the next release.

Backup status lives in the database. Each nightly run records a local and an off-host row in
`backup_runs` (timestamps, the local size, the restic snapshot id, and on failure a fixed phrase
with an exit code, never tool output), written through `nix_record_backup_run` as the `nix_backup`
role, which also drops runs that started more than six months before the one being recorded. That role cannot log in; the backup jobs already run as the Postgres superuser and
`SET ROLE` to it, so there is no new secret. `deploy/seed/seed.sql` creates the role (k3s runs it on
every deploy), and Compose `deploy.sh` creates it idempotently before migrating; never run
`seed.sql` on a Compose production host, because it resets role passwords. On an existing
development volume, re-run `deploy/seed/seed.sh` once. Operators read the rows in Settings, on the
Backups tab, which warns when a step has not succeeded in 26 hours. The Backups tab appears only for
principals listed in `Nix:Sites:Operators` (`Nix__Sites__Operators__0=<principal-id>`); with the list
empty nobody sees it, tenant administrators included. Only the nightly run is recorded, not the
`pre-<sha>` release backups.

Inspect with `offsite.sh snapshots`, and sample stored data periodically with
`offsite.sh check --read-data-subset=5%`. To restore, extract a snapshot into an empty directory,
verify it, then follow the same isolated restore steps as for a local backup (roles, then the dump,
into a throwaway `--network none` container; the Zitadel files into one of the Zitadel image)
before touching production:

```sh
bash deploy/compose/offsite.sh snapshots
bash deploy/compose/offsite.sh restore <snapshot-id> /absolute/empty/restore-dir
bash deploy/compose/backup.sh --check /absolute/empty/restore-dir/backup/<pre-sha-or-nightly-stamp>
```

`release.sh` passes `NIX_DEPLOY_ENV`, `NIXCTL_PROFILE`, `NIX_SMOKE_WORKSPACE`,
`NIX_BACKUP_REFERENCE` and the image tags to `deploy/compose/deploy.sh`. Run `deploy.sh`
directly only to recover from a failed release, with those variables exported by hand. A manual run looks like this:

```sh
export NIX_DEPLOY_ENV=/absolute/private/production.env
export NIXCTL_PROFILE=production
export NIX_SMOKE_WORKSPACE=<dedicated-workspace-uuid>
bash deploy/compose/backup.sh <release-sha>
export NIX_BACKUP_REFERENCE="$HOME/nix-backups/pre-<release-sha>"
bash deploy/compose/deploy.sh
```

OpenSearch and its indexer are retired; Core search uses PostgreSQL. The release stops their old
containers by project/service labels and retains the `nix-opensearch-data` volume for recovery.
Remove obsolete `NIX_OPENSEARCH_*`, `NIX_SEARCH_OPENSEARCH_*` and index broker variables from the
private environment when convenient. RabbitMQ revokes the old index account and detaches its
workspace-event binding while retaining queued history; plugin events remain enabled.
Kubernetes retirement also retains existing PVCs.

Grafana, Alloy, Loki and the Alloy-only Docker socket proxy are retired. The release stops their
old containers and retains their log and dashboard volumes for recovery. Remove obsolete
`NIX_GRAFANA_*`, `NIX_ALLOY_*` and `NIX_LOKI_*` variables from the private environment when
convenient. Application logs remain available through `docker compose logs`; no collector or
Grafana administrator password is required. Kubernetes retirement removes collector access and
workloads while retaining logging PVCs.

The speech feature is retired. Remove `COMPOSE_PROFILES=speech` and obsolete `NIX_SPEECH_*`
and speech broker variables from the private environment when convenient. The release script
stops the old speech container by its Compose project/service labels before migrations; existing
recordings, transcription records and model volumes are retained. The Core migration cancels
unfinished transcription jobs and retires their pending outbox commands after all writers stop.
It does not prune containers or volumes.

The script validates configuration, pulls or checks the release images, checks verification
credentials and confirms the profile URL matches the deployed public origin, previews drift, stops
application writers, brings up infrastructure and the bucket, runs Core/template/document
migrations, then starts compatible services before the frontend. RabbitMQ mounts its configuration
from the release checkout, so each release recreates it; writers are stopped first so that restart
cannot interrupt a delivery (queues are durable and messages persistent). The drift preview names
that restart and refuses only a recreate of Postgres or Versity. Before current writer stop,
it stops retained containers for retired services without deleting their volumes. Expect a
maintenance window. It deliberately
does not seed users, delete volumes, force an automatic schema rollback or restart unrelated stacks.
Any failure exits nonzero. Migration failures leave writers stopped for inspection. Once startup
has begun, a later failure may leave some services running; inspect state before resuming.

A release succeeds only after the smoke runner imports a TXT document through the Go worker,
publishes its editable note and retained attachment, exports `.nix`, PDF and DOCX, downloads and
checks checksums through `nixctl`, checks ZIP integrity and verifies imported text in PDF/DOCX.
It soft-deletes its temporary root on success or failure when the ID is known. Calls have a
three-minute bound. If import times out before returning an ID, inspect recent import jobs and
remove any published smoke root; do not assume a timeout implies no mutation.

Run the same checks independently after a worker/storage/edge change:

```sh
NIXCTL_PROFILE=production NIX_SMOKE_WORKSPACE=<uuid> NIX_SMOKE_ORIGIN=https://nix.example.org node deploy/compose/smoke.mjs
```

Then check sign-in, deep-link reload, two-browser live editing and persistence after reload,
image picker/drop/paste and opening/downloading an attachment in the browser. The CLI smoke test
does not prove browser CORS/CSP, accessibility, embedded sections, page breaks or image fidelity.
Inspect representative PDF/Word output when changing conversion or editor schemas.

### Installed web clients

The web app's service worker serves the application document from its own cache
(ADR-0053), so a release reaches an installed client when the person accepts the
"An update is ready" prompt, not on their next navigation. Two consequences for
releases:

- An emergency change to `index.html` or its CSP needs a release whose worker
  activates immediately. Call `self.skipWaiting()` in the install handler for that
  release only.
- `NIX_OBJECT_STORE_BUCKET` must not be `w`, `workspaces` or `launch`. The worker
  answers those paths with the application shell, so capability URLs under them
  would never reach the object store.

Never restore a document body backup in place under its existing `docId`.
Browsers reconcile their local copies with the live document, and a rewound
document would receive the removed content back (ADR-0053).

## Troubleshooting and rollback

Always use the same project name, env file and release manifest. Example:

```sh
docker compose -p nix --env-file "$NIX_DEPLOY_ENV" -f deploy/compose.prod.yml ps
docker compose -p nix --env-file "$NIX_DEPLOY_ENV" -f deploy/compose.prod.yml logs --since 10m nix-api nix-import-worker nix-export-worker
```

Treat logs as private: redact credentials, capability queries and document data before sharing.
Use `nixctl` or MCP for product state. A healthy worker only proves process/dependency checks;
a durable job can still retry without a visible UI error. Inspect failure codes and operation IDs.

The 2026-09-05 incident was `export_upload_failed` with a malformed HTTP/1 response containing
HTTP/2 frame bytes. The Go transfer transport inherited `h2` ALPN while disabling its HTTP/2
handler. Commit `77ef824a` aligns ALPN with HTTP/1.1; a TLS-server regression covers both upload
and download. Do not work around transfer failures by disabling TLS verification or widening
capability origins. A generic curl/Python S3 check does not exercise the actual worker transport.

For an application rollback with compatible schemas, select the prior committed checkout and
restore its recorded image matrix/configuration, then use the same release checks. Never rerun an
older document migrator against a newer schema without verifying support. For incompatible schema
changes, stop writers and use the tested database/object backup recovery procedure; image rollback
alone cannot reverse a migration. Retain both releases and backups until functional checks pass.

### Drift and clean-up

Compose recreates any service whose effective configuration differs from its running container,
including configuration once supplied by an old checkout or override. Before the first `up`, the
release runs `deploy/compose/drift.sh`, which warns when the running project's
`com.docker.compose.project.config_files` label names other files, lists the services Compose
will recreate or create, and exits 3 if `postgres` or `nix-versitygw` would be recreated. It also lists retained
services absent from the current manifest; `deploy.sh` stops the explicitly retired services
without deleting their volumes. Nothing has changed at that point. Compare the effective configuration with the running
containers; set `NIX_ALLOW_INFRA_RECREATE=1` only once the restart is understood and backed up.
Run the preview on its own with the release's Compose command:

```sh
bash deploy/compose/drift.sh docker compose -p nix --env-file "$NIX_DEPLOY_ENV" -f "$PWD/deploy/compose.prod.yml"
```

`bash deploy/compose/prune.sh` lists `~/nix-release-*` checkouts and `~/nix-backups/pre-*`
backups it would delete; add `--apply` to delete them. It keeps the running release (the
`nix-api` image tag), the one before it, anything newer, any checkout a container was created
from, and backups of those releases. It deletes nothing if the running tag has no checkout, and
never touches volumes, symbolic links, `~/nix-production` or the `nightly-*` backups that
`nightly.sh` manages. Order is directory modification
time, so review the dry run first.

`nix-api` has no Compose health check: the chiseled image contains only `dotnet`, with no shell,
`wget` or `curl`. Its liveness route is `/healthz` on port 8080, reachable only on the private
network. Public `/health` is served by the web fallback, so a 200 there does not prove Core is up.
