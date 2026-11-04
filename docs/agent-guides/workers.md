# Go worker guide

Read for `apps/go-workers/` changes.

Keep `cmd/*/main.go` wiring-only. Workers use `internal/workerapi`, never database
credentials or backend implementation concepts. They transfer bytes only through
short-lived capability URLs, validate URL/origin/size/redirect policy, clean temp
files, and do not invent tenant context or permissions.

Use streaming with bounded archive/XML/JSON inputs. RabbitMQ delivers at-least-once job notifications; Core owns durable jobs, leases and the outbox.
Job handling is lease-based,
cancel-aware and idempotent: crashes must recover without duplicate durable
mutations. The current Go roles are import, export, plugin-events and calendar (notify moved into Core, `backend/src/Nix.Workers`);
the speech and OpenSearch index roles are retired. Derived search and link state
remain rebuildable. `/healthz` is liveness; `/readyz` proves each role's dependencies.

Run `gofmt`, `go vet ./...`, `go test ./...`, `go test -race ./...`, and build the
unified executable for worker changes.
