# Workers guide

Read for `backend/src/Nix.Workers/`, `backend/src/Nix.Api/Workers/`, `apps/companion/`,
`apps/node-host/` and `apps/sites/` worker changes. ADR-0067 records the topology.

Background jobs run inside Core. `Nix.Workers` holds the job logic (notify, calendar, export,
the import family, file publication, object cleanup); the hosts in `Nix.Api/Workers` lease
`worker_job` rows directly and take hints from in-memory signals. There is no broker and no
separate worker binary.

`apps/node-host` runs collaboration, the pet companion (`apps/companion`) and the sites worker in
one process (`NIX_NODE_ROLES`, default `collab,companion,sites-worker`); each role keeps its own
port (8100, 8302, 8301) and environment. Compose and Kubernetes run it as `nix-node` from the
`collab` image. The sites worker polls Core for site jobs. The companion calls Core over the
internal API and holds no database or storage credential.

Workers transfer bytes only through short-lived capability URLs, validate URL, origin, size and
redirect policy, clean temp files, and do not invent tenant context or permissions. Use
streaming with bounded archive, XML and JSON inputs. Job handling is lease-based, cancel-aware
and idempotent: a crash must not duplicate durable mutations. Derived search and link state
remain rebuildable. `/healthz` is liveness; `/readyz` proves each role's dependencies.

Check changes with `./scripts/changed-path-checks.sh`; backend worker changes run the
`Nix.Tests` suite, Node roles run their package tests.
