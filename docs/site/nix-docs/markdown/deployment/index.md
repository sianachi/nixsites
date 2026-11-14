# Deployment

# Deployment

Nix is designed to run on hardware you control. One command installs it on a machine with Docker, or into a Kubernetes cluster: see [Install in one line](nix://item/01a16030-a2fa-76fd-bef3-cb99a1a146d0). Both paths run the same container images, which CI builds for every commit on `main` and publishes to the GitHub Container Registry for `linux/amd64` and `linux/arm64`:

- **Docker Compose** on one machine. This is the default target, with a one-command release script that backs up, migrates and smoke-tests.
- **Kubernetes**, with the identity provider and the sites services included. The manifests default to a small k3s cluster behind Cloudflare and take a few settings for any other cluster.

Start with the architecture, then pick a path.

## How the pieces fit

```mermaid
%% diagram
flowchart TB
  Browser[Web app and installed app] --> Edge[Web container with Caddy]
  CLI[nixctl and MCP] --> Edge
  Edge --> Core[Core API]
  Edge --> Collab[Collaboration service]
  Edge --> Store[(S3-compatible object store)]
  Core --> PG[(PostgreSQL)]
  Collab --> PG
  Core --> MQ[RabbitMQ]
  MQ --> Workers[Go workers: import, export, plugins, calendar, notify]
  Workers --> Core
  Workers --> Store
  Core --> IdP[OIDC identity provider: bundled Zitadel or your own]
```

- **Core** (ASP.NET Core) is the only permission authority. It owns items, properties, views, jobs and sign-in.
- **Collaboration** (Node) stores document edits and history, and assembles imports and exports.
- **Workers** (Go) run background jobs. They never hold database credentials; they act through narrow, authorised APIs.
- **PostgreSQL** holds all durable state, with row-level security, and runs full-text search.
- **The object store** holds file bytes. Browsers reach it through short-lived signed links.
- **Sites**, when enabled, adds a build worker and a separate serving process for published websites.

## Properties

- title: Deployment

