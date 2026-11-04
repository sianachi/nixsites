# Kubernetes

# Kubernetes

The manifests in `deploy/k8s/` run a complete Nix deployment on a Kubernetes cluster: the application, its database, object store, the Zitadel identity provider and the Sites services. They are rendered with `envsubst` and applied by `deploy/k8s/deploy.sh`. `deploy/install.sh --kubernetes` runs them for you on any cluster (see [Install in one line](nix://item/01a16030-a2fa-76fd-bef3-cb99a1a146d0)); what follows describes the manifests and their defaults, which are a k3s cluster behind Cloudflare.

The Kubernetes path is kept for an explicit switch. Every script in `deploy/k8s/` and `deploy/docker/build-and-push.sh` refuses to run unless you set:

```sh
export NIX_DEPLOY_TARGET=kubernetes
```

## What you need

- A cluster with an ingress controller and a StorageClass. By default the manifests expect k3s 1.32 or later with its bundled Traefik v3 (`INGRESS_CLASS=traefik`, the `ipAllowList` middleware and `local-path` storage); `deploy.sh` takes `INGRESS_CLASS`, `STORAGE_CLASS`, `STORAGE_CLASS_RETAIN`, `POD_CIDR`, `PUBLIC_ORIGIN`, `TLS_HOSTS` and `NIX_INGRESS_CLOUDFLARE_ONLY=false` for any other cluster, and the installer sets them from what it finds.
- With Traefik behind Cloudflare: Traefik's Service set to `externalTrafficPolicy: Local`, so it sees the real client address. On k3s, set this with a `HelmChartConfig` for `traefik` in `kube-system`. Without it, the Cloudflare-only allowlist answers `403` to everyone.
- With the k3s defaults: the `local-path` storage class, and a `local-path-retain` class for the volumes that must outlive their claims (the object store and backups). The repository does not define the second one; create it as a copy of `local-path` with `reclaimPolicy: Retain`.
- A domain and a certificate for it and `*.<domain>` in the `nix-tls` secret: a Cloudflare Origin CA certificate when proxied through Cloudflare, otherwise any pair, or cert-manager through the installer's `--cluster-issuer`.
- `kubectl`, `envsubst`, `openssl` and a checkout of the exact commit you will run.
- Images for that commit. CI publishes multi-architecture images for every commit on `main`, so you can point `REGISTRY` at them. `deploy/docker/build-and-push.sh` builds and pushes your own instead.

## Layout

| Manifest | What it creates |
| --- | --- |
| namespace.yaml | The nix namespace |
| postgres.yaml | PostgreSQL 16 with pgvector, as a StatefulSet with a 20 Gi volume |
| objectstore.yaml | The versitygw object store with a 20 Gi retained volume, and a policy that limits who may reach it |
| api.yaml | Core, one replica, with a small volume for its data-protection keys |
| collab.yaml | The collaboration service, one replica, replaced rather than rolled |
| worker.yaml | One combined worker running all five roles, and its egress policy |
| web.yaml | Caddy and the web app, configured from the nix-caddy ConfigMap built from deploy/k8s/Caddyfile |
| sites.yaml | The sites build worker and the sites serving process, each with an egress policy |
| zitadel.yaml | Zitadel, its database bootstrap job and its configuration |
| ingress.yaml | Three Ingresses (see below) |
| cloudflare-only.yaml | A Traefik middleware that admits only Cloudflare's published address ranges |
| job-seed.yaml | Creates the database roles and database; rerun it to rotate their passwords |
| job-storage-init.yaml | Creates both buckets, a read-only account for the sites server, and a read-only policy on the sites bucket |
| job-migrate.yaml | Core migrations and document migrations for the release tag |
| job-template-presets.yaml | Seeds the managed template presets |
| job-template-sync.yaml | Optionally installs the managed template library |
| backup.yaml | A nightly backup CronJob |

## Secrets

Run `deploy/k8s/create-secrets.sh` once per cluster before the first deploy. It generates strong random passwords and keys, derives the connection strings, and creates these Secrets in the `nix` namespace:

| Secret | Holds |
| --- | --- |
| nix-db | The PostgreSQL superuser, migrator, app and collaboration passwords |
| nix-connections | The derived connection strings for Core, the migrator, collaboration and document migrations |
| nix-internal | The internal service secret and the public forms signing key |
| nix-object-store | The storage endpoint, public origin, region, bucket and keys |
| nix-calendar | Google and Microsoft OAuth client IDs and secrets |
| nix-sites | The sites bucket and the sites server's read-only key |
| nix-sites-cloudflare | Optional Cloudflare settings for automatic site DNS records |
| nix-push-vapid | The Web Push key pair and contact |
| nix-tls | The origin certificate and key |
| nix-zitadel | Zitadel's master key, database password and first administrator |
| nix-auth | The P-256 key that signs Nix access tokens |

It refuses to run again once `nix-db` exists, so it can never silently rotate passwords the database does not know. To change one external service later, run it with one of `--object-store-only`, `--calendar-only`, `--sites-only`, `--sites-cloudflare-only`, `--push-only`, `--tls-only` or `--zitadel-only`. The sites server's key must be a different, read-only key; the script refuses to reuse the write key.

Values reach `kubectl` through your shell. Once the deployment is more than a first bring-up, consider sealed secrets or an external secrets operator.

## Deploying

```sh
export NIX_DEPLOY_TARGET=kubernetes
REGISTRY=ghcr.io/<owner>/nix TAG=<full-commit-sha> \
OIDC_CLIENT_ID=<client-id> DOMAIN=<your-domain> \
deploy/k8s/deploy.sh
```

`DOMAIN` is the app's address and also the sites domain: the app answers at `<your-domain>`, Zitadel at `auth.<your-domain>` and sites at `<slug>.<your-domain>`. `OIDC_ISSUER` defaults to `https://auth.<your-domain>`; set it only for an external provider.

The script applies a release in an order that stops a bad step before it reaches users:

1. checks that every required Secret and key exists;
2. removes retired workloads, keeping their volumes (including the retired RabbitMQ StatefulSet, Service, policy and Secret);
3. PostgreSQL;
4. the object store, then the storage job;
5. the seed job for database roles;
6. Zitadel's database job and Zitadel;
7. Core and document migrations;
8. template presets;
9. Caddy's configuration;
10. Core, collaboration, the worker, the web app and the Sites services, waiting for each rollout;
11. the Cloudflare-only middleware and the Ingresses;
12. the worker rollout, whose readiness depends on the public origin;
13. the backup CronJob;
14. the managed template library, if enabled.

### First install

A first install has nothing to sign in with yet, so it takes two passes:

1. Set `NIX_TEMPLATE_BOOT_ENABLED=false`. The managed template library needs a workspace, a Zitadel project and a service account key that do not exist yet; with this set, that step is skipped and everything else is applied.
2. Deploy once with a placeholder `OIDC_CLIENT_ID`. Zitadel starts with the first administrator from the `nix-zitadel` Secret, who must change their password at first sign-in. Self-registration is off.
3. Sign in to Zitadel at `https://auth.<your-domain>`, create the application for Nix, and deploy again with its real client ID.
4. When you want the managed templates, set `NIX_TEMPLATE_BOOT_ENABLED=true` with the `TEMPLATE_BOOT_WORKSPACE_ID`, `TEMPLATE_BOOT_OIDC_AUDIENCE`, `TEMPLATE_BOOT_PVC` and `TEMPLATE_BOOT_SERVICE_KEY_SECRET` it requires.

Other settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| NIX\_SITES\_REQUIRE\_OPERATOR\_APPROVAL | true | Holds each site's first publish until an operator approves it |
| SITES\_FOREIGN\_LABEL\_SUFFIX | \-home | A label suffix owned by another deployment sharing the sites domain; slugs ending in it are refused. Set it empty when nothing shares the domain |
| POD\_CIDR | 10.42.0.0/16 | The pod network, which Caddy trusts for the client address header. Confirm yours |

## Ingress

There are three Ingresses, all behind the Cloudflare-only middleware and all using the origin certificate:

1. **The app:** `<your-domain>` goes to Caddy in the web container, which does all the path routing; `auth.<your-domain>` goes to Zitadel.
2. **The sites wildcard:** `*.<your-domain>` goes to the sites server. It is a separate Ingress at the lowest router priority, so `auth` and the app always win.
3. **Custom site hostnames:** a rule with no host at the lowest priority catches any other name Cloudflare proxies to the origin and sends it to the sites server, which answers only for hostnames that have been verified.

The middleware admits only Cloudflare's published address ranges, so nobody can reach the origin directly and forge the client address header that Caddy trusts. Refresh `cloudflare-only.yaml` when Cloudflare changes its ranges. Cert-manager is not used.

## Network policies

| Policy | Rule |
| --- | --- |
| versitygw-ingress | Only Core, collaboration, the web app, the worker, both Sites services and the storage job may reach the object store |
| worker-egress | The worker may reach Core, collaboration, the object store, HTTPS and DNS |
| sites-worker-egress | The same set as the worker |
| sites-serve-egress | The sites server may reach only the object store, HTTPS and DNS |

## Fitting a small node

Requests are deliberately small and limits are capped:

| Workload | Memory request | Memory limit |
| --- | --- | --- |
| PostgreSQL | 384 Mi | 1 Gi |
| Object store | 64 Mi | 512 Mi |
| Core | 256 Mi | 512 Mi |
| Collaboration | 320 Mi | 768 Mi |
| Worker (all roles) | 160 Mi | 1 Gi |
| Web | 48 Mi | 256 Mi |
| Sites worker | 128 Mi | 768 Mi |
| Sites serve | 64 Mi | 256 Mi |
| Zitadel | 256 Mi | 768 Mi |

The combined worker exists to fit a single small node. Split it back into one Deployment per role when you have the memory. Zitadel's start-up probe allows several minutes on a slow node.

## Checking a deploy

```sh
DOMAIN=<your-domain> SITE_HOST=<slug>.<your-domain> deploy/k8s/verify.sh
```

`verify.sh` runs its checks in order, each failing in its own way: pods, Core's health and status, log scans, collaboration, the workers, the object store (an unsigned request must be refused), Zitadel's issuer, the sites server, the public app routes, that `/internal/authorize` answers `404` publicly, that a Content Security Policy is present, that the apex is not served by Sites and, with `SITE_HOST`, that a site answers with its own policy and sets no cookie.

It cannot check what needs a browser. Do these by hand: sign in end to end, edit the same note in two browsers, export a note as PDF and reload a deep link.

## Properties

- title: Kubernetes

