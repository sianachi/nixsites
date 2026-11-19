# Requirements

# Requirements

## A machine

- Linux on `amd64` or `arm64`.
- Docker Engine with Compose v2 that supports `docker compose up --wait`.
- Git, to check out the manifest and release scripts that match the images you run.
- Enough memory. The installer asks for at least 1 GB for Docker and warns below about 0.75 GiB. The stack idles at about 300 MB and was measured at about 600 MB with one person using it. Give it more as more people use it at once. These figures are estimates, not measurements:

  | Active people | Memory for Docker |
  | --- | --- |
  | 1 to 5 | 1 GB |
  | up to 25 | 2 GB |
  | more, or large imports and exports | 4 GB |

  The manifest sets a ceiling on each long-running service (PostgreSQL 2 GB, the Node service 1.25 GB, Core 768 MB), which is far above what a small install uses.
- Disk for PostgreSQL and your files, plus room for backups.

You do not need Node or .NET on the host. Everything runs from the published images. The Compose release scripts need Python 3 to check exported files.

For the Kubernetes path, you need a cluster instead. See [Kubernetes](nix://item/01a13137-c1a1-7f79-bfe5-4e7cad094458) for what it expects.

## A domain and HTTPS

Nix must be served over HTTPS at a single public origin, such as `https://<your-domain>`. The web container listens on plain HTTP inside the private Compose network and expects TLS to end in front of it, either at your own reverse proxy or at a tunnel. Signed file links are served from the same origin.

## A sites domain (optional)

To publish websites with Sites, you also need a domain for them, with a wildcard DNS record pointing at your deployment. With Docker Compose it must not share a registrable domain with the app, so a site can never read the app's cookies. The Kubernetes manifests serve sites under the app's own domain instead and take the precautions described in [Sites security](nix://item/01a13137-b4fc-7c7f-a661-d6f8280f80ab).

## Sign-in

Nix signs people in itself, so you do not need an identity provider. The first visit to `<origin>/setup` asks for the setup code (`NIX_AUTH_SETUP_CODE`, printed by the installer) and makes that person the administrator. After that, an administrator adds people from the People page, and each person chooses a password or registers a passkey. Nothing is emailed: you send the one-time link.

If you would rather use your own OpenID Connect provider, set `NIX_AUTH_MODE=oidc` (Compose) and give Nix the issuer URL and a client ID for an application with `https://<your-domain>` as its origin: `NIX_OIDC_ISSUER` and `NIX_OIDC_CLIENT_ID` with Compose, `OIDC_ISSUER` and `OIDC_CLIENT_ID` with the Kubernetes scripts. Nix uses the authorisation code flow with PKCE. Nothing is deployed for it.

## Bundled services

Both deployment paths run these for you:

- PostgreSQL 16 with pgvector;
- Versity, an S3-compatible gateway for file storage.

You can point Nix at an external S3-compatible store instead. See [Configuration](nix://item/01a130b0-14df-721e-b23c-3f24282e0eae).

## Keys you generate once

- **A P-256 signing key** for the short-lived access tokens Nix issues to browsers and `nixctl`.
- **A Web Push key pair** (VAPID) for push notifications. Push notifications will not work without it.

Keep both for the lifetime of the deployment. The installer generates them.

## Optional accounts

- **Google Cloud or Microsoft Entra** OAuth applications, for two-way calendar sync.
- **A ChatGPT account** for each person who wants to use the companion pet. Nobody needs one for anything else.

## Properties

- title: Requirements

