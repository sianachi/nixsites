# Nix (nixsites) — self-hosted workspace

[![Release](https://img.shields.io/github/v/release/sianachi/nixsites?label=release)](https://github.com/sianachi/nixsites/releases/latest)
[![Licence](https://img.shields.io/github/license/sianachi/nixsites?label=licence)](LICENSE)
[![CI backend](https://github.com/sianachi/nixsites/actions/workflows/ci-backend.yml/badge.svg)](https://github.com/sianachi/nixsites/actions/workflows/ci-backend.yml)
[![CI frontend](https://github.com/sianachi/nixsites/actions/workflows/ci-frontend.yml/badge.svg)](https://github.com/sianachi/nixsites/actions/workflows/ci-frontend.yml)
[![Container image](https://img.shields.io/badge/ghcr.io-sianachi%2Fnix-2496ED?logo=docker&logoColor=white)](https://github.com/sianachi/nixsites/packages)
[![GitHub stars](https://img.shields.io/github/stars/sianachi/nixsites)](https://github.com/sianachi/nixsites)

Nix ([nixsites](https://github.com/sianachi/nixsites)) is a self-hosted, open-source alternative to
Notion and Obsidian: notes, tasks, habits, journal, files, calendar and finance in one item tree,
for one person or a small group.

It syncs in real time with CRDTs, offers a CLI and an MCP server for AI tools, exports with no
lock-in, and can publish a subtree as a static site.

**[Live demo and docs](https://nix.nixsites.com/).** That site is itself a Nix workspace, published
as a static site.

![A launch plan on a board in Nix](assets/screenshots/board.png)

## What it does

- **One tree, many views.** A body (note, canvas or spreadsheet) is separate from how its children are
  shown: list, board, calendar, timeline, gallery, spreadsheet, chart, habit tracker, finance ledger.
- **Structure you shape yourself.** Property schemas, formulas, rollups, templates and automations,
  plus a companion that builds structure on request, with every plan previewed before it runs.
- **Real-time editing.** CRDT-synced notes with presence, version history and password-locked subtrees.
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
- **Publish a subtree** as a static site. The [live demo](https://nix.nixsites.com/) above is one.

The full list is in [docs/features.md](docs/features.md).

## Screenshots

One tree of items, shown the way each job needs. All data here is made up.

| | |
| --- | --- |
| ![Timeline](assets/screenshots/timeline.png)<br>**Timeline** | ![Calendar](assets/screenshots/calendar.png)<br>**Calendar** |
| ![Spreadsheet](assets/screenshots/sheet.png)<br>**Spreadsheet** | ![List](assets/screenshots/list.png)<br>**List** |
| ![Priority matrix](assets/screenshots/matrix.png)<br>**Matrix** | ![Notes](assets/screenshots/note.png)<br>**Rich notes** |
| ![Finance](assets/screenshots/finance.png)<br>**Finance** | ![Habits](assets/screenshots/habits.png)<br>**Habits** |
| ![Companion chat](assets/screenshots/chat.png)<br>**Companion chat** | ![Dark theme](assets/screenshots/dark.png)<br>**Dark theme** |

**On a phone.** Nix installs as an app, with the same views and a share target.

<img src="assets/screenshots/mobile-board.png" alt="Board on a phone" width="150"> <img src="assets/screenshots/mobile-calendar.png" alt="Calendar on a phone" width="150"> <img src="assets/screenshots/mobile-note.png" alt="Note on a phone" width="150"> <img src="assets/screenshots/mobile-habits.png" alt="Habits on a phone" width="150"> <img src="assets/screenshots/mobile-finance.png" alt="Finance on a phone" width="150"> <img src="assets/screenshots/mobile-chat.png" alt="Companion chat on a phone" width="150">

## How it compares

Nix is for a workspace you run yourself: structured views, and a copy of the data you can take with you.

| | Nix | Notion | Obsidian |
| --- | --- | --- | --- |
| Where it runs | Your machine or server, with Docker or Kubernetes | Notion's hosted service | A folder of Markdown on your devices. Sync is [Obsidian Sync](https://obsidian.md/sync) or your own |
| Licence | [MIT](LICENSE) | Proprietary | Proprietary. Free for personal use |
| Shape | One item tree: lists, boards, calendars, sheets, habits, finance and the rest | Pages and databases | Notes, plus a large plugin ecosystem |
| Editing together | Real-time CRDT editing, with presence, for a small group | Real-time collaboration | Files synced between devices |
| Leaving | Lossless `.nix` archives, plus PDF, DOCX and Markdown. An Obsidian vault can be imported | Markdown, HTML and CSV export | The notes are already files |
| Tools | [`nixctl`](docs/features.md) and an MCP server. Publish a subtree as a static site | The Notion API, and Notion Sites | Plugins, and [Obsidian Publish](https://obsidian.md/publish) or your own site |

[Anytype](https://anytype.io/) and [AFFiNE](https://affine.pro/) are the other projects people try for
this. Anytype is local-first: the sync protocol is open source and a self-hosted node is
[documented](https://tech.anytype.io/how-to/self-hosting), and the apps are source-available.
AFFiNE is a self-hostable workspace of documents and a whiteboard. Nix keeps tasks, habits, journal,
files, calendar and finance in that same tree, and adds the CLI, the MCP server and static-site
publishing above.

## Run it for real

Read [deploy/install.sh](deploy/install.sh) before you pipe it to a shell. It needs Docker with
the Compose plugin, `curl`, `openssl`, `jq`, and about 8 GB of memory for Docker. The stack runs
Postgres, RabbitMQ, an object store, the identity provider and eight Nix services (API,
collaboration, web, and the import, export, plugin, calendar and notification workers). A default
Docker Desktop VM is often 2 to 4 GB, and a smaller limit thrashes. The script stops if a tool is
missing, and warns when Docker has less than about 8 GB.

```sh
curl -fsSL https://raw.githubusercontent.com/sianachi/nixsites/main/deploy/install.sh | bash
```

Open <http://nix.localhost> in Chrome or Firefox and sign in with the details it prints.
Safari does not resolve `.localhost` names: add `127.0.0.1 nix.localhost auth.nix.localhost` to
`/etc/hosts` first.

The same line with a public origin is a real install, using the images at `ghcr.io/sianachi/nix`:

```sh
curl -fsSL https://raw.githubusercontent.com/sianachi/nixsites/main/deploy/install.sh | bash -s -- https://nix.example.org
```

Point `nix.example.org` and `auth.nix.example.org` at the machine and leave ports 80 and 443 free.

The script writes every secret into `~/nix/nix.env` and prints an administrator sign-in. Back that
file up with the Docker volumes (`nix-*`); it cannot be regenerated.

Flags, what the installer starts, upgrades, Kubernetes and image tags are in
[docs/install.md](docs/install.md).

## Run it locally

You need [Docker](https://docs.docker.com/get-docker/) and [mise](https://mise.jdx.dev/).

```sh
git clone https://github.com/sianachi/nixsites.git && cd nixsites
mise install                       # Node, pnpm, .NET and Go at the pinned versions
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
Node 22 collaboration service (CRDT over WebSocket) · Go workers on RabbitMQ · OIDC login (Zitadel).

```
apps/web         React app, installable as a PWA
apps/collab      Collaboration service
apps/go-workers  Import, export, plugin, calendar and notification workers
apps/cli         nixctl and the MCP server
apps/sites       Static site builder and server
backend/         Core API (ASP.NET) and the migrator
packages/        Shared libraries
deploy/          Compose manifests, images, seed and backup scripts
```

## API

The REST API is a way to use Nix, with the web app, `nixctl`, and MCP. [The API guide](docs/site/nix-docs/markdown/api/index.md) covers tokens, the first request in curl, Python, and TypeScript, resources, errors, and limits. The browsable reference generated from the OpenAPI document is [docs/site/nix-docs/generated/reference.html](docs/site/nix-docs/generated/reference.html). The same text is on the [docs site](https://nix.nixsites.com) once that guide is published there.

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md): how to run Nix, check a change and open a pull
request. Issues labelled [good first issue](https://github.com/sianachi/nixsites/labels/good%20first%20issue)
are sized for a first change. [AGENTS.md](AGENTS.md) is the map of path-by-path rules for people and
for assistants; it links the focused guides.

Day-to-day commands are in [docs/development.md](docs/development.md). Before opening a PR, run
`./scripts/changed-path-checks.sh --working-tree` and then `./scripts/validate-changed.sh --working-tree`.
Generated OpenAPI and client code is never edited by hand.

## Licence

[MIT](LICENSE)

## Star, or open an issue

If Nix is the workspace you wanted, [star the repository](https://github.com/sianachi/nixsites) so
other people can find it. A bug or an idea belongs in an
[issue](https://github.com/sianachi/nixsites/issues/new/choose).
