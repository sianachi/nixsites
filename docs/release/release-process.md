# Release process

## Versioning

Semantic versioning, `0.x` while the product is pre-1.0. The version is set in every `package.json`
(root, `apps/*`, `packages/*`) and in the MCP server identity (`apps/cli/src/mcp.ts`), all by
`scripts/release-version.sh`; the backend assembly takes the same
number through `Directory.Build.props` when it gains one. Production images are still addressed by
full commit SHA (`deploy/compose/release.sh <sha>`); a version tag names which SHA a release is.

A version is a commit on `main` tagged `vX.Y.Z`, with images for that SHA in GHCR under the same
tag. It covers everything a person or a self-hoster meets: the web app, `nixctl` and its MCP tools,
the install files and the data an install keeps.

### Which number moves

- **Patch (`0.x.y`):** the Unreleased section holds only Fixed or Security entries.
- **Minor (`0.x.0`):** it holds an Added, Changed, Deprecated or Removed entry, or a breaking change
  while the product is pre-1.0.
- **Major (`1.0.0`):** when the public API, the `.nix` archive and the install path are promised
  stable. After 1.0, a breaking change moves the major number.

A change is breaking when any of these hold:

- Upgrading needs a step: a new required setting or secret, a manual migration, a changed install
  command.
- A script that worked stops working: a removed or renamed `/api/v1` field, `nixctl` command or
  flag, or MCP tool or argument.
- The previous version can no longer read what this one writes, so a rollback would lose data. The
  additive migration rule below keeps the database out of this case.

The changelog lists every breaking change under Changed, starting with `**Breaking:**` and saying
the step to take.

The number is not chosen by hand: `scripts/release-version.sh` with no argument reads the
Unreleased section and applies these rules. Pass `X.Y.Z` only to override it.

### Surfaces with their own version

These move on their own and do not follow the product number. Bump one when an older reader can
no longer read what a newer writer produces, and note it in the changelog.

- `/api/v1` and `/public/v1`: a breaking change ships as a new path version, with the OpenAPI
  breaking-change label and an ADR. Additive fields stay in `v1`.
- The `.nix` archive: `formatVersion` and `schemaVersion` in the manifest
  (`packages/export/src/manifest.ts`).
- Note bodies: `SCHEMA_VERSION` and the per-node minimums in `packages/editor-schema/src/versions.ts`,
  which the collab protocol checks on connect.
- The database: forward-only migrations, with no version number of their own.

## Cadence

A minor release when a stage of planned work has merged and soaked on production for a week; a
patch when fixes are waiting. No fixed calendar.

## Stabilisation criteria

- `main` green: CI frontend, backend and images workflows, including the post-merge backend plan evidence job.
- The deploy smoke (`release-tools smoke`) passes on the target host against the release SHA.
- No open [SEC] finding on surfaces the release touches; migrations reviewed by the backend-data
  specialist.
- Changelog entry written; user-facing help updated in the Nix Docs workspace.

## Changelog

`CHANGELOG.md` follows Keep a Changelog: an `Unreleased` section, then one section per version with
Added, Changed, Fixed, Security. Entries say what a person can now do, not which file changed.

## Upgrade path

- Migrations are additive and run by the `migrator` image before the API starts; a release never
  drops or rewrites a column in the same version that stops reading it.
- Test each migration on a scratch database built from migrations (not the dev DB, which has
  drifted) and on a copy of the production backup when the migration touches an existing table.
- Clients tolerate one version of skew: new nullable fields default; unknown enum tokens read as
  the default.

## Rollback and recovery

Roll back by releasing the previous SHA (`release.sh <previous>`); the ledger in
`NIX_RELEASE_LEDGER` records it. Migrations are forward-only, so a rollback must stay compatible
with the newer schema, which the additive rule guarantees. Data recovery follows the backup
runbooks.

## Hotfixes

Branch `hotfix/<slug>` from the released SHA, merge to `main` through a PR, release the new SHA,
tag `v0.x.(y+1)`.
