using System.Globalization;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Features.Search;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Nix.Persistence.Embeddings;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Passage retrieval over a note and its descendants returns only body text the caller may read:
/// nothing outside the subtree, at or under a lock, trashed, or in a workspace the caller is not in.
/// </summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class NotePassageTests : IAsyncLifetime
{
    private static readonly Guid PrivateWorkspace = new("9a55a6e0-1111-4111-8111-9a55a6e00001");
    private static readonly Guid Member = new("9a55a6e0-1111-4111-8111-9a55a6e00002");
    private static readonly Guid Root = new("9a55a6e0-1111-4111-8111-9a55a6e00003");
    private static readonly Guid Child = new("9a55a6e0-1111-4111-8111-9a55a6e00004");
    private static readonly Guid LockedChild = new("9a55a6e0-1111-4111-8111-9a55a6e00005");
    private static readonly Guid TrashedChild = new("9a55a6e0-1111-4111-8111-9a55a6e00006");
    private static readonly Guid Outside = new("9a55a6e0-1111-4111-8111-9a55a6e00007");
    private static readonly Guid PrivateNote = new("9a55a6e0-1111-4111-8111-9a55a6e00008");

    private readonly NixPostgresFixture _fixture;

    public NotePassageTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        await SeedAsync();
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Finds_passages_in_the_root_and_its_descendants()
    {
        var found = await PassagesAsync(Root, "fee notice");

        Assert.Equal(
            [Root, Child],
            found.Value.Select(passage => passage.ItemId.Value).Order().ToArray());
        Assert.Contains(found.Value, passage => passage.Heading == "Contract › Termination" && passage.Title == "Contract");
    }

    [Fact]
    public async Task Never_returns_locked_trashed_or_outside_text()
    {
        // Every seeded passage holds "fee", so a missing filter has something to wrongly return.
        var found = await PassagesAsync(Root, "fee");

        Assert.DoesNotContain(found.Value, passage => passage.ItemId.Value == LockedChild);
        Assert.DoesNotContain(found.Value, passage => passage.ItemId.Value == TrashedChild);
        Assert.DoesNotContain(found.Value, passage => passage.ItemId.Value == Outside);
    }

    [Fact]
    public async Task A_root_in_a_workspace_the_caller_is_not_in_is_not_found()
    {
        var found = await PassagesAsync(PrivateNote, "fee");

        Assert.True(found.IsFailure);
    }

    [Fact]
    public async Task Finds_a_passage_by_meaning_when_no_word_matches()
    {
        using var embedder = new LocalEmbedder(LocalEmbedder.DefaultDirectory);
        Assert.SkipUnless(embedder.Available, "The local embedding model is not fetched (scripts/fetch-embedding-model.sh).");
        await EmbedAllAsync(embedder);

        // No stem of the query appears in any passage; only the vector arm can answer.
        var found = await PassagesAsync(Root, "ending the agreement early");

        Assert.Equal(Root, found.Value[0].ItemId.Value);
    }

    private async Task<Result<IReadOnlyList<NotePassage>>> PassagesAsync(Guid root, string query)
    {
        var context = TestTenants.ContextFor(M0SchemaSeed.Alpha.TenantId, M0SchemaSeed.Alpha.WorkspaceId, Member);
        var work = await _fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            return await work.Resolve<NixDispatcher>()
                .QueryAsync<GetPassages, Result<IReadOnlyList<NotePassage>>>(
                    new GetPassages(ItemId.From(root), query, GetPassagesHandler.MaximumLimit),
                    Cancellation);
        }
    }

    /// <summary>As the migrator: Core can only read chunks, and the collaboration service writes them.</summary>
    private async Task SeedAsync()
    {
        var tenant = Literal(M0SchemaSeed.Alpha.TenantId);
        var open = Literal(M0SchemaSeed.Alpha.WorkspaceId);
        var closed = Literal(PrivateWorkspace);
        var principal = Literal(M0SchemaSeed.Alpha.PrincipalId);

        string Item(Guid id, string workspace, Guid? parent, string title, string state) =>
            $"({Literal(id)}, {tenant}, {workspace}, 'note', {(parent is { } p ? Literal(p) : "NULL")}, 1, "
            + $"'{{\"title\": \"{title}\"}}'::jsonb, '{state}', NULL, {principal}, {principal}, now(), now())";

        string Edge(Guid descendant, Guid ancestor, string workspace, int depth) =>
            $"({Literal(descendant)}, {Literal(ancestor)}, {tenant}, {workspace}, {depth})";

        string Chunk(Guid item, int ord, string heading, string body) =>
            $"({tenant}, {Literal(item)}, {ord}, 1, '{heading}', '{body}', 'h{ord}', to_tsvector('english', '{heading} {body}'))";

        var sql = $$"""
            INSERT INTO principal
                (principal_id, tenant_id, external_subject, kind, display_name, email, status, deprovisioned_at)
            VALUES ({{Literal(Member)}}, {{tenant}}, 'alpha-passage-member', 'user', 'Member',
                    'passages@example.test', 'active', NULL);

            INSERT INTO workspace_member
                (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            VALUES ({{open}}, 'principal', {{Literal(Member)}}, {{tenant}}, 'viewer', {{principal}}, now());

            INSERT INTO workspace
                (workspace_id, tenant_id, name, version_retention_days, coalesce_window_min,
                 storage_quota_bytes, created_at)
            VALUES ({{closed}}, {{tenant}}, 'Alpha private', 30, 10, 1073741824, now());

            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                 purge_after, created_by, last_modified_by, created_at, last_modified_at)
            VALUES
                {{Item(Root, open, null, "Contract", "active")}},
                {{Item(Child, open, Root, "Invoices", "active")}},
                {{Item(LockedChild, open, Root, "Locked", "active")}},
                {{Item(TrashedChild, open, Root, "Trashed", "deleted")}},
                {{Item(Outside, open, null, "Elsewhere", "active")}},
                {{Item(PrivateNote, closed, null, "Private", "active")}};

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            VALUES
                {{Edge(Root, Root, open, 0)}},
                {{Edge(Child, Child, open, 0)}}, {{Edge(Child, Root, open, 1)}},
                {{Edge(LockedChild, LockedChild, open, 0)}}, {{Edge(LockedChild, Root, open, 1)}},
                {{Edge(TrashedChild, TrashedChild, open, 0)}}, {{Edge(TrashedChild, Root, open, 1)}},
                {{Edge(Outside, Outside, open, 0)}},
                {{Edge(PrivateNote, PrivateNote, closed, 0)}};

            INSERT INTO item_lock (item_id, tenant_id, password_hash, locked_by, locked_at)
            VALUES ({{Literal(LockedChild)}}, {{tenant}},
                    'pbkdf2-sha256$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
                    {{principal}}, now());

            INSERT INTO item_chunk (tenant_id, item_id, ord, seq, heading, body, content_hash, body_vector)
            VALUES
                {{Chunk(Root, 0, "Contract › Termination", "Either party may terminate with thirty days written warning; no fee applies.")}},
                {{Chunk(Child, 0, "", "Late fees are two percent of the invoice, charged after notice.")}},
                {{Chunk(LockedChild, 0, "", "The secret fee schedule and notice terms.")}},
                {{Chunk(TrashedChild, 0, "", "Old fee notice drafts.")}},
                {{Chunk(Outside, 0, "", "An unrelated fee notice.")}},
                {{Chunk(PrivateNote, 0, "", "A private fee notice.")}};
            """;

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }

    private async Task EmbedAllAsync(LocalEmbedder embedder)
    {
        var rows = new (Guid Item, string Text)[]
        {
            (Root, "Contract › Termination\nEither party may terminate with thirty days written warning; no fee applies."),
            (Child, "Late fees are two percent of the invoice, charged after notice."),
        };
        var vectors = embedder.Embed([.. rows.Select(row => row.Text)])!;
        var updates = string.Join('\n', rows.Select((row, index) =>
            $"UPDATE item_chunk SET embedding = '{LocalEmbedder.ToLiteral(vectors[index])}'::vector WHERE item_id = {Literal(row.Item)};"));

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, updates);
        }
    }

    private static string Literal(Guid value) =>
        $"'{value.ToString("D", CultureInfo.InvariantCulture)}'::uuid";
}
