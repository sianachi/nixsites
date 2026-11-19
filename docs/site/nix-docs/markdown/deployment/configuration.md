# Configuration

With Docker Compose, all production settings live in one private environment file, based on `deploy/compose.prod.env.example`. Keep it outside the repository checkout with mode `0600`, and preserve its passwords, keys and identity settings across upgrades. Changing a key later can invalidate stored state.

## Images

| Variable | Purpose |
| --- | --- |
| NIX\_IMAGE\_REGISTRY | Optional. Defaults to ghcr.io/sianachi/nix. Set localhost/nix only for images built on the host |
| NIX\_IMAGE\_TAG | The full commit SHA of the release for the API, migrator, Node (collaboration, companion and sites worker), sites and release-tools images |
| NIX\_WEB\_IMAGE\_TAG | The full commit SHA for the web image |

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

## Object storage

| Variable | Purpose |
| --- | --- |
| NIX\_OBJECT\_STORE\_ENDPOINT | The S3 endpoint Core and the workers use |
| NIX\_OBJECT\_STORE\_PUBLIC\_ORIGIN | The origin browsers use for signed links |
| NIX\_OBJECT\_STORE\_REGION | Defaults to us-east-1 |
| NIX\_OBJECT\_STORE\_BUCKET | The bucket name |
| NIX\_OBJECT\_STORE\_ACCESS\_KEY, NIX\_OBJECT\_STORE\_SECRET\_KEY | Storage credentials |

With the bundled store, set both the endpoint and the public origin to `https://<your-domain>`; the web container routes the bucket path to the store. The bucket name becomes a path on your domain, so it must not match one of the app's own pages.

## Sign-in

Pick one mode per install. There is no account linking between them.

| Variable | Purpose |
| --- | --- |
| NIX\_PUBLIC\_ORIGIN | https://\<your-domain> |
| NIX\_AUTH\_MODE | local: Core signs people in itself, with passwords, passkeys and authenticator codes. oidc: an outside identity provider. Unset means oidc when NIX\_OIDC\_ISSUER is set and local otherwise |
| NIX\_AUTH\_SETUP\_CODE | Local mode. The code the first-run page at /setup asks for. The person who uses it becomes the administrator. Generate one yourself, for example openssl rand -hex 16 |
| NIX\_AUTH\_PASSKEY\_RP\_ID | Local mode. The hostname passkeys are bound to. Defaults to the public origin's host. Set it only when migrating passkeys created for another hostname, and serve /.well-known/webauthn on that host |
| NIX\_OIDC\_ISSUER | Your identity provider's issuer URL. Empty in local mode |
| NIX\_OIDC\_CLIENT\_ID | The OIDC client ID for Nix. Empty in local mode |
| NIX\_OIDC\_ACCOUNT\_URL | Optional. The provider's self-service account page. Defaults to the issuer's /ui/console/users/me?id=security page |
| NIX\_COLLAB\_OIDC\_ISSUERS | Which token issuers the collaboration service trusts. In local mode set it to \<NIX\_CORE\_TOKEN\_ISSUER>\\|http://nix-api:8080/public/v1/auth/jwks |
| NIX\_COLLAB\_OIDC\_AUDIENCE | In local mode set it to the value of NIX\_CORE\_TOKEN\_AUDIENCE |
| NIX\_BOOTSTRAP\_IDENTITY | Read by deploy/compose/deploy.sh, not the file. true creates the first tenant and identity provider for a fresh install that uses an outside provider. Needs NIX\_BOOTSTRAP\_TENANT\_NAME and NIX\_BOOTSTRAP\_OIDC\_PROJECT\_ID; NIX\_BOOTSTRAP\_TENANT\_ID is optional. Local mode never needs it |

Compose refuses to start with `NIX_OIDC_ISSUER` or `NIX_OIDC_CLIENT_ID` unset, so a local-mode install sets both to empty values. An install in local mode refuses tokens from an outside identity provider.

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

