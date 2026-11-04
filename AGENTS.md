# Nix contributor routing

Read this file first. It is the short, always-applicable contract; before acting,
read every guide named by the path you will change. Guides are local standards
material and live in `docs/agent-guides/`.

## Always

- Product direction is in `README.md` and native reference notes; accepted architecture is in
  the ADR notes inside `docs/nix/nix-reference.nix`. Use `node --experimental-strip-types scripts/nix-docs.mts list`
  and `read <original-doc-path>` to discover/read them without running Nix. Original `.md`
  paths in source comments are catalog identifiers. Preserve each decision's recorded Status.
  Reconcile a task with the tree and recent commits. Observed shipped behaviour
  wins; stop and surface an architectural surprise that needs an ADR.
- Before editing, create an isolated worktree with
  `scripts/new-goal-worktree.sh <feature-slug> [base-ref]` when the current tree
  has unrelated changes or the task needs more than one commit. Make one focused
  task at a time; preserve unrelated changes in a shared tree.
- Do not assert unobserved results. Run the checks selected by
  `scripts/changed-path-checks.sh` and report anything that cannot run.
- Query or stress a running Nix instance through `nixctl` or MCP. If neither can
  express the need, close that tooling gap in the same session.
- Every user-facing change adds an entry under `## Unreleased` in `CHANGELOG.md`, in Added,
  Changed, Deprecated, Removed, Fixed or Security. Start an entry with `**Breaking:**` when an
  upgrade needs a step or a script using `/api/v1`, `nixctl` or MCP stops working, and say the
  step. Never set a version by hand: `scripts/release-version.sh` with no argument picks it from
  those sections. The definition is the Versioning section of `docs/release/release-process.md`.
- No emojis in code, comments, tests, docs, logs, UI copy, or commit messages.
- Do not commit local standards or Markdown unless the owner explicitly asks.
  Stage explicit paths only; never use `git add .`, `git add -A`, or `git commit -a`.

## Read by change area

| Change area | Required guide |
| --- | --- |
| `backend/**`, `Nix.slnx`, `Nix.Frontend/**` | `backend.md` |
| `apps/web/**`, `packages/**` | `frontend.md` |
| `backend/src/Nix.Workers/**`, `backend/src/Nix.Api/Workers/**`, `apps/companion/**`, `apps/node-host/**` | `workers.md` |
| `apps/sites/**` (sites build worker and serving process) | `workers.md` for job, lease and transfer rules, plus `frontend.md` for TypeScript conventions |
| Sites publishing: eligibility, manifests, hostnames, `packages/site-render` | `architecture-and-security.md` in addition to the area guide |
| Auth, RLS, permissions, migrations, `/internal`, tokens | `architecture-and-security.md` in addition to the area guide |
| CI, scripts, validation, commits, reviews | `workflow-and-validation.md` |
| `deploy/**`, `.github/workflows/ci-images.yml`, production releases | `workflow-and-validation.md` and the release runbook `deploy/README.md` |
| Unsure or cross-cutting work | `architecture-and-security.md` and `workflow-and-validation.md` |

## Fast validation selection

Run `./scripts/changed-path-checks.sh --working-tree` before validation, or pass
changed paths explicitly. It prints the smallest relevant local check set and
the cases that require broader proof. It does not replace CI or judgment.

## Core invariants

- There is one kind of item: body type never controls structure; views render
  children and canvas is a body kind.
- Core is the sole permission authority. Filter during queries, keep RLS context
  `SET LOCAL`, and never put roles or authorization decisions in browser tokens.
- Browser auth is Core's BFF flow. Files use capability URLs, never Core bytes.
- Durable data is authoritative; closure, snapshots, search, links and
  embeddings are rebuildable derived state. The implemented history-retention exception is
  documented by `node --experimental-strip-types scripts/nix-docs.mts read postgres-durability`: retained base and
  named-version Yjs checkpoints must survive when their covered updates have been pruned.
- OpenAPI is a contract seam: explicitly generated `backend/openapi/nix-api.json`
  and generated API-client code are never hand-edited.
- Production runs CI-published images from `ghcr.io/sianachi/nix`, tagged with the
  full commit SHA, on two paths: Docker Compose (`deploy/compose/release.sh`) and
  Kubernetes (`deploy/k8s/deploy.sh`). Build release images only through CI, or the
  fallback documented in `deploy/README.md`.
- Published sites are static builds. Core alone decides what a build contains, the
  build worker renders and uploads through capabilities Core signs, and anonymous
  readers reach only the serving process and object storage, never Core or Postgres.
- Site content is edited in Nix. `docs/site/` is a one-way snapshot refreshed with
  `scripts/export-site-content.sh`; edit the workspace, then re-export.

The previous complete policy is preserved as a native reference note. Read it with
`node --experimental-strip-types scripts/nix-docs.mts read docs/agent-guides/legacy-full-standards.md`. Prefer the
focused guides above; use that historical policy only to resolve a rule not yet routed.
The offline deployment and backup runbooks remain Markdown for recovery when Nix is down.
