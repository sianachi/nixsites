# Development commands


Run frontend commands from the repository root; run backend commands from
the repository root too, since `Nix.slnx` lives there.

**Frontend**

```
pnpm lint          # ESLint + Prettier check
pnpm typecheck
pnpm test
pnpm build
```

One package: `pnpm --filter @nix/web test` (also `@nix/ui`, `@nix/api-client`,
`@nix/design-tokens`, `@nix/editor-schema`, `@nix/collab`).

One file: `pnpm --filter @nix/web exec vitest run src/path/foo.test.ts`
(add `-t "behavior sentence"` to narrow further).

Dev server: `pnpm --filter @nix/web dev` (5173; proxies the API on 5014 and
collab on 8100).

Storybook: `pnpm --filter @nix/ui storybook` (6006);
`pnpm --filter @nix/ui test-storybook` runs the axe pass.

**Backend**

```
dotnet format Nix.slnx --verify-no-changes
dotnet build Nix.slnx --configuration Release
dotnet test --project backend/tests/Nix.Tests/Nix.Tests.csproj              # unit, no Docker
dotnet test --project backend/tests/Nix.Integration.Tests/Nix.Integration.Tests.csproj  # needs Docker
```

For an API contract change, regenerate OpenAPI explicitly, then regenerate the
typed client and the public API reference:

```
dotnet build backend/src/Nix.Api/Nix.Api.csproj -p:NixGenerateOpenApiContract=true
pnpm --filter @nix/api-client generate
node scripts/generate-api-docs.mjs
```

Migrations: `dotnet run --project backend/src/Nix.Migrator` with
`NIX_MIGRATOR_CONNECTION_STRING` set.

**Go workers** (from `apps/go-workers`)

```sh
go vet ./...
go test ./...
go test -race ./...
go build ./cmd/nix-worker
```

**Validation selection**

Run `./scripts/changed-path-checks.sh --working-tree` first, or pass explicit changed paths.
Follow its selected checks and [the validation guide](agent-guides/workflow-and-validation.md).
Frontend guards include raw design values, layering, text primitives and spacing roles; each
fixture self-test runs before its guard. Broad root commands above are useful for cross-cutting work.
Query or stress a live Nix instance through `nixctl` or its MCP server.

