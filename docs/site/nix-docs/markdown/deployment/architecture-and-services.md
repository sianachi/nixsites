# Architecture and services

A Nix deployment is a handful of small services around one PostgreSQL database. Each has one job, and only Core decides who may see or change what.

## The services

| Service | Image | What it does |
| --- | --- | --- |
| Core API | api | The ASP.NET Core service on port 8080. It owns items, properties, views, permissions, sign-in, jobs and search, and signs every storage link. It is the only permission authority. |
| Migrator | migrator | A one-shot job that applies Core's database migrations. Core never migrates its own schema at start-up. |
| Collaboration | collab | The Node service (`nix-node`, which also runs the pet companion and the sites worker) on port 8100 that holds live document editing (Yjs), document history and version checkpoints, and assembles imports and exports. It asks Core to authorise every session. It must run as exactly one instance: a second one refuses connections rather than splitting a document's state. |
| Web | web | The installed web app, served by Caddy on port 8090. Caddy also routes the API, collaboration and storage paths, so the whole product sits behind one origin. |
| Sites worker | sites | Optional. Builds published websites from the build manifest Core freezes, and writes them to the sites bucket. |
| Sites serve | sites | Optional. Serves published websites to anonymous readers. It has no database and no Core secret, only a key to read the sites bucket. |
| PostgreSQL | pgvector/pgvector:pg16 | All durable state, with row-level security, and full-text search. |
| Object store | versity/versitygw | An S3-compatible gateway that stores file bytes on disk. Any S3-compatible store can replace it. |
| Identity provider | ghcr.io/zitadel/zitadel | Sign-in through OpenID Connect. The Kubernetes manifests include Zitadel; with Compose you bring your own provider. |
| Tunnel | cloudflare/cloudflared | Optional public ingress without opening ports. |

The five images Nix builds itself, plus a `release-tools` image used by release scripts, are published for every commit.

## Background jobs

Imports, exports, file publication, template file copies, object cleanup, calendar sync and push delivery run as background jobs inside Core, leased from the `worker_job` table and renewed while they run. A job Core was running when it restarted is marked failed and can be retried. Collaboration, the pet companion and the sites worker run together in one Node service (`nix-node`); the companion calls Core over the internal API and holds no database or storage credential.

## How the services talk

**Browser sign-in goes through Core.** Core runs the OpenID Connect authorisation code flow with PKCE as a backend-for-frontend. Provider tokens stay on the server. The browser holds an opaque, HttpOnly session cookie and receives short-lived access tokens that Core signs itself with a P-256 key. Those tokens carry identity, never roles: permission is decided by Core on every request. `nixctl` and personal access tokens use a token exchange at `/public/v1/auth/token`.

**Services call each other over **`/internal`. Collaboration, the workers and the sites worker call Core's internal routes with a shared secret in a request header. A missing or wrong secret is answered with `404`, not `401`, so the routes do not advertise themselves, and they are left out of the public API description. Routes that act for a person also need that person's forwarded token; worker routes take their workspace from the job they are running.

**PostgreSQL is the record of every job.** Jobs are rows in `worker_job`, leased and renewed by Core's own background hosts. A restart marks the jobs that were running as failed, so they can be retried.

**File bytes never pass through Core.** Core signs short-lived capability URLs on the object store's public origin, and browsers and workers upload and download directly. Workers only accept storage URLs on origins listed in their configuration, and access tokens are never sent to storage.

## Public routes

Caddy in the web container routes one public origin:

| Path | Destination |
| --- | --- |
| /api/\*, /auth/\*, /public/v1/auth/token | Core |
| /collab/\* | Collaboration, with the prefix removed; WebSocket upgrades must be allowed |
| /\<bucket>/\* | The object store, with the signed Host header kept |
| everything else | The web app, falling back to index.html for deep links |

With Sites enabled, requests for one-label hosts under the sites domain go to the sites serving process instead. Anything else on that listener is refused with `421`.

## Properties

- title: Architecture and services