## Remote MCP

Optional. Add `mcp` to `COMPOSE_PROFILES` to run the MCP service. The one-line installer always runs it.

| Variable | Purpose |
| --- | --- |
| NIX\_MCP\_UPSTREAM | Where the web container proxies /mcp, for example nix-mcp:8500. Unset, the route fails closed |
| NIX\_MCP\_PUBLIC\_URL | The public address, https://\<your-domain>/mcp. Core shows it in Settings, and hosted clients such as Claude and ChatGPT sign in through Core's OAuth routes. Those routes answer 404 unless this and NIX\_PUBLIC\_ORIGIN are both set |

## Public links

| Variable | Purpose |
| --- | --- |
| NIX\_PUBLIC\_LINKS\_ENABLED | Set to true to let people share notes and files by public link. Defaults to false. Links are signed with NIX\_PUBLIC\_FORMS\_SIGNING\_KEY |

## Companion

| Variable | Purpose |
| --- | --- |
| NIX\_PETS\_SERVER\_TOOLS | Core's switch for server-side companion tools: off, reads or all. Defaults to off. It is the kill switch: turn the companion's switch on first, then this one |
| NIX\_COMPANION\_SERVER\_TOOLS | The companion runtime's matching switch, off, reads or all. Defaults to off |
| NIX\_PET\_RUNS\_ENABLED | Set to true for companion jobs in one pilot workspace. Defaults to false |
| NIX\_PET\_RUNS\_PILOT\_WORKSPACE | The workspace ID jobs are limited to |
| NIX\_PET\_BROWSER\_URL, NIX\_PET\_BROWSER\_INTERNAL\_SECRET | The optional browser worker (the pet-browser profile) and the random secret shared by it and Core |
| NIX\_PET\_GOOGLE\_, NIX\_PET\_MICROSOFT\_, NIX\_PET\_SLACK\_, NIX\_PET\_GITHUB\_, NIX\_PET\_LINEAR\_\* | CLIENT\_ID and CLIENT\_SECRET for each connection a companion can use. Register /auth/pet-connections/callback on the public origin. NIX\_PET\_MICROSOFT\_TENANT defaults to organizations |

## Tunnel

| Variable | Purpose |
| --- | --- |
| CLOUDFLARE\_TUNNEL\_TOKEN | The token for the optional tunnel connector. Set a placeholder if you use your own reverse proxy |

## Sites

Optional. Leave these unset and nothing about Sites runs.

| Variable | Purpose |
| --- | --- |
| COMPOSE\_PROFILES | Include sites to start the sites serving process. Separate several profiles with commas |
| NIX\_SITES\_ENABLED | Set to true to turn Sites on in Core. Defaults to false |
| NIX\_SITES\_DOMAIN | The domain sites are served under, as \<slug>.\<sites-domain>. It must not share a registrable domain with NIX\_PUBLIC\_ORIGIN |
| NIX\_SITES\_BUCKET | The bucket built sites are written to. Defaults to nix-sites |
| NIX\_SITES\_READ\_ACCESS\_KEY, NIX\_SITES\_READ\_SECRET\_KEY | The serving process's storage credential. Use a key that can only read the sites bucket where your store supports it |
| NIX\_SITES\_DEFAULT\_LABEL\_SUFFIX | Optional. A label suffix for this instance's default hostnames, as \<slug>\<suffix>.\<sites-domain>, when another deployment shares the sites domain |
| NIX\_SITES\_CLOUDFLARE\_API\_TOKEN | Optional. Lets Nix create DNS records and tunnel routes for site hostnames. Needs Zone:Read, DNS:Edit and Cloudflare Tunnel:Edit |
| NIX\_SITES\_CLOUDFLARE\_ACCOUNT\_ID, NIX\_SITES\_CLOUDFLARE\_TUNNEL\_ID | The account and tunnel those routes are added to |
| NIX\_SITES\_CLOUDFLARE\_TUNNEL\_SERVICE | Optional. The service the tunnel routes site hostnames to. Defaults to http://nix-sites-serve:8400 |
| NIX\_SITES\_CLOUDFLARE\_DEFAULT\_HOSTNAME\_ZONE\_ID | The zone for this instance's default hostnames when a label suffix is set. Never used for custom hostnames |

