using System.Globalization;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Search;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Search, reference resolution and backlinks return only what the acting principal may read, and
/// the filtering happens inside the query rather than after it.
/// </summary>
/// <remarks>
/// <para>
/// These are the crown-jewel assertions for MVP-3's three read paths, and every one of them is
/// written from the refused side first. A search is the easiest place in a product to leak
/// something: it is the one read that starts from no identifier at all, so nothing the caller
/// supplies bounds what it may return, and a filter applied one step too late shows up as a title
/// in a dropdown rather than as an error anybody notices.
/// </para>
/// <para>
/// Two tenants and, inside one tenant, two workspaces. The second workspace is the interesting one:
/// row-level security has nothing to say about it - both workspaces belong to the same tenant, so
/// every row is visible to the policy - and only the permission predicate keeps it out of the
/// answer.
/// </para>
/// </remarks>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class SearchAuthorizationTests : IAsyncLifetime
{
    /// <summary>A second workspace in Alpha's tenant, which the acting principal is not a member of.</summary>
    private static readonly Guid PrivateWorkspace = new("5eacf000-1111-4111-8111-5eacf0000001");

    /// <summary>An item in the workspace the acting principal is a member of.</summary>
    private static readonly Guid VisibleItem = new("5eacf000-1111-4111-8111-5eacf0000002");

    /// <summary>An item in the workspace the acting principal is not a member of.</summary>
    private static readonly Guid PrivateItem = new("5eacf000-1111-4111-8111-5eacf0000003");

    /// <summary>A second visible item, so a link has somewhere to point from.</summary>
    private static readonly Guid VisibleSource = new("5eacf000-1111-4111-8111-5eacf0000004");

    /// <summary>
    /// A member of the open workspace and of nothing else.
    /// </summary>
    /// <remarks>
    /// <b>Not the seeded Alpha principal, and that distinction is the whole fixture.</b> The shared
    /// seed makes that principal a tenant administrator, and an administrator reaches every
    /// workspace in the tenant by design - so every assertion below would have passed for the wrong
    /// reason, or failed while the code was right. Written from the seat of somebody who was
    /// granted one workspace and nothing more, these tests fail the moment the permission predicate
    /// leaves a query.
    /// </remarks>
    private static readonly Guid Member = new("5eacf000-1111-4111-8111-5eacf0000005");

    /// <summary>A deleted parent introduced by tests that exercise derived visibility.</summary>
    private static readonly Guid DeletedAncestor = new("5eacf000-1111-4111-8111-5eacf0000006");

    private readonly NixPostgresFixture _fixture;

    public SearchAuthorizationTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static Nix.Abstractions.NixSessionContext MemberContext => TestTenants.ContextFor(
        M0SchemaSeed.Alpha.TenantId,
        M0SchemaSeed.Alpha.WorkspaceId,
        Member);

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        await SeedSearchableCorpusAsync();
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task A_search_finds_an_item_by_part_of_its_title()
    {
        var found = await SearchAsync("quarter");

        // Substring, not prefix. Nobody typing into a palette starts at the beginning of the title,
        // which is exactly what the pre-existing title index could serve and why a trigram index
        // was added beside it.
        Assert.Contains(found.Hits, hit => hit.Id == ItemId.From(VisibleItem));
    }

    [Fact]
    public async Task A_search_finds_an_item_by_words_only_its_document_holds()
    {
        // "photosynthesis" appears nowhere in any title. It is in the indexed body text, which is
        // written by the collaboration service and joined here - the half of search that does not
        // exist without the derived table.
        var found = await SearchAsync("photosynthesis");

        Assert.Contains(found.Hits, hit => hit.Id == ItemId.From(VisibleItem));
    }

    [Fact]
    public async Task A_title_match_ranks_above_a_document_match()
    {
        // Somebody typing into a palette is usually trying to reach a document they can already
        // name. The note that merely mentions the word must not come above the note called it.
        var found = await SearchAsync("ledger");

        Assert.Equal(ItemId.From(VisibleSource), found.Hits[0].Id);
        Assert.Contains(found.Hits, hit => hit.Id == ItemId.From(VisibleItem));
    }

    [Theory]
    [InlineData("true")]
    [InlineData("null")]
    public async Task A_pet_source_search_omits_withheld_items_before_the_limit(string protection)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, $$"""
                UPDATE item SET settings = '{"withholdFromPets": {{protection}}}'::jsonb
                WHERE id = {{Literal(VisibleSource)}};
                """);
        }

        var workspace = WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId);
        Assert.Equal(ItemId.From(VisibleSource), Assert.Single((await SearchAsync("ledger", limit: 1)).Hits).Id);
        Assert.Equal(ItemId.From(VisibleItem), Assert.Single((await SearchAsync("ledger", limit: 1, petWorkspace: workspace)).Hits).Id);
        Assert.Empty((await SearchAsync("numbers", petWorkspace: workspace)).Hits);
        Assert.Empty((await SearchAsync("ledger", petWorkspace: WorkspaceId.From(PrivateWorkspace))).Hits);
    }

    [Fact]
    public async Task A_search_never_returns_an_item_from_a_workspace_the_caller_is_not_in()
    {
        // Same tenant, so row-level security lets the row through and only the permission
        // predicate stops it. The title and the body both match on purpose, so a filter missing
        // from either arm of the query fails here.
        var byTitle = await SearchAsync("confidential");
        var byBody = await SearchAsync("acquisition");

        Assert.Empty(byTitle.Hits);
        Assert.Empty(byBody.Hits);
    }

    [Fact]
    public async Task Search_omits_an_active_descendant_of_a_deleted_ancestor_for_title_and_body_matches()
    {
        await HideBelowDeletedAncestorAsync(VisibleItem);

        Assert.Empty((await SearchAsync("quarter")).Hits);
        Assert.Empty((await SearchAsync("photosynthesis")).Hits);
    }

    [Fact]
    public async Task A_hidden_higher_ranked_search_match_does_not_spend_the_limit()
    {
        await HideBelowDeletedAncestorAsync(VisibleSource);

        var found = await SearchAsync("ledger", limit: 1);

        var hit = Assert.Single(found.Hits);
        Assert.Equal(ItemId.From(VisibleItem), hit.Id);
    }

    [Fact]
    public async Task A_search_pattern_typed_by_a_person_is_not_a_wildcard()
    {
        // A bare '%' means "every title" to ILIKE. Somebody who types one into a search box is
        // searching for a per-cent sign, and must not be handed the whole tenant - including the
        // workspace they cannot read, had the permission predicate also been missing.
        var found = await SearchAsync("%");

        Assert.Empty(found.Hits);
    }

    [Fact]
    public async Task A_blank_search_returns_nothing_rather_than_everything()
    {
        // What an interface sends while somebody is still deleting what they typed.
        var found = await SearchAsync("   ");

        Assert.Empty(found.Hits);
    }

    [Fact]
    public async Task Resolving_a_reference_returns_a_title_only_for_a_readable_target()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var resolved = await work.Resolve<NixDispatcher>()
                .QueryAsync<ResolveReferences, Result<ResolvedReferences>>(
                    new ResolveReferences([ItemId.From(VisibleItem), ItemId.From(PrivateItem)]),
                    Cancellation);

            Assert.True(resolved.IsSuccess);

            var answers = resolved.Value.Resolutions;

            // Answered in the order asked, both of them. The client has a reference per position
            // in a document and must not have to match answers up by identifier.
            Assert.Equal(2, answers.Count);
            Assert.Equal(ItemId.From(VisibleItem), answers[0].Id);
            Assert.Equal(ItemId.From(PrivateItem), answers[1].Id);

            Assert.Equal("Quarterly notes", answers[0].Item?.Title);

            // The one that matters. A reference node caches the target's title so it can render
            // something before resolution returns, and that cache is a title this reader has no
            // entitlement to. Resolution has to be what refuses it.
            Assert.Null(answers[1].Item);
        }
    }

    [Fact]
    public async Task Resolving_an_identifier_that_does_not_exist_is_indistinguishable_from_one_refused()
    {
        var missing = ItemId.From(new Guid("5eacf000-1111-4111-8111-5eacf00000ff"));

        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var resolved = await work.Resolve<NixDispatcher>()
                .QueryAsync<ResolveReferences, Result<ResolvedReferences>>(
                    new ResolveReferences([missing, ItemId.From(PrivateItem)]),
                    Cancellation);

            // Never existed and not yours to see are one answer. Telling them apart is how an
            // outsider enumerates a tenant one identifier at a time.
            Assert.True(resolved.IsSuccess);
            Assert.All(resolved.Value.Resolutions, resolution => Assert.Null(resolution.Item));
        }
    }

    [Fact]
    public async Task Resolving_an_active_descendant_of_a_deleted_ancestor_returns_no_title()
    {
        await HideBelowDeletedAncestorAsync(VisibleItem);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var resolved = await work.Resolve<NixDispatcher>()
                .QueryAsync<ResolveReferences, Result<ResolvedReferences>>(
                    new ResolveReferences([ItemId.From(VisibleItem)]),
                    Cancellation);

            Assert.True(resolved.IsSuccess);
            Assert.Null(Assert.Single(resolved.Value.Resolutions).Item);
        }
    }

    [Fact]
    public async Task Backlinks_list_the_documents_that_point_at_an_item()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>()
                .QueryAsync<GetBacklinks, Result<BacklinkResults>>(
                    new GetBacklinks(ItemId.From(VisibleItem), GetBacklinksHandler.DefaultLimit),
                    Cancellation);

            Assert.True(result.IsSuccess);

            var backlink = Assert.Single(result.Value.Backlinks);
            Assert.Equal(ItemId.From(VisibleSource), backlink.Source.Id);
            Assert.Equal(3, backlink.Occurrences);
        }
    }

    [Fact]
    public async Task Backlinks_omit_a_referring_document_the_caller_may_not_read()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>()
                .QueryAsync<GetBacklinks, Result<BacklinkResults>>(
                    new GetBacklinks(ItemId.From(VisibleItem), GetBacklinksHandler.DefaultLimit),
                    Cancellation);

            Assert.True(result.IsSuccess);

            // The private item links to the visible one as well, three edges to the source's one
            // row. Being entitled to the item in front of you does not entitle you to learn that a
            // document in a workspace you cannot reach mentions it - and it must be missing from
            // the count as well as from the list, which is why this asserts on Single above and on
            // the absence here rather than on a number.
            Assert.DoesNotContain(result.Value.Backlinks, backlink => backlink.Source.Id == ItemId.From(PrivateItem));
        }
    }

    [Fact]
    public async Task Backlinks_omit_an_active_source_below_a_deleted_ancestor()
    {
        await HideBelowDeletedAncestorAsync(VisibleSource);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>()
                .QueryAsync<GetBacklinks, Result<BacklinkResults>>(
                    new GetBacklinks(ItemId.From(VisibleItem), GetBacklinksHandler.DefaultLimit),
                    Cancellation);

            Assert.True(result.IsSuccess);
            Assert.Empty(result.Value.Backlinks);
        }
    }

    [Fact]
    public async Task A_hidden_high_occurrence_backlink_does_not_spend_the_limit()
    {
        await AddVisibleBacklinkAsync();
        await HideBelowDeletedAncestorAsync(VisibleSource);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>()
                .QueryAsync<GetBacklinks, Result<BacklinkResults>>(
                    new GetBacklinks(ItemId.From(VisibleItem), 1),
                    Cancellation);

            Assert.True(result.IsSuccess);
            var backlink = Assert.Single(result.Value.Backlinks);
            Assert.Equal(ItemId.From(M0SchemaSeed.Alpha.ItemId), backlink.Source.Id);
        }
    }

    [Fact]
    public async Task Backlinks_of_an_active_target_below_a_deleted_ancestor_are_reported_as_not_found()
    {
        await HideBelowDeletedAncestorAsync(VisibleItem);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>()
                .QueryAsync<GetBacklinks, Result<BacklinkResults>>(
                    new GetBacklinks(ItemId.From(VisibleItem), GetBacklinksHandler.DefaultLimit),
                    Cancellation);

            Assert.True(result.IsFailure);
            Assert.Equal("items.not_found", result.Error.Code);
        }
    }

    [Fact]
    public async Task Backlinks_of_an_item_the_caller_may_not_read_are_reported_as_not_found()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>()
                .QueryAsync<GetBacklinks, Result<BacklinkResults>>(
                    new GetBacklinks(ItemId.From(PrivateItem), GetBacklinksHandler.DefaultLimit),
                    Cancellation);

            // Not "nothing points at it", which for an identifier somebody guessed is still a
            // statement about a document they may not see.
            Assert.True(result.IsFailure);
            Assert.Equal("items.not_found", result.Error.Code);
        }
    }

    [Fact]
    public async Task One_tenant_never_finds_another_tenant_s_items()
    {
        // Beta's item is titled "Beta ledger" and indexed with the same word this searches for, so
        // there is something for a missing tenant predicate to wrongly return. Asserted from
        // Alpha's side, which is the side that would leak.
        var found = await SearchAsync("ledger");

        Assert.NotEmpty(found.Hits);
        Assert.DoesNotContain(found.Hits, hit => hit.Id == ItemId.From(M0SchemaSeed.Beta.ItemId));
        Assert.All(found.Hits, hit => Assert.NotEqual(
            Nix.Domain.Tenancy.WorkspaceId.From(M0SchemaSeed.Beta.WorkspaceId),
            hit.WorkspaceId));
    }

    [Fact]
    public async Task A_principal_who_is_a_member_of_nothing_finds_nothing()
    {
        // The seeded Beta principal, asking inside Alpha's tenant. Every row is invisible to the
        // policy and the readable-workspace set is empty as well, so the query is never even run -
        // which is the behaviour, not an optimisation to be removed.
        var context = TestTenants.ContextFor(
            M0SchemaSeed.Alpha.TenantId,
            M0SchemaSeed.Alpha.WorkspaceId,
            M0SchemaSeed.Beta.PrincipalId);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>()
                .QueryAsync<SearchItems, Result<SearchResults>>(
                    new SearchItems("ledger", SearchItemsHandler.DefaultLimit),
                    Cancellation);

            Assert.True(result.IsSuccess);
            Assert.Empty(result.Value.Hits);
        }
    }

    private async Task<SearchResults> SearchAsync(
        string query, int limit = SearchItemsHandler.DefaultLimit, WorkspaceId? petWorkspace = null)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>()
                .QueryAsync<SearchItems, Result<SearchResults>>(
                    new SearchItems(query, limit, petWorkspace),
                    Cancellation);

            Assert.True(result.IsSuccess);
            return result.Value;
        }
    }

    /// <summary>
    /// Seeds two workspaces' worth of items, their indexed text, and the edges between them.
    /// </summary>
    /// <remarks>
    /// Written as the migrator because Core holds <c>SELECT</c> on both derived tables and could
    /// not write these rows if it tried - which is the property under test elsewhere, and here is
    /// simply the reason the fixture cannot go through the application.
    /// </remarks>
    private async Task SeedSearchableCorpusAsync()
    {
        var tenant = Literal(M0SchemaSeed.Alpha.TenantId);
        var openWorkspace = Literal(M0SchemaSeed.Alpha.WorkspaceId);
        var closedWorkspace = Literal(PrivateWorkspace);
        var principal = Literal(M0SchemaSeed.Alpha.PrincipalId);

        var sql = $$"""
            INSERT INTO principal
                (principal_id, tenant_id, external_subject, kind, display_name, email, status,
                 deprovisioned_at)
            VALUES ({{Literal(Member)}}, {{tenant}}, 'alpha-search-member', 'user', 'Member',
                    'member@example.test', 'active', NULL);

            INSERT INTO workspace_member
                (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            VALUES ({{openWorkspace}}, 'principal', {{Literal(Member)}}, {{tenant}}, 'viewer',
                    {{principal}}, now());

            INSERT INTO workspace
                (workspace_id, tenant_id, name, version_retention_days, coalesce_window_min,
                 storage_quota_bytes, created_at)
            VALUES ({{closedWorkspace}}, {{tenant}}, 'Alpha private', 30, 10, 1073741824, now());

            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                 purge_after, created_by, last_modified_by, created_at, last_modified_at)
            VALUES
                ({{Literal(VisibleItem)}}, {{tenant}}, {{openWorkspace}}, 'note', NULL, 2000,
                 '{"title": "Quarterly notes"}'::jsonb, 'active', NULL, {{principal}}, {{principal}},
                 now(), now()),
                ({{Literal(VisibleSource)}}, {{tenant}}, {{openWorkspace}}, 'note', NULL, 3000,
                 '{"title": "Ledger review"}'::jsonb, 'active', NULL, {{principal}}, {{principal}},
                 now(), now()),
                ({{Literal(PrivateItem)}}, {{tenant}}, {{closedWorkspace}}, 'note', NULL, 4000,
                 '{"title": "Confidential ledger"}'::jsonb, 'active', NULL, {{principal}},
                 {{principal}}, now(), now());

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            VALUES
                ({{Literal(VisibleItem)}}, {{Literal(VisibleItem)}}, {{tenant}}, {{openWorkspace}}, 0),
                ({{Literal(VisibleSource)}}, {{Literal(VisibleSource)}}, {{tenant}}, {{openWorkspace}}, 0),
                ({{Literal(PrivateItem)}}, {{Literal(PrivateItem)}}, {{tenant}}, {{closedWorkspace}}, 0);

            INSERT INTO item_search (tenant_id, item_id, seq, updated_at, body_vector)
            VALUES
                ({{tenant}}, {{Literal(VisibleItem)}}, 1, now(),
                 to_tsvector('english', 'Notes on photosynthesis and on the ledger')),
                ({{tenant}}, {{Literal(VisibleSource)}}, 1, now(),
                 to_tsvector('english', 'A review of the numbers')),
                ({{tenant}}, {{Literal(PrivateItem)}}, 1, now(),
                 to_tsvector('english', 'The acquisition and its terms'));

            INSERT INTO item_link (tenant_id, source_item_id, target_item_id, occurrences, seq)
            VALUES
                ({{tenant}}, {{Literal(VisibleSource)}}, {{Literal(VisibleItem)}}, 3, 1),
                ({{tenant}}, {{Literal(PrivateItem)}}, {{Literal(VisibleItem)}}, 1, 1);

            -- Beta's own corpus, using the same words, so a missing tenant predicate has something
            -- to wrongly return. Updates rather than inserts: the shared seed already gives every
            -- tenant's item a row in both tables, and this only changes what they say.
            UPDATE item
               SET properties = '{"title": "Beta ledger"}'::jsonb
             WHERE tenant_id = {{Literal(M0SchemaSeed.Beta.TenantId)}}
               AND id = {{Literal(M0SchemaSeed.Beta.ItemId)}};

            UPDATE item_search
               SET body_vector = to_tsvector('english', 'Beta keeps a ledger too')
             WHERE tenant_id = {{Literal(M0SchemaSeed.Beta.TenantId)}}
               AND item_id = {{Literal(M0SchemaSeed.Beta.ItemId)}};
            """;

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }

    private async Task HideBelowDeletedAncestorAsync(Guid itemId)
    {
        var tenant = Literal(M0SchemaSeed.Alpha.TenantId);
        var workspace = Literal(M0SchemaSeed.Alpha.WorkspaceId);
        var principal = Literal(M0SchemaSeed.Alpha.PrincipalId);
        var ancestor = Literal(DeletedAncestor);

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $$"""
                  INSERT INTO item
                      (id, tenant_id, workspace_id, type, parent_id, seq, properties,
                       lifecycle_state, purge_after, created_by, last_modified_by, created_at,
                       last_modified_at)
                  VALUES
                      ({{ancestor}}, {{tenant}}, {{workspace}}, 'note', NULL, 5000,
                       '{"title": "Deleted ancestor"}'::jsonb, 'deleted', NULL, {{principal}},
                       {{principal}}, now(), now());

                  INSERT INTO item_closure
                      (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
                  VALUES
                      ({{ancestor}}, {{ancestor}}, {{tenant}}, {{workspace}}, 0),
                      ({{Literal(itemId)}}, {{ancestor}}, {{tenant}}, {{workspace}}, 1);

                  UPDATE item SET parent_id = {{ancestor}} WHERE id = {{Literal(itemId)}};
                  """);
        }
    }

    private async Task AddVisibleBacklinkAsync()
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $$"""
                  INSERT INTO item_link
                      (tenant_id, source_item_id, target_item_id, occurrences, seq)
                  VALUES
                      ({{Literal(M0SchemaSeed.Alpha.TenantId)}},
                       {{Literal(M0SchemaSeed.Alpha.ItemId)}}, {{Literal(VisibleItem)}}, 1, 1);
                  """);
        }
    }

    private static string Literal(Guid value) =>
        $"'{value.ToString("D", CultureInfo.InvariantCulture)}'::uuid";
}
