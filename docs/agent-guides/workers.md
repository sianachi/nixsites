# Go worker guide

Read for `apps/go-workers/` changes.

Keep `cmd/*/main.go` wiring-only. Workers use `internal/workerapi`, never database
credentials or backend implementation concepts. They transfer bytes only through
short-lived capability URLs, validate URL/origin/size/redirect policy, clean temp
files, and do not invent tenant context or permissions.

Use streaming with bounded archive/XML/JSON inputs. Core owns durable jobs and leases; its hosts lease `worker_job` rows directly.
Job handling is lease-based,
cancel-aware and idempotent: crashes must recover without duplicate durable
mutations. No job role is left in Go: notify, calendar, export and the import family moved into Core (`backend/src/Nix.Workers`) and plugins were removed; the binary hosts the pet companion only;
the speech and OpenSearch index roles are retired. Derived search and link state
remain rebuildable. `/healthz` is liveness; `/readyz` proves each role's dependencies.

Run `gofmt`, `go vet ./...`, `go test ./...`, `go test -race ./...`, and build the
unified executable for worker changes.