## Release host

`deploy/compose/release.sh` reads non-secret host settings from a `release.conf` file, found at `NIX_RELEASE_CONF`. Start from `deploy/compose/release.conf.example`. It holds `NIX_DEPLOY_ENV` (the absolute path to your environment file), `NIXCTL_PROFILE` and `NIX_SMOKE_WORKSPACE` for the smoke test, `NIX_BACKUP_ROOT`, `NIX_OFFSITE_REQUIRED`, `NIX_RELEASE_LEDGER`, `NIX_RELEASE_LOCK` and `NIX_IMAGE_REGISTRY`. Never put a password, token or key in it.

## Kubernetes

The Kubernetes manifests read the same settings from Secrets and ConfigMaps instead of an environment file. `deploy/k8s/create-secrets.sh` creates the Secrets and lists them as it goes; see [Kubernetes](nix://item/01a13137-c1a1-7f79-bfe5-4e7cad094458). The settings passed to `deploy/k8s/deploy.sh` are:

| Variable | Purpose |
| --- | --- |
| NIX\_DEPLOY\_TARGET | Must be kubernetes, or the script refuses to run |
| REGISTRY, TAG | Where the images are and the full commit SHA to run |
| DOMAIN | The app's domain, also used for sites |
| NIX\_AUTH\_MODE | local or oidc. Defaults to local for an empty namespace; set it explicitly on an existing install |
| OIDC\_ISSUER, OIDC\_CLIENT\_ID | Both required when NIX\_AUTH\_MODE=oidc. Nothing deploys the provider |
| NIX\_AUTH\_PASSKEY\_RP\_ID | Optional. The hostname migrated passkeys were registered for. Defaults to auth.\<DOMAIN> during a Zitadel import |
| NIX\_IMPORT\_ZITADEL | dry-run or run, to move an old bundled Zitadel install onto local sign-in. See Upgrades |
| NIX\_TEMPLATE\_BOOT\_ENABLED | false on a first install; true requires the TEMPLATE\_BOOT\_\* settings |
| NIX\_MCP\_ENABLED | Defaults to true. false removes remote MCP |
| NIX\_PUBLIC\_LINKS\_ENABLED | Defaults to false |
| NIX\_SITES\_REQUIRE\_OPERATOR\_APPROVAL | Defaults to true |
| SITES\_FOREIGN\_LABEL\_SUFFIX | Defaults to -home; set it empty when no other deployment shares the domain |
| NIX\_BACKUP\_OFFSITE | Defaults to false. true fails the nightly backup when the off-node secret is missing |
| POD\_CIDR | Defaults to 10.42.0.0/16 |
| INGRESS\_CLASS, STORAGE\_CLASS, STORAGE\_CLASS\_RETAIN, TLS\_HOSTS, NIX\_INGRESS\_CLOUDFLARE\_ONLY | For clusters other than the k3s and Cloudflare defaults |

The inputs to `create-secrets.sh` include `DOMAIN`, the `NIX_OBJECT_STORE_*` and `NIX_CALENDAR_*` values, `NIX_SITES_BUCKET` and `NIX_SITES_READ_*`, the optional `NIX_SITES_CLOUDFLARE_*` values, `NIX_PUSH_VAPID_*`, `NIX_ORIGIN_TLS_CERT_FILE`, `NIX_ORIGIN_TLS_KEY_FILE` and the optional `NIX_AUTH_SETUP_CODE`. `--backup-offsite-only` reads `RESTIC_REPOSITORY`, `RESTIC_PASSWORD`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. Passwords for the database, internal secret and signing keys are generated.

## Properties

- title: Configuration

