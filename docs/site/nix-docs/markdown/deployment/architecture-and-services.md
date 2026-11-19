# Architecture and services

A Nix deployment is a handful of small services around one PostgreSQL database. Each has one job, and only Core decides who may see or change what.

## The services

| Service | Image | What it does |
| --- | --- | --- |
| Core API | api | The ASP.NET Core service on port 8080. It owns items, properties, views, permissions, sign-in and search, signs every storage link, and runs the background jobs. It is the only permission authority. |
| Migrator | migrator | A one-shot job that applies Core's database migrations. Core never migrates its own schema at start-up. |
| Node service | collab | One Node process on port 8100 (collaboration), with two more roles. Collaboration holds live document editing (Yjs), document history and version checkpoints, and assembles imports and exports. It asks Core to authorise every session. See below. It must run as exactly one instance: a second one refuses connections rather than splitting a document's state. |
| Web | web | The installed web app, served by Caddy on port 8090. Caddy also routes the API, collaboration and storage paths, so the whole product sits behind one origin. The installer makes Caddy the public listener on ports 80 and 443 and fetches the TLS certificates. |
| MCP | release-tools | Remote MCP over Streamable HTTP at /mcp, on port 8500. It holds no credential of its own: each request carries its own token and Core authorises every call. Always on with the installer; optional with Compose by hand (the mcp profile). |
| Sites serve | sites | Optional. Serves published websites to anonymous readers. It has no database and no Core secret, only a key to read the sites bucket. |
| Pet browser | browser | Optional. A sandboxed browser for companion runs, off unless the pet-browser profile is selected. |
| PostgreSQL | pgvector/pgvector:pg16 | All durable state, with row-level security, and full-text search. |
| Object store | versity/versitygw | An S3-compatible gateway that stores file bytes on disk. Any S3-compatible store can replace it. |
| Tunnel | cloudflare/cloudflared | Optional public ingress without opening ports. Not started by the installer. |

Nix builds seven images itself, listed under [Images and tags](nix://item/01a13137-c3f3-7efb-8afc-83357024c5b5). Nothing runs RabbitMQ, a separate worker binary or an identity provider.

## The Node service roles

One image, one process, three roles, chosen with `NIX_NODE_ROLES` as a comma-separated list:

| Role | Port | Work |
| --- | --- | --- |
| collab | 8100 | Live document editing, history, and the assembly of imports and exports |
| companion | 8302 | The pet companion's model calls and tools. It holds no database or storage credential |
| sites-worker | 8301 | Builds published websites from the manifest Core freezes, and writes them to the sites bucket |

When the variable is unset, all three run. The Compose manifest starts `collab,companion`, and adds `sites-worker` when `NIX_SITES_DOMAIN` is set. The Kubernetes manifests run all three in one pod.

## Background jobs

Core runs its own background jobs: document and file imports, native `.nix`, Markdown, PDF and Word exports, two-way Google and Outlook calendar sync, Web Push delivery and indexing. There is no separate worker service. Jobs are rows in PostgreSQL, so a restart does not lose them.

## How the services talk

**Sign-in goes through Core.** Core signs people in itself (`NIX_AUTH_MODE=local`): passwords, passkeys and authenticator codes, with a setup code on the first visit and a People page for administrators. The browser holds an opaque, HttpOnly session cookie and receives short-lived access tokens that Core signs itself with a P-256 key. Those tokens carry identity, never roles: permission is decided by Core on every request. `nixctl` and personal access tokens use a token exchange at `/public/v1/auth/token`. Instead of local sign-in, Core can run the OpenID Connect authorisation code flow with PKCE against a provider you run (`NIX_AUTH_MODE=oidc`, which needs `OIDC_ISSUER` and `OIDC_CLIENT_ID` on Kubernetes, `NIX_OIDC_ISSUER` and `NIX_OIDC_CLIENT_ID` with Compose). Provider tokens then stay on the server.

**Hosted AI connectors sign in with OAuth.** For remote MCP, Core is also a small OAuth 2.1 authorisation server, so hosted clients such as Claude or ChatGPT can connect through a consent page in the browser. This needs the public https origin. Other clients use a personal access token.

\*\*Services call each other over \*\*`/internal`. Collaboration, the companion and the sites worker call Core's internal routes with a shared secret in a request header. A missing or wrong secret is answered with `404`, not `401`, so the routes do not advertise themselves, and they are left out of the public API description. Routes that act for a person also need that person's forwarded token.

**Jobs are rows in PostgreSQL.** Core writes each job to a table in the same transaction as the change that caused it, and its in-process workers lease and run them. Nothing durable lives in a message broker, because there is none.

**File bytes never pass through Core.** Core signs short-lived capability URLs on the object store's public origin, and browsers upload and download directly. The sites worker only accepts storage URLs on origins listed in its configuration, and access tokens are never sent to storage.

## Public routes

Caddy in the web container routes one public origin:

| Path | Destination |
| --- | --- |
| /api/, /auth/, /public/v1/auth/token, /public/v1/links/, /public/v1/forms/ | Core |
| /mcp, /mcp/pets/\* | The MCP service |
| /.well-known/oauth-protected-resource\*, /.well-known/oauth-authorization-server, /.well-known/webauthn | Core |
| /collab/\* | Collaboration, with the prefix removed; WebSocket upgrades must be allowed |
| /\<bucket>/\* | The object store, with the signed Host header kept |
| everything else | The web app, falling back to index.html for deep links |

On Kubernetes an Ingress sends `/mcp` to the MCP service instead of Caddy.

With Sites enabled, requests for one-label hosts under the sites domain go to the sites serving process instead. Anything else on that listener is refused with `421`.

## Properties

- title: Architecture and services

