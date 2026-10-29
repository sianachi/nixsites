using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>[SEC] Retrieval chunks of note bodies, for pet search over a note and its descendants.</summary>
/// <remarks>
/// <para>
/// Derived like <c>item_search</c>, with the same split: the collaboration service writes the
/// chunks, and the application reads them. The one exception is the embedding, which Core computes.
/// Core writes it only through <c>nix_set_chunk_embedding</c>, which cannot change a chunk's text,
/// and finds work only through <c>nix_find_unembedded_chunks</c>, because the embedder runs for
/// every tenant at once.
/// </para>
/// <para>
/// <c>vector(384)</c> is the one local model's dimension. There is no ANN index, because a search
/// scans one note's subtree and never the whole table. shortcut: exact cosine scan per subtree;
/// add HNSW if whole-workspace semantic search is ever wanted.
/// </para>
/// </remarks>
[DbContext(typeof(NixDbContext))]
[Migration("20261028160000_ItemChunks")]
public sealed class ItemChunks : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) => migrationBuilder.Sql("""
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
                RAISE EXCEPTION 'pgvector is not installed in this database; run deploy/seed/seed.sh before migrating';
            END IF;
        END
        $$;

        CREATE TABLE item_chunk (
            tenant_id    uuid NOT NULL,
            item_id      uuid NOT NULL,
            ord          integer NOT NULL CHECK (ord >= 0),
            seq          bigint NOT NULL,
            heading      text NOT NULL,
            body         text NOT NULL,
            content_hash text NOT NULL,
            body_vector  tsvector NOT NULL,
            embedding    vector(384),
            PRIMARY KEY (tenant_id, item_id, ord),
            FOREIGN KEY (tenant_id, item_id) REFERENCES item (tenant_id, id) ON DELETE CASCADE
        );
        CREATE INDEX ix_item_chunk_body_vector ON item_chunk USING GIN (body_vector);
        CREATE INDEX ix_item_chunk_unembedded ON item_chunk (tenant_id, item_id, ord) WHERE embedding IS NULL;

        ALTER TABLE item_chunk ENABLE ROW LEVEL SECURITY;
        ALTER TABLE item_chunk FORCE ROW LEVEL SECURITY;
        CREATE POLICY item_chunk_tenant_isolation ON item_chunk
            USING (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid)
            WITH CHECK (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid);

        -- Default privileges handed nix_app full DML; take it back.
        REVOKE ALL ON item_chunk FROM PUBLIC, nix_app;
        GRANT SELECT ON item_chunk TO nix_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON item_chunk TO nix_collab;

        CREATE FUNCTION nix_find_unembedded_chunks(p_limit integer)
        RETURNS TABLE (tenant_id uuid, item_id uuid, ord integer, content_hash text, heading text, body text)
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog, public, pg_temp
        AS $function$
            SELECT c.tenant_id, c.item_id, c.ord, c.content_hash, c.heading, c.body
              FROM public.item_chunk c
             WHERE c.embedding IS NULL
             ORDER BY c.tenant_id, c.item_id, c.ord
             LIMIT least(greatest(coalesce(p_limit, 1), 1), 100);
        $function$;
        REVOKE ALL ON FUNCTION nix_find_unembedded_chunks(integer) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION nix_find_unembedded_chunks(integer) TO nix_app;

        CREATE FUNCTION nix_set_chunk_embedding(
            p_tenant_id uuid, p_item_id uuid, p_ord integer, p_content_hash text, p_embedding vector)
        RETURNS void
        LANGUAGE sql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog, public, pg_temp
        AS $function$
            -- The hash check drops an embedding of text that changed while it was being computed.
            UPDATE public.item_chunk
               SET embedding = p_embedding
             WHERE tenant_id = p_tenant_id
               AND item_id = p_item_id
               AND ord = p_ord
               AND content_hash = p_content_hash
               AND embedding IS NULL;
        $function$;
        REVOKE ALL ON FUNCTION nix_set_chunk_embedding(uuid, uuid, integer, text, vector) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION nix_set_chunk_embedding(uuid, uuid, integer, text, vector) TO nix_app;
        """);

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) => migrationBuilder.Sql("""
        DROP FUNCTION IF EXISTS nix_set_chunk_embedding(uuid, uuid, integer, text, vector);
        DROP FUNCTION IF EXISTS nix_find_unembedded_chunks(integer);
        DROP TABLE IF EXISTS item_chunk;
        """);
}
