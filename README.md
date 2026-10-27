# Nix

A self-hosted workspace for one person or a small group: notes, tasks, habits, journal, files,
calendar and numbers in one item tree, on a laptop and on a phone. Everything stays exportable.

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
  CLI and MCP server share one authorization path.
- **No lock-in.** Lossless `.nix` archives, plus PDF, DOCX and Markdown export; Markdown, DOCX, PDF
  and Obsidian import.
- **Scriptable.** `nixctl` is a JSON CLI, and `nixctl mcp` exposes the workspace to AI tools.
- **Publish a subtree** as a static site. This documentation is one: <https://nix.nixsites.com>.

The full list is in [docs/features.md](docs/features.md).

## Run it for real

Try it on your own machine with one line; all it needs is Docker:

```sh
curl -fsSL https://raw.githubusercontent.com/sianachi/nixsites/main/deploy/install.sh | bash
```

Then open <http://nix.localhost> in Chrome or Firefox and sign in with the details it prints.
(Safari does not resolve `.localhost` names: add `127.0.0.1 nix.localhost auth.nix.localhost` to
`/etc/hosts` first.)

The same line with a public origin is a real install, from the CI-built multi-architecture
images at `ghcr.io/sianachi/nix`:

```sh
curl -fsSL https://raw.githubusercontent.com/sianachi/nixsites/main/deploy/install.sh | bash -s -- https://nix.example.org
```

**Before you run it:** point `nix.example.org` and `auth.nix.example.org` at the machine and leave
ports 80 and 443 free. Docker with the Compose plugin, `curl`, `openssl` and `jq` must be installed.
Give Docker at least 8 GB of memory: the stack runs Postgres, RabbitMQ, an object store, the
identity provider and nine Nix services, and a smaller Docker VM thrashes.

**What it does:** generates every secret into `~/nix/nix.env`, starts Postgres, RabbitMQ, the
object store and a bundled identity provider (Zitadel) behind Caddy, which fetches the TLS
certificates itself; registers the web application with the identity provider; runs the database
migrations; starts every service; prints the administrator sign-in (`admin@nix.auth.<host>` and
a one-time password you must change at first sign-in).

**Options**

| Flag | Meaning |
| --- | --- |
| `--version vX.Y.Z` | Install that release instead of the latest; the same flag upgrades a running install |
| `--dir <path>` | State directory (default `~/nix`) |
| `--kubernetes` | Install into the current `kubectl` context (namespace `nix`) instead of Docker |

**Upgrade:** run the same line again with `--version <newer release>`. The env file is kept,
migrations run, and services restart on the new images. Back up `~/nix/nix.env` together with the
Docker volumes (`nix-*`); the env file holds every secret and cannot be regenerated.

**Kubernetes:** the cluster needs an ingress controller listening on the origin's port and a
default StorageClass; the installer reads the IngressClass, StorageClass and pod CIDR from the
cluster (`--ingress-class`, `--storage-class`, `--pod-cidr` override). Certificates: pass
`--tls-cert`/`--tls-key` with a PEM pair covering `<host>` and `*.<host>`, or
`--cluster-issuer <name>` for cert-manager (no wildcard then, so published sites need DNS-01),
or let it make a self-signed pair for a try-out. State is `~/nix/kubernetes.env` plus the
secrets in the namespace. The manifests are in `deploy/k8s`.

**Images and tags:** every commit on `main` is published as `ghcr.io/sianachi/nix/<image>:<sha>`;
pushing a `vX.Y.Z` tag names that commit's images `vX.Y.Z` and `latest`, which the installer
uses by default. `--version` also accepts a full commit SHA.

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

## Contributing

Read [AGENTS.md](AGENTS.md) first; it links the focused guides for backend, frontend, workers and
validation. Day-to-day commands are in [docs/development.md](docs/development.md). Before opening a PR, run `./scripts/changed-path-checks.sh --working-tree` and then
`./scripts/validate-changed.sh --working-tree`. Generated OpenAPI and client code is never edited by hand.

Bug reports and ideas are welcome as issues.

## Licence

[MIT](LICENSE)
