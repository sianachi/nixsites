# Requirements

# Requirements

## A machine

- Linux on `amd64` or `arm64`.
- Docker Engine with Compose v2 that supports `docker compose up --wait`.
- Git, to check out the manifest and release scripts that match the images you run.
- Enough memory for the services. The manifest caps the long-running services at roughly 8.5 GB in total, with PostgreSQL allowed 2 GB. A machine with 8 GB of RAM or more is a sensible starting point for a household or small team.
- Disk for PostgreSQL and your files, plus room for backups.

You do not need Node, .NET or Go on the host. Everything runs from the published images. The Compose release scripts need Python 3 to check exported files.

For the Kubernetes path, you need a cluster instead. See [Kubernetes](nix://item/01a13137-c1a1-7f79-bfe5-4e7cad094458) for what it expects.

## A domain and HTTPS

Nix must be served over HTTPS at a single public origin, such as `https://<your-domain>`. The web container listens on plain HTTP inside the private Compose network and expects TLS to end in front of it, either at your own reverse proxy or at a tunnel. Signed file links are served from the same origin.

## A sites domain (optional)

To publish websites with Sites, you also need a domain for them, with a wildcard DNS record pointing at your deployment. With Docker Compose it must not share a registrable domain with the app, so a site can never read the app's cookies. The Kubernetes manifests serve sites under the app's own domain instead and take the precautions described in [Sites security](nix://item/01a13137-b4fc-7c7f-a661-d6f8280f80ab).

## An identity provider

Nix does not store passwords. Sign-in goes through an OpenID Connect provider using the authorisation code flow with PKCE. Nix is developed and tested against Zitadel, and supports more than one issuer. The installer bundles Zitadel on both paths. If you run the Compose manifest by hand instead, you bring your own provider and need:

- an OIDC application (client ID) for Nix, with `https://<your-domain>` as its origin;
- the issuer URL;
- optionally, the provider's self-service account page, so people can change passwords, passkeys and second factors.

## Bundled services

Both deployment paths run these for you:

- PostgreSQL 16 with pgvector;
- RabbitMQ 4.1;
- Versity, an S3-compatible gateway for file storage.

You can point Nix at an external S3-compatible store or an external TLS RabbitMQ instead. See [Configuration](nix://item/01a130b0-14df-721e-b23c-3f24282e0eae).

## Keys you generate once

- **A P-256 signing key** for the short-lived access tokens Nix issues to browsers and `nixctl`.
- **A Web Push key pair** (VAPID) for push notifications. The notification worker will not start without it.

Keep both for the lifetime of the deployment. The installer generates them.

## Optional accounts

- **Google Cloud or Microsoft Entra** OAuth applications, for two-way calendar sync.
- **A ChatGPT account** for each person who wants to use the companion pet. Nobody needs one for anything else.

## Properties

- title: Requirements

