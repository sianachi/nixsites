# Nix (nixsites): a workspace for people and their AI agents

[![Release](https://img.shields.io/github/v/release/sianachi/nixsites?label=release)](https://github.com/sianachi/nixsites/releases/latest)
[![Licence](https://img.shields.io/github/license/sianachi/nixsites?label=licence)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/sianachi/nixsites)](https://github.com/sianachi/nixsites)
[![CI backend](https://github.com/sianachi/nixsites/actions/workflows/ci-backend.yml/badge.svg)](https://github.com/sianachi/nixsites/actions/workflows/ci-backend.yml)
[![CI frontend](https://github.com/sianachi/nixsites/actions/workflows/ci-frontend.yml/badge.svg)](https://github.com/sianachi/nixsites/actions/workflows/ci-frontend.yml)
[![Container image](https://img.shields.io/badge/ghcr.io-sianachi%2Fnix-2496ED?logo=docker&logoColor=white)](https://github.com/sianachi/nixsites/packages)

If Nix is useful to you, [star the repository](https://github.com/sianachi/nixsites) so other people
can find it.

Nix ([nixsites](https://github.com/sianachi/nixsites)) is a free, open-source workspace you run on
your own machine or server, where people and their AI agents work together: notes, tasks, habits,
calendars, spreadsheets, files and automations in one place.

Every workspace has an AI companion that can do anything you can do and asks before it changes
anything. Your own agents reach the same workspace through `nixctl` and its MCP server, under the
same permissions. Nix syncs in real time, exports with no lock-in, and can publish any item, and
what is under it, as a static site.

**What's new in 0.7.** [v0.7.0](https://github.com/sianachi/nixsites/releases/tag/v0.7.0) adds desktop
apps for macOS, Windows and Linux (early: unsigned, no auto-update, and the Windows and Linux builds
are untested), publishing any item as a site, workspace passwords, and a template library on every
install.

**[Live demo and docs](https://nix.nixsites.com/).** That site is itself a Nix workspace, published
as a static site.

## Install

Read [deploy/install.sh](deploy/install.sh) before you pipe it to a shell. It needs Docker with
the Compose plugin, `curl`, `openssl`, `jq`, and about 4 GB of memory for Docker.

```sh
curl -fsSL https://raw.githubusercontent.com/sianachi/nixsites/main/deploy/install.sh | bash
```

Open <http://nix.localhost> in Chrome or Firefox, go to the setup page the script prints and enter
the setup code. Safari does not resolve `.localhost` names: add `127.0.0.1 nix.localhost` to
`/etc/hosts` first. A public hostname, Kubernetes and backups are in [Run it for real](#run-it-for-real).

Demo recording:

https://github.com/user-attachments/assets/45a8a3df-a709-4c86-b762-895fcc0fffa5

## What it does

- **One tree, many views.** A body (note, canvas, spreadsheet or artifact) is separate from how its
  children are shown: list, board, calendar, timeline, gallery, spreadsheet, chart, checklist, matrix,
  outline, form, smart list, drive and habit tracker.
- **Structure you shape yourself.** Property schemas, formulas, rollups, templates and automations,
  plus a companion that builds structure on request, with every plan previewed before it runs.
- **Real-time editing.** CRDT-synced notes with presence, comments, suggestions, version history and
  password-locked subtrees and workspaces.
- **Quiet reminders and sync.** Due tasks and habits arrive as push notifications; Google and Outlook
  calendars sync both ways with a visible log.
- **Safe by construction.** Permissions are enforced by Postgres row-level security, and the web app,
  CLI and MCP server share one authorisation path.
- **No lock-in.** Lossless `.nix` archives, plus PDF, DOCX and Markdown export; Markdown, DOCX, PDF
  and Obsidian import.
- **Scriptable.** `nixctl` is a JSON CLI, and `nixctl mcp` exposes the workspace to AI tools.
- **HTTP API.** The same workspace is a REST API. Create a personal access token, exchange it at
  `POST /public/v1/auth/token`, and call `/api/v1`. Start with [the API guide](docs/site/nix-docs/markdown/api/index.md);
  the contract is [backend/openapi/nix-api.json](backend/openapi/nix-api.json).
- **Publish any item** and what is under it as a static site, or share a single note or file with a
  public link. The [live demo](https://nix.nixsites.com/) above is a published site.

The full list is in [docs/features.md](docs/features.md).

## Apps

Every app talks to the same server. The iOS, Android and desktop apps ask for your server's address, then
open that server's own web app, so they stay in step with it.

| App | Runs on | What it does |
| --- | --- | --- |
| Web (`apps/web`) | Any modern browser | The full app, installable as a PWA with a share target |
| iOS (`apps/mobile`) | iPhone and iPad | The web app with full offline sync: open it, edit notes, work with files, and create, rename, move or trash items with no connection. Changes sync when you are back online |
| Android (`apps/mobile`) | Android phones and tablets | The web app in a native shell. No offline sync or passkey sign-in yet |
| Desktop (`apps/desktop`) | macOS, Windows, Linux | The iOS app's offline sync on the desktop, with sign-in in your normal browser. Early: unsigned, no auto-update, and the Windows and Linux builds are untested |
| `nixctl` (`apps/cli`) | Any machine with Node | A JSON CLI for scripts, and `nixctl mcp` for AI tools |

The native apps are not in an app store, so build them from source.

```sh
pnpm --filter @nix/mobile sync && pnpm --filter @nix/mobile open                  # iOS, in Xcode
pnpm --filter @nix/mobile sync:android && pnpm --filter @nix/mobile open:android  # Android, in Android Studio
pnpm --filter @nix/desktop package                                                # desktop, into apps/desktop/dist
```

## How it compares

Nix is for a workspace you run yourself: structured views, and a copy of the data you can take with you.

| | Nix | Notion | Obsidian |
| --- | --- | --- | --- |
| Where it runs | Your machine or server, with Docker or Kubernetes | Notion's hosted service | A folder of Markdown on your devices. Sync is [Obsidian Sync](https://obsidian.md/sync) or your own |
| Licence | [AGPL-3.0](LICENSE), with [permissions](LICENSE-ADDITIONAL-PERMISSIONS.md) for your content and programs that use Nix | Proprietary | Proprietary. Free for personal use |
| Shape | One item tree: lists, boards, calendars, sheets, habits and the rest | Pages and databases | Notes, plus a large plugin ecosystem |
| Editing together | Real-time CRDT editing, with presence, for a small group | Real-time collaboration | Files synced between devices |
| Leaving | Lossless `.nix` archives, plus PDF, DOCX and Markdown. An Obsidian vault can be imported | Markdown, HTML and CSV export | The notes are already files |
| Tools | [`nixctl`](docs/features.md) and an MCP server. Publish a subtree as a static site | The Notion API, and Notion Sites | Plugins, and [Obsidian Publish](https://obsidian.md/publish) or your own site |

[Anytype](https://anytype.io/) and [AFFiNE](https://affine.pro/) are the other projects people try for
this. Anytype is local-first: the sync protocol is open source and a self-hosted node is
[documented](https://tech.anytype.io/how-to/self-hosting), and the apps are source-available.
AFFiNE is a self-hostable workspace of documents and a whiteboard. Nix keeps tasks, habits, journal,
files and calendar in that same tree, and adds the CLI, the MCP server and static-site
publishing above.

## Run it for real

The short path is [Install](#install). This section is what the script runs, a public hostname,
and what to back up.

Read [deploy/install.sh](deploy/install.sh) before you pipe it to a shell. It needs Docker with
the Compose plugin, `curl`, `openssl`, `jq`, and about 4 GB of memory for Docker. The stack runs
Postgres, an object store and three Nix services (API,
web, and one Node service for collaboration, the companion and the sites worker). A default
Docker Desktop VM can be as small as 2 GB, which is too little. The script stops if a tool is
missing, and warns when Docker has less than about 4 GB.

```sh
curl -fsSL https://raw.githubusercontent.com/sianachi/nixsites/main/deploy/install.sh | bash
```

Open <http://nix.localhost> in Chrome or Firefox, go to the setup page the script prints, and enter
the setup code it prints to create the first account (it becomes the administrator). Safari does not
resolve `.localhost` names: add `127.0.0.1 nix.localhost` to `/etc/hosts` first.

The same line with a public origin is a real install, using the images at `ghcr.io/sianachi/nix`:

```sh
curl -fsSL https://raw.githubusercontent.com/sianachi/nixsites/main/deploy/install.sh | bash -s -- https://nix.example.org
```

Point `nix.example.org` at the machine and leave ports 80 and 443 free. One hostname is enough:
Nix signs people in itself.

The script writes every secret into `~/nix/nix.env` and prints the setup code for the first account.
Back that file up with the Docker volumes (`nix-*`); it cannot be regenerated. Add other people from
the People page in the settings: each gets a one-time link, valid for an hour, to set a password or a
passkey, and the same page issues a new link when someone is locked out. An install made
with the earlier bundled Zitadel must run `install.sh --migrate-local-auth` to upgrade (see
[docs/install.md](docs/install.md)).

Flags, what the installer starts, upgrades, Kubernetes and image tags are in
[docs/install.md](docs/install.md).

## Run it locally

You need [Docker](https://docs.docker.com/get-docker/) and [mise](https://mise.jdx.dev/).

```sh
git clone https://github.com/sianachi/nixsites.git && cd nixsites
mise install                       # Node, pnpm and .NET at the pinned versions
pnpm install --frozen-lockfile
pnpm dev                           # infrastructure, database, identity, then every service
```

Open <http://localhost:5173> and sign in as `dev@nix.localhost` with `NixDev-Password1!`.
These are local development credentials only.

`pnpm dev` is safe to re-run. Use `bash scripts/dev.sh --help` to start only some services, or
`--skip-stack` when the Docker infrastructure is already up. If a port is taken, see `.env.example`.

Working in JetBrains Rider? `node --experimental-strip-types scripts/rider-run-configs.mts` writes
Run/Debug configurations for each service.

## Stack

ASP.NET Core 10 and Postgres 16 (row-level security, pgvector) · React 19, TypeScript, Tailwind v4 ·
Node 22 collaboration service (CRDT over WebSocket) · background jobs inside Core · sign-in built in (or OIDC).

```
apps/web         React app, installable as a PWA
apps/collab      Collaboration service
apps/companion   Companion (codex app-server)
apps/node-host   One process for collab, companion and the sites worker
apps/cli         nixctl and the MCP server
apps/mobile      iOS and Android shell (Capacitor)
apps/desktop     macOS, Windows and Linux shell (Electron)
apps/sites       Static site builder and server
backend/         Core API (ASP.NET) and the migrator
packages/        Shared libraries
deploy/          Compose manifests, images, seed and backup scripts
```

## API

The REST API is a way to use Nix, with the web app, `nixctl`, and MCP. [The API guide](docs/site/nix-docs/markdown/api/index.md) covers tokens, the first request in curl, Python, and TypeScript, resources, errors, and limits. The browsable reference generated from the OpenAPI document is [docs/site/nix-docs/generated/reference.html](docs/site/nix-docs/generated/reference.html).

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md): how to run Nix, check a change and open a pull
request. Issues labelled [good first issue](https://github.com/sianachi/nixsites/labels/good%20first%20issue)
are sized for a first change. [AGENTS.md](AGENTS.md) is the map of path-by-path rules for people and
for assistants; it links the focused guides.

Day-to-day commands are in [docs/development.md](docs/development.md). Before opening a PR, run
`./scripts/changed-path-checks.sh --working-tree` and then `./scripts/validate-changed.sh --working-tree`.
Generated OpenAPI and client code is never edited by hand.

## Licence

[AGPL-3.0-only](LICENSE), with [additional permissions](LICENSE-ADDITIONAL-PERMISSIONS.md)
for your content and programs that use Nix. Using Nix, including at work, asks nothing of
you; see [what AGPL means for you](docs/licensing.md). A commercial licence is also available.

## Star, or open an issue

If Nix is the workspace you wanted, [star the repository](https://github.com/sianachi/nixsites) so
other people can find it. A bug or an idea belongs in an
[issue](https://github.com/sianachi/nixsites/issues/new/choose).
