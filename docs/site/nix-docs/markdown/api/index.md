# Nix API

The HTTP API is a way to use Nix, alongside the web app, `nixctl`, and the MCP server. All four go through the same permission checks. A token can do only what the person who minted it can do, and only inside the scopes on that token.

## What you can build

Programs that read and change a workspace the way the app does:

- list workspaces, walk the item tree, and create, rename, move, trash, restore, and purge items;
- set properties, so tasks, habits, and other structured fields are ordinary items with fields;
- run the same queries the views run;
- read a calendar window, and manage calendar sync where the token's scope allows it;
- record habit check-ins, and read or write finance records on a finance root;
- search, export, import, and publish a site when the token holds admin.

A note, canvas, or spreadsheet body is not part of these calls. The collaboration service holds the body. `nixctl note read` and `nixctl note write` speak that protocol. There is no REST route that replaces a note body yet. Creating an item and renaming it are REST calls; filling in the note comes later, on that other path.

Guides for the resources are in [Notes, tasks, and the rest](resources.md). Identifiers are in [Workspaces, containers, and cards](identifiers.md).

## Keys and authentication

Create a personal access token in the web app under **Settings > Access tokens**. The secret is shown once. It starts with `nixpat_` and is 62 characters. You choose one or more of `read`, `write`, and `admin`, and an expiry from 1 to 365 days. A token cannot mint another token.

Exchange it for a short-lived bearer JWT:

```sh
curl -sS "$BASE/public/v1/auth/token" \
  -A 'nix-api-example/1.0' \
  -H 'Content-Type: application/json' \
  -d "{\"token\":\"$NIX_TOKEN\"}"
```

The JSON body field is `token`. The response fields are `accessToken`, `tokenType` (`Bearer`), and `expiresInSeconds`. Send the JWT on later calls:

```sh
Authorization: Bearer <accessToken>
```

Every client sets its own `User-Agent`. The hosted service sits behind an edge that blocks the default Python and urllib user agents. The API process does not read `User-Agent`; the edge does. The examples use `nix-api-example/1.0`.

Details, including Python and TypeScript, are in [Authentication](authentication.md).

## One request

Set `BASE` to the origin you are calling, and `NIX_TOKEN` to the personal access token.

| Where you run Nix | `BASE` |
| --- | --- |
| Hosted | `https://nixsites.com` |
| A server you installed | the public origin, such as `https://nix.example.org` or `http://nix.localhost` |
| Local development, Core directly | `http://localhost:5014` |

The web app on port 5173 proxies `/api` and does not proxy `/public/v1/auth/token`. Exchange against Core's origin, which is port 5014 in the default local setup. A deployed origin forwards both `/api/*` and `POST /public/v1/auth/token`.

```sh
BASE=https://nixsites.com
curl -sS "$BASE/public/v1/auth/token" \
  -A 'nix-api-example/1.0' \
  -H 'Content-Type: application/json' \
  -d "{\"token\":\"$NIX_TOKEN\"}"
```

Take `accessToken` from that JSON and list workspaces:

```sh
curl -sS "$BASE/api/v1/workspaces" \
  -A 'nix-api-example/1.0' \
  -H "Authorization: Bearer $NIX_ACCESS_TOKEN"
```

Python and TypeScript for the same two calls are in [Authentication](authentication.md). Lists use [pagination](pagination.md). Failures use [problem details](errors.md).

## Rate limits

Limits are per API process and, unless a row says otherwise, per client address. More than one API replica allows each limit once per replica. A refusal is HTTP 429, code `request.rate_limited`, with `Retry-After` in whole seconds. The configured defaults are:

- Writes (`Nix:RateLimits:WritesPerMinute`, default 120) per minute, per client address.
- Token exchanges (`Nix:RateLimits:TokenExchangesPerMinute`, default 30) per minute, per client address.
- Public form submissions (`Nix:RateLimits:PublicFormSubmissionsPerMinute`, default 20) per minute, per client address and form link.
- Lock passwords (`Nix:RateLimits:LockPasswordAttemptsPerMinute`, default 20) per minute, per client address.
- Mention suggestions (`Nix:RateLimits:SuggestionsPerMinute`, default 60) per minute, per client address.
- Queries (`Nix:RateLimits:QueriesPerMinute`, default 120) per minute, per client address.

Failed authentication is a separate window: 10 failed attempts, then a refusal for the rest of 5 minutes. CLI browser-login start is 6 per minute. The table and the configuration keys are repeated in [Rate limits](rate-limits.md).

## Pricing

> **Placeholder for the owner.** The repository does not name a price for API use. A self-hosted Nix has no charge from this project for calling the API. What the hosted service at `https://nixsites.com` charges, if it charges, is not decided in the product. Replace this section with that price before treating the API as a paid offer.

## Stability

Public routes are under `/api/v1`, plus `POST /public/v1/auth/token`, `GET /public/v1/auth/jwks`, public forms, and the unversioned liveness probe `GET /healthz`. The OpenAPI document's `info.version` is `1.0.0` because that is the generator's default. It is not a compatibility promise. What the code treats as contract, and what it does not promise, is in [Versioning](versioning.md).

## Full reference

The operation list is generated from `backend/openapi/nix-api.json`. Each operation has the server's summary, what it can change, what it cannot change, and the token scope.

- [API reference](reference.md) (the same text is at [generated/reference.md](../../generated/reference.md))
- [Browsable reference](../../generated/reference.html)
- [OpenAPI document](../../generated/nix-api.json) (the contract of record is [backend/openapi/nix-api.json](../../../../../backend/openapi/nix-api.json))
- [Error codes](error-codes.md)

## Properties

- title: API
