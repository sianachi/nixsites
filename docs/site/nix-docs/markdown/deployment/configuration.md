# Configuration

With Docker Compose, all production settings live in one private environment file, based on `deploy/compose.prod.env.example`. Keep it outside the repository checkout with mode `0600`, and preserve its passwords, keys and identity settings across upgrades. Changing a key later can invalidate stored state.

## Images

| Variable | Purpose |
| --- | --- |
| NIX\_IMAGE\_REGISTRY | Optional. Defaults to ghcr.io/sianachi/nix. Set localhost/nix only for images built on the host |
| NIX\_IMAGE\_TAG | The full commit SHA of the release for the API, migrator, collaboration and worker images |
| NIX\_WEB\_IMAGE\_TAG | The full commit SHA for the web image |
| NIX\_WORKER\_IMAGE\_TAG | Optional. A different worker image, for a worker-only fix |

The release script exports the tags in the shell, which takes precedence over the file, so you do not edit the file per release.

## Database

| Variable | Purpose |
| --- | --- |
| NIX\_PG\_SUPERUSER\_PASSWORD | The PostgreSQL superuser password |
| NIX\_PG\_MIGRATOR\_PASSWORD | The nix\_migrator password |
| NIX\_MIGRATOR\_CONNECTION\_STRING | Core migrations, as nix\_migrator |
| NIX\_CORE\_DATABASE\_URL | Core at runtime, as nix\_app |
| NIX\_COLLAB\_DATABASE\_URL | Collaboration at runtime, as nix\_collab |
| NIX\_COLLAB\_MIGRATOR\_CONNECTION\_STRING | Document migrations, as nix\_migrator. Used only by the one-shot job |

```text
NIX_CORE_DATABASE_URL=Host=postgres;Port=5432;Database=nix;Username=nix_app;Password=<app-password>
NIX_COLLAB_DATABASE_URL=postgresql://nix_collab:<collab-password>@postgres:5432/nix
```

## Internal secrets

| Variable | Purpose |
| --- | --- |
| NIX\_INTERNAL\_SECRET | Authenticates internal calls between services |
| NIX\_PUBLIC\_FORMS\_SIGNING\_KEY | Signs interactive form links |

Generate each with a strong random value, for example `openssl rand -base64 48`.

## RabbitMQ

Each component has its own broker credential. Use URL-safe values, because Compose builds connection URLs from them.

`NIX_RABBITMQ_API_PASSWORD`, `NIX_RABBITMQ_IMPORT_PASSWORD`, `NIX_RABBITMQ_EXPORT_PASSWORD`, `NIX_RABBITMQ_PLUGIN_PASSWORD`, `NIX_RABBITMQ_CALENDAR_PASSWORD`, `NIX_RABBITMQ_NOTIFY_PASSWORD`, and `NIX_RABBITMQ_SITES_PASSWORD` when Sites is enabled

To use an external TLS broker instead of the bundled one, set a full `amqps://` URL for every role: `NIX_RABBITMQ_API_URL`, `NIX_RABBITMQ_IMPORT_URL`, `NIX_RABBITMQ_EXPORT_URL`, `NIX_RABBITMQ_PLUGIN_URL`, `NIX_RABBITMQ_CALENDAR_URL` and `NIX_RABBITMQ_NOTIFY_URL`.

## Object storage

| Variable | Purpose |
| --- | --- |
| NIX\_OBJECT\_STORE\_ENDPOINT | The S3 endpoint Core and the workers use |
| NIX\_OBJECT\_STORE\_PUBLIC\_ORIGIN | The origin browsers use for signed links |
| NIX\_OBJECT\_STORE\_REGION | Defaults to us-east-1 |
| NIX\_OBJECT\_STORE\_BUCKET | The bucket name |
| NIX\_OBJECT\_STORE\_ACCESS\_KEY, NIX\_OBJECT\_STORE\_SECRET\_KEY | Storage credentials |

With the bundled store, set both the endpoint and the public origin to `https://<your-domain>`; the web container routes the bucket path to the store. The bucket must not be called `w`, `workspaces` or `launch`, because the installed app treats those paths as its own pages.

## Sign-in

| Variable | Purpose |
| --- | --- |
| NIX\_PUBLIC\_ORIGIN | https://\<your-domain> |
| NIX\_OIDC\_ISSUER | Your identity provider's issuer URL |
| NIX\_OIDC\_CLIENT\_ID | The OIDC client ID for Nix |
| NIX\_OIDC\_ACCOUNT\_URL | Optional. The provider's self-service account page. Defaults to the Zitadel console |

## Access tokens

Nix issues its own short-lived access tokens to browsers, `nixctl` and personal access tokens.

| Variable | Purpose |
| --- | --- |
| NIX\_CORE\_TOKEN\_ISSUER | Usually https://\<your-domain> |
| NIX\_CORE\_TOKEN\_AUDIENCE | Usually nix |
| NIX\_CORE\_TOKEN\_KEY\_ID | A name for the signing key, such as nix-core-2026-10 |
| NIX\_CORE\_TOKEN\_SIGNING\_KEY\_FILE | Absolute path to the P-256 private key |

```sh
openssl ecparam -name prime256v1 -genkey -noout -out core-access-token.pem
```

Generate the key once and keep it.

## Push notifications

