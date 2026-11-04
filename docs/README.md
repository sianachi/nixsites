# Nix documentation

Detailed documentation is native Nix content. Import the archives into a workspace to read and edit
notes, follow internal links and view their Mermaid architecture diagrams.

- [Architecture handbook](nix/nix-architecture.nix): 38 service, workflow and operational pages,
  including every declared production Compose service and all five Go roles. Browse All guides, the Service
  catalog, By area, Workflows and Operations.
- [Repository reference](nix/nix-reference.nix): 59 original documents as readable native notes with
  exact original-source child notes. Browse by category, decisions and their recorded status, plans,
  and runbooks. Each record has an Original source view. ADR status and historical dates remain unchanged.
- [Catalog and verification](nix/catalog.json): IDs, hashes, retained-file reasons and import/export proof.

The current architecture is inspected against `main` at `e037eb02` on 9 October 2026. The reference
archive preserves the earlier snapshot and original ADR statuses. Speech, OpenSearch indexing and
the bundled logging stack appear only as retired design records; current search uses PostgreSQL.
The Go worker still implements native, Markdown, DOCX and PDF export.

```sh
nixctl import docs/nix/nix-architecture.nix --workspace <workspace-id>
nixctl import docs/nix/nix-reference.nix --workspace <workspace-id>
```

For offline plain reading and source recovery:

```sh
node --experimental-strip-types scripts/nix-docs.mts list
node --experimental-strip-types scripts/nix-docs.mts read core-api
node --experimental-strip-types scripts/nix-docs.mts read docs/adr/0048-rabbitmq-and-unified-go-workers.md
node --experimental-strip-types scripts/nix-docs.mts source docs/plans/life-os-direction.md
node --experimental-strip-types scripts/nix-docs.mts check
```

Mermaid diagrams appear as source in the terminal and render in Nix. No sign-in is needed for
offline reading.

The source command emits exact UTF-8 bytes, including original line endings. Original Markdown paths
in comments identify native reference notes; they no longer imply a loose Markdown file exists.

The public HTTP API guide, generated reference, and OpenAPI document published with the docs site snapshot are in [docs/site/nix-docs/markdown/api/index.md](site/nix-docs/markdown/api/index.md).

[AGENTS.md](../AGENTS.md), its five focused [contributor guides](agent-guides/), the root bootstrap
[README](../README.md) and offline [release](../deploy/README.md)/[backup](../deploy/backup/production.md)
procedures remain plaintext because tools and recovery must work before Nix is available.
Third-party dependency docs, local runtime/plugin caches and imported design-review source material
are outside this migration. The native reference also preserves the original essential files.

The architecture describes inspected source, including implemented-versus-proposed differences.
Import/export evidence is local. Production deployment, optional provider/device services and disaster
recovery are separate verification scopes.
