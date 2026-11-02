# Rate limits

The limits below are the defaults compiled into Core. A deployment can move the configured ones with the keys in the table. They are bounds a person does not meet and a runaway client does. They are not a published quota plan, and they are not a billable tier.

Each window is one minute, kept in the API process that handled the request. A deployment with more than one API replica allows the limit once on each replica. The partition is the client address, because the limiter runs before the request is authenticated. The address is the caller's when the proxy hop is trusted; otherwise every caller shares the proxy's address.

A refusal is HTTP 429 with `Content-Type: application/problem+json`, code `request.rate_limited`, and a `Retry-After` header of whole seconds (at least 1).

| Limit | Default | Partition |
| --- | --- | --- |
| Writes (`Nix:RateLimits:WritesPerMinute`, default 120) | 120 per minute | client address |
| Token exchanges (`Nix:RateLimits:TokenExchangesPerMinute`, default 30) | 30 per minute | client address |
| Public form submissions (`Nix:RateLimits:PublicFormSubmissionsPerMinute`, default 20) | 20 per minute | client address and form link |
| Lock password attempts (`Nix:RateLimits:LockPasswordAttemptsPerMinute`, default 20) | 20 per minute | client address |
| Mention suggestions (`Nix:RateLimits:SuggestionsPerMinute`, default 60) | 60 per minute | client address |
| Workspace queries (`Nix:RateLimits:QueriesPerMinute`, default 120) | 120 per minute | client address |

Writes cover mutating `/api/v1` routes. Suggestions and queries are separate so a dashboard or a typing lookup does not spend the write window.

**Failed authentication.** 10 failed attempts from one address, then that address is refused for the rest of a window of 5 minutes (`Nix:RateLimits:FailedAuthenticationLimit` and `Nix:RateLimits:FailedAuthenticationWindowSeconds`). The exchange counts a bad token here, and so does a bad bearer token on `/api/v1`. This window is also in memory, per process.

**Browser sign-in.** Starting (`/auth/login`) and completing (`/auth/callback`) a sign-in share 30 per minute per address, fixed in the server.

**CLI browser login.** Starting a login is 6 per minute per address. Polling a login is 120 per minute per address. Those two numbers are fixed in the server, not read from `Nix:RateLimits`.

There is no `Retry-After` on a success, and no documented burst budget beyond the fixed window (`QueueLimit` is 0, so an over-limit call is refused immediately).

## Properties

- title: Rate limits