| Variable | Purpose |
| --- | --- |
| NIX\_PUSH\_VAPID\_PRIVATE\_KEY | The VAPID private key: 32 raw bytes, base64url, no padding |
| NIX\_PUSH\_VAPID\_PUBLIC\_KEY | The matching public key: an uncompressed P-256 point, base64url |
| NIX\_PUSH\_VAPID\_SUBJECT | A mailto: or https: contact for push services |

Generate one key pair for the lifetime of the deployment. Changing it means every device has to subscribe again.

## Calendar sync

Optional. A provider without a client ID and secret is shown as unavailable.

| Variable | Purpose |
| --- | --- |
| NIX\_CALENDAR\_GOOGLE\_CLIENT\_ID, NIX\_CALENDAR\_GOOGLE\_CLIENT\_SECRET | Google OAuth application |
| NIX\_CALENDAR\_MICROSOFT\_CLIENT\_ID, NIX\_CALENDAR\_MICROSOFT\_CLIENT\_SECRET | Microsoft OAuth application |
| NIX\_CALENDAR\_MICROSOFT\_TENANT | Defaults to common |

Register these redirect URIs with the provider:

```text
https://<your-domain>/auth/calendar/callback/google
https://<your-domain>/auth/calendar/callback/microsoft
```

Core keeps calendar refresh tokens encrypted with its data-protection keys, which live in the `nix-api-data-protection` volume. Back that volume up separately from the database. If it is lost, every calendar connection has to be made again.

## Tunnel

| Variable | Purpose |
| --- | --- |
| CLOUDFLARE\_TUNNEL\_TOKEN | The token for the optional tunnel connector. Set a placeholder if you use your own reverse proxy |

## Sites

Optional. Leave these unset and nothing about Sites runs.

| Variable | Purpose |
| --- | --- |
| COMPOSE\_PROFILES | Set to sites to start the two Sites services |
| NIX\_SITES\_DOMAIN | The domain sites are served under, as \<slug>.\<sites-domain>. It must not share a registrable domain with NIX\_PUBLIC\_ORIGIN |
| NIX\_SITES\_BUCKET | The bucket built sites are written to. Defaults to nix-sites |
| NIX\_RABBITMQ\_SITES\_PASSWORD | The sites worker's own broker password |
| NIX\_SITES\_READ\_ACCESS\_KEY, NIX\_SITES\_READ\_SECRET\_KEY | The serving process's storage credential. Use a key that can only read the sites bucket where your store supports it |
| NIX\_SITES\_DEFAULT\_LABEL\_SUFFIX | Optional. A label suffix for this instance's default hostnames, as \<slug>\<suffix>.\<sites-domain>, when another deployment shares the sites domain |
| NIX\_SITES\_CLOUDFLARE\_API\_TOKEN | Optional. Lets Nix create DNS records and tunnel routes for site hostnames. Needs Zone:Read, DNS:Edit and Cloudflare Tunnel:Edit |
| NIX\_SITES\_CLOUDFLARE\_ACCOUNT\_ID, NIX\_SITES\_CLOUDFLARE\_TUNNEL\_ID | The account and tunnel those routes are added to |
| NIX\_SITES\_CLOUDFLARE\_DEFAULT\_HOSTNAME\_ZONE\_ID | The zone for this instance's default hostnames when a label suffix is set. Never used for custom hostnames |

## Kubernetes

The Kubernetes manifests read the same settings from Secrets and ConfigMaps instead of an environment file. `deploy/k8s/create-secrets.sh` creates the Secrets and lists them as it goes; see [Kubernetes](nix://item/01a13137-c1a1-7f79-bfe5-4e7cad094458). The settings passed to `deploy/k8s/deploy.sh` are:

| Variable | Purpose |
| --- | --- |
| NIX\_DEPLOY\_TARGET | Must be kubernetes, or the script refuses to run |
| REGISTRY, TAG | Where the images are and the full commit SHA to run |
| DOMAIN | The app's domain, also used for auth. and for sites |
| OIDC\_CLIENT\_ID | The Nix application's client ID at the identity provider |
| OIDC\_ISSUER | Optional. Defaults to https://auth.\<DOMAIN> |
| NIX\_TEMPLATE\_BOOT\_ENABLED | false on a first install; true requires the TEMPLATE\_BOOT\_\* settings |
| NIX\_SITES\_REQUIRE\_OPERATOR\_APPROVAL | Defaults to true |
| SITES\_FOREIGN\_LABEL\_SUFFIX | Defaults to -home; set it empty when no other deployment shares the domain |
| POD\_CIDR | Defaults to 10.42.0.0/16 |

The inputs to `create-secrets.sh` include `DOMAIN`, the `NIX_OBJECT_STORE_*` and `NIX_CALENDAR_*` values, `NIX_SITES_BUCKET` and `NIX_SITES_READ_*`, the optional `NIX_SITES_CLOUDFLARE_*` values, `NIX_PUSH_VAPID_*`, `NIX_ORIGIN_TLS_CERT_FILE`, `NIX_ORIGIN_TLS_KEY_FILE`, and `NIX_ZITADEL_ADMIN_USERNAME` and `NIX_ZITADEL_ADMIN_PASSWORD`. Passwords for the database, broker, internal secret and signing keys are generated.

## Properties

- title: Configuration

