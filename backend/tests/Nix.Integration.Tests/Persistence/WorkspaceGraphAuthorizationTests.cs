using System.Globalization;
using Nix.Abstractions;
using Nix.Domain.Graph;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Graph;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The workspace graph returns only what the acting principal may read, and the filtering happens
/// inside the query rather than after it.
/// </summary>
/// <remarks>
/// <para>
/// This is the widest read in the product: one request, and back come the name and the parent of
/// everything in a workspace, plus who references whom. Every other item read starts from an
/// identifier the caller already holds, so nothing they supply bounds this one. A permission filter
/// one step too late surfaces here as a picture, and nobody diffs a picture.
/// </para>
/// <para>
/// Two tenants, and inside one tenant two workspaces. The second workspace is the interesting one:
/// row-level security has nothing to say about it - both workspaces belong to the same tenant, so
/// every row is visible to the policy - and only the permission predicate keeps it out of the
/// answer. The cross-tenant case is the backstop, asserted by handing the reader a readable set it
/// has no business being given and finding that the policy still returns nothing.
/// </para>
/// </remarks>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class WorkspaceGraphAuthorizationTests : IAsyncLifetime
{
    /// <summary>A second workspace in Alpha's tenant, which the acting principal is not a member of.</summary>
    private static readonly Guid PrivateWorkspace = new("6a4a4000-1111-4111-8111-6a4a40000001");

    /// <summary>The first item of the open workspace, and the one that does the referencing.</summary>
    private static readonly Guid VisibleSource = new("6a4a4000-1111-4111-8111-6a4a40000002");

    /// <summary>A child of <see cref="VisibleRoot"/>, sequenced ahead of its own parent.</summary>
    private static readonly Guid VisibleChild = new("6a4a4000-1111-4111-8111-6a4a40000003");

    /// <summary>The parent of <see cref="VisibleChild"/>, sequenced last on purpose.</summary>
    private static readonly Guid VisibleRoot = new("6a4a4000-1111-4111-8111-6a4a40000004");

    /// <summary>An item in the workspace the acting principal is not a member of.</summary>
    private static readonly Guid PrivateItem = new("6a4a4000-1111-4111-8111-6a4a40000005");

    /// <summary>
    /// A member of the open workspace and of nothing else.
    /// </summary>
    /// <remarks>
    /// Not the seeded Alpha principal, who is a tenant administrator and therefore reaches every
    /// workspace in the tenant by design - which would make every assertion below pass for the
    /// wrong reason. Written from the seat of somebody granted one workspace and nothing more,
    /// these tests fail the moment the permission predicate leaves the statement.
    /// </remarks>
    private static readonly Guid Member = new("6a4a4000-1111-4111-8111-6a4a40000006");

    private readonly NixPostgresFixture _fixture;
    private readonly ITestOutputHelper _output;

    public WorkspaceGraphAuthorizationTests(NixPostgresFixture fixture, ITestOutputHelper output)
    {
        _fixture = fixture;
        _output = output;
    }

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static NixSessionContext MemberContext => TestTenants.ContextFor(
        M0SchemaSeed.Alpha.TenantId,
        M0SchemaSeed.Alpha.WorkspaceId,
        Member);

    private static WorkspaceId OpenWorkspace => WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId);

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        await SeedGraphAsync();
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task A_graph_carries_the_workspace_s_items_and_the_edges_between_them()
    {
        var graph = await ReadGraphAsync(OpenWorkspace);

        Assert.Equal(
            new HashSet<ItemId>
            {
                ItemId.From(M0SchemaSeed.Alpha.ItemId),
                ItemId.From(VisibleSource),
                ItemId.From(VisibleChild),
                ItemId.From(VisibleRoot),
            },
            graph.Nodes.Select(node => node.Id).ToHashSet());

        var link = Assert.Single(graph.Links);
        Assert.Equal(ItemId.From(VisibleSource), link.SourceId);
        Assert.Equal(ItemId.From(VisibleChild), link.TargetId);
    }

    [Fact]
    public async Task A_node_carries_its_title_its_body_kind_and_its_parent_and_nothing_else()
    {
        var graph = await ReadGraphAsync(OpenWorkspace);

        var child = graph.Nodes.Single(node => node.Id == ItemId.From(VisibleChild));

        Assert.Equal("Ledger review", child.Title);
        Assert.Equal("note", child.Type);
        Assert.Equal(ItemId.From(VisibleRoot), child.ParentId);
    }

    [Fact]
    public async Task An_item_that_has_never_been_named_comes_back_with_no_title_rather_than_an_invented_one()
    {
        // The shared seed's item has null properties. A name a person did not choose is copy, and
        // copy belongs where it can be translated - not in a projection.
        var graph = await ReadGraphAsync(OpenWorkspace);

        var unnamed = graph.Nodes.Single(node => node.Id == ItemId.From(M0SchemaSeed.Alpha.ItemId));

        Assert.Null(unnamed.Title);
    }

    [Fact]
    public async Task A_graph_omits_an_item_the_caller_may_not_read()
    {
        // Same tenant, so row-level security lets the row through and only the permission predicate
        // stops it. The item is in another workspace of the same tenant, which is the only shape
        // "unreadable to this caller" currently takes.
        var graph = await ReadGraphAsync(OpenWorkspace);

        Assert.DoesNotContain(graph.Nodes, node => node.Id == ItemId.From(PrivateItem));
    }

    [Fact]
    public async Task A_graph_omits_every_edge_that_touches_an_item_the_caller_may_not_read()
    {
        // Two such edges are seeded, one in each direction: the private item refers to a visible
        // one, and a visible one refers to the private item. Both ends of an edge are a disclosure,
        // so neither direction may survive - and neither may be returned with the far end blanked,
        // which would say that something is there.
        var graph = await ReadGraphAsync(OpenWorkspace);

        Assert.DoesNotContain(
            graph.Links,
            link => link.SourceId == ItemId.From(PrivateItem) || link.TargetId == ItemId.From(PrivateItem));
    }

    [Fact]
    public async Task A_graph_omits_an_active_descendant_of_a_deleted_ancestor_and_every_edge_touching_it()
    {
        await SetLifecycleAsync(VisibleRoot, "deleted");

        var graph = await ReadGraphAsync(OpenWorkspace);

        Assert.DoesNotContain(graph.Nodes, node => node.Id == ItemId.From(VisibleRoot));
        Assert.DoesNotContain(graph.Nodes, node => node.Id == ItemId.From(VisibleChild));
        Assert.DoesNotContain(
            graph.Links,
            link => link.SourceId == ItemId.From(VisibleChild) || link.TargetId == ItemId.From(VisibleChild));
    }

    [Fact]
    public async Task A_graph_cannot_rebuild_the_listing_of_a_folder_under_a_closed_lock()
    {
        var opener = new Guid("6a4a4000-1111-4111-8111-6a4a400000cc");
        await AddLockedBodyEdgesAsync();
        await LockVisibleRootAsync(grantedTo: opener);

        // ADR-0056: nodes carry title and parent, so drawing what sits under a closed lock would
        // list the locked folder's children - the listing the children read refuses. The folder
        // itself stays; the edge into the hidden child goes with it.
        var closed = await ReadGraphAsync(OpenWorkspace);
        Assert.Contains(closed.Nodes, node => node.Id == ItemId.From(VisibleRoot));
        Assert.DoesNotContain(closed.Nodes, node => node.Id == ItemId.From(VisibleChild));
        Assert.DoesNotContain(closed.Nodes, node => node.ParentId == ItemId.From(VisibleRoot));
        Assert.DoesNotContain(closed.Links, link => link.TargetId == ItemId.From(VisibleChild));

        // The credential that opened the lock is shown the folder's contents, as its listing is.
        var opened = await ReadGraphAsync(OpenWorkspace, credential: opener);
        Assert.Contains(opened.Nodes, node => node.Id == ItemId.From(VisibleChild));
        Assert.Contains(opened.Links, link => link.TargetId == ItemId.From(VisibleChild));
        Assert.DoesNotContain(opened.Links, link => link.SourceId == ItemId.From(VisibleRoot));
        Assert.DoesNotContain(opened.Links, link => link.SourceId == ItemId.From(VisibleChild));
    }

    [Fact]
    public async Task A_hidden_early_node_does_not_spend_the_node_ceiling()
    {
        await SetSequenceAsync(VisibleChild, 1);
        await SetLifecycleAsync(VisibleRoot, "deleted");

        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var graph = await work.Resolve<IWorkspaceGraph>().ReadAsync(
                OpenWorkspace,
                [OpenWorkspace],
                nodeLimit: 1,
                linkLimit: GetWorkspaceGraphHandler.MaximumLinks,
                Cancellation);

            var node = Assert.Single(graph.Nodes);
            Assert.NotEqual(ItemId.From(VisibleChild), node.Id);
        }
    }

    [Theory]
    [InlineData("google", true, true)]
    [InlineData("google", false, false)]
    [InlineData("microsoft", true, false)]
    [InlineData("microsoft", false, true)]
    public async Task Calendar_imports_and_their_edges_are_omitted_but_containers_and_Nix_authored_events_stay(
        string provider, bool readOnly, bool managed)
    {
        await MarkCalendarItemsAsync(provider, readOnly, managed);

        var graph = await ReadGraphAsync(OpenWorkspace);

        Assert.Equal(3, graph.Nodes.Count);
        Assert.DoesNotContain(graph.Nodes, node => node.Id == ItemId.From(VisibleSource));
        Assert.Contains(graph.Nodes, node => node.Id == ItemId.From(VisibleRoot));
        Assert.Contains(graph.Nodes, node => node.Id == ItemId.From(VisibleChild));
        Assert.Empty(graph.Links);
    }

    [Fact]
    public async Task An_imported_calendar_event_does_not_spend_the_node_ceiling()
    {
        await MarkCalendarItemsAsync("google", readOnly: false, managed: true);
        await SetSequenceAsync(VisibleSource, 1);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var graph = await work.Resolve<IWorkspaceGraph>().ReadAsync(
                OpenWorkspace,
                [OpenWorkspace],
                nodeLimit: 1,
                linkLimit: GetWorkspaceGraphHandler.MaximumLinks,
                Cancellation);

            var node = Assert.Single(graph.Nodes);
            Assert.NotEqual(ItemId.From(VisibleSource), node.Id);
        }
    }

    [Fact]
    public async Task A_calendar_heavy_workspace_returns_its_own_notes_without_false_truncation()
    {
        var tenant = Literal(M0SchemaSeed.Alpha.TenantId);
        var workspace = Literal(M0SchemaSeed.Alpha.WorkspaceId);
        var principal = Literal(M0SchemaSeed.Alpha.PrincipalId);
        var seed = $$"""
            WITH inserted AS (
                INSERT INTO item
                    (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                     created_by, last_modified_by, created_at, last_modified_at)
                SELECT gen_random_uuid(), {{tenant}}, {{workspace}}, 'note', {{Literal(VisibleRoot)}},
                       10000 + n, jsonb_build_object('title', 'Event ' || n, 'start', '2026-10-08')
                       || CASE WHEN n <= 10000 THEN '{"$cal_source":"google"}'::jsonb ELSE '{}'::jsonb END,
                       'active', {{principal}}, {{principal}}, now(), now()
                FROM generate_series(1, 11000) AS n
                RETURNING id
            )
            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT id, id, {{tenant}}, {{workspace}}, 0 FROM inserted
            UNION ALL
            SELECT id, {{Literal(VisibleRoot)}}, {{tenant}}, {{workspace}}, 1 FROM inserted;
            ANALYZE item;
            ANALYZE item_closure;
            """;
        var migrator = await _fixture.OpenMigratorConnectionAsync();
        await using (migrator.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(migrator, transaction: null, seed);
        }

        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>()
                .QueryAsync<GetWorkspaceGraph, Result<WorkspaceGraphResults>>(
                    new GetWorkspaceGraph(OpenWorkspace), Cancellation);
            Assert.True(result.IsSuccess);
            Assert.Equal(1004, result.Value.Graph.Nodes.Count);
            Assert.False(result.Value.NodesTruncated);
            Assert.Single(result.Value.Graph.Links);
        }

        var runtime = await _fixture.OpenApplicationConnectionAsync();
        await using (runtime.ConfigureAwait(false))
        {
            var transaction = await runtime.BeginTransactionAsync(Cancellation);
            await using (transaction.ConfigureAwait(false))
            {
                await RawSql.ExecuteAsync(runtime, transaction,
                    $"SELECT set_config('nix.tenant_id', '{M0SchemaSeed.Alpha.TenantId:D}', true), "
                    + $"set_config('nix.principal_id', '{Member:D}', true)");
#pragma warning disable CA2100 // Justification: the production-owned graph statement; input reaches it only as bound parameters.
                var command = new NpgsqlCommand("EXPLAIN (ANALYZE, BUFFERS) " + GraphSql.WorkspaceGraph,
                    runtime, transaction);
#pragma warning restore CA2100
                await using (command.ConfigureAwait(false))
                {
                    command.Parameters.Add(new NpgsqlParameter("tenant_id", NpgsqlDbType.Uuid) { Value = M0SchemaSeed.Alpha.TenantId });
                    command.Parameters.Add(new NpgsqlParameter("workspace_id", NpgsqlDbType.Uuid) { Value = OpenWorkspace.Value });
                    command.Parameters.Add(new NpgsqlParameter("workspace_ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = new[] { OpenWorkspace.Value } });
                    command.Parameters.Add(new NpgsqlParameter("lock_ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = Array.Empty<Guid>() });
                    command.Parameters.Add(new NpgsqlParameter("closed_lock_ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = Array.Empty<Guid>() });
                    command.Parameters.Add(new NpgsqlParameter("node_limit", NpgsqlDbType.Integer) { Value = GetWorkspaceGraphHandler.MaximumNodes + 1 });
                    command.Parameters.Add(new NpgsqlParameter("link_limit", NpgsqlDbType.Integer) { Value = GetWorkspaceGraphHandler.MaximumLinks + 1 });
                    var reader = await command.ExecuteReaderAsync(Cancellation);
                    await using (reader.ConfigureAwait(false))
                    {
                        while (await reader.ReadAsync(Cancellation))
                        {
                            _output.WriteLine(reader.GetString(0));
                        }
                    }
                }
            }
        }
    }

    [Fact]
    public async Task The_graph_of_a_workspace_the_caller_may_not_read_is_reported_as_not_found()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>()
                .QueryAsync<GetWorkspaceGraph, Result<WorkspaceGraphResults>>(
                    new GetWorkspaceGraph(WorkspaceId.From(PrivateWorkspace)),
                    Cancellation);

            // Not an empty graph, which for a workspace identifier somebody guessed is still a
            // statement about a workspace they may not see.
            Assert.True(result.IsFailure);
            Assert.Equal("workspaces.not_found", result.Error.Code);
        }
    }

    [Fact]
    public async Task A_principal_who_is_a_member_of_nothing_draws_nothing()
    {
        // The seeded Beta principal, asking inside Alpha's tenant.
        var context = TestTenants.ContextFor(
            M0SchemaSeed.Alpha.TenantId,
            M0SchemaSeed.Alpha.WorkspaceId,
            M0SchemaSeed.Beta.PrincipalId);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>()
                .QueryAsync<GetWorkspaceGraph, Result<WorkspaceGraphResults>>(
                    new GetWorkspaceGraph(OpenWorkspace),
                    Cancellation);

            Assert.True(result.IsFailure);
            Assert.Equal("workspaces.not_found", result.Error.Code);
        }
    }

    [Fact]
    public async Task One_tenant_never_draws_another_tenant_s_workspace()
    {
        // The permission resolver is deliberately bypassed here: the reader is handed Beta's
        // workspace as though the caller were entitled to it, inside a session established for
        // Alpha. Nothing but row-level security is left to refuse it, which is the point - the two
        // controls are independent, and this asserts the second one alone.
        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var beta = WorkspaceId.From(M0SchemaSeed.Beta.WorkspaceId);

            var graph = await work.Resolve<IWorkspaceGraph>().ReadAsync(
                beta,
                [beta],
                GetWorkspaceGraphHandler.MaximumNodes,
                GetWorkspaceGraphHandler.MaximumLinks,
                Cancellation);

            Assert.Empty(graph.Nodes);
            Assert.Empty(graph.Links);
        }
    }

    [Fact]
    public async Task The_other_tenant_still_draws_its_own_workspace()
    {
        // The mirror of the test above, so an empty answer there cannot be an empty database here.
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.BetaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>()
                .QueryAsync<GetWorkspaceGraph, Result<WorkspaceGraphResults>>(
                    new GetWorkspaceGraph(WorkspaceId.From(M0SchemaSeed.Beta.WorkspaceId)),
                    Cancellation);

            Assert.True(result.IsSuccess);

            var node = Assert.Single(result.Value.Graph.Nodes);
            Assert.Equal(ItemId.From(M0SchemaSeed.Beta.ItemId), node.Id);
        }
    }

    [Fact]
    public async Task A_node_whose_parent_fell_outside_the_ceiling_is_drawn_without_one()
    {
        // Nodes enter by the workspace's own sibling order, and the parent here is sequenced last
        // on purpose, so a ceiling of three admits the child and excludes its parent. A parent
        // identifier the payload cannot resolve is an edge into nothing.
        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var graph = await work.Resolve<IWorkspaceGraph>().ReadAsync(
                OpenWorkspace,
                [OpenWorkspace],
                nodeLimit: 3,
                linkLimit: GetWorkspaceGraphHandler.MaximumLinks,
                Cancellation);

            Assert.Equal(3, graph.Nodes.Count);
            Assert.DoesNotContain(graph.Nodes, node => node.Id == ItemId.From(VisibleRoot));

            var child = graph.Nodes.Single(node => node.Id == ItemId.From(VisibleChild));
            Assert.Null(child.ParentId);
        }
    }

    [Fact]
    public async Task An_edge_whose_end_fell_outside_the_ceiling_is_not_drawn()
    {
        // Truncation must produce a smaller graph, never a broken one. The one surviving edge here
        // has an end that the node ceiling cut, so it goes with it.
        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var graph = await work.Resolve<IWorkspaceGraph>().ReadAsync(
                OpenWorkspace,
                [OpenWorkspace],
                nodeLimit: 2,
                linkLimit: GetWorkspaceGraphHandler.MaximumLinks,
                Cancellation);

            Assert.Equal(2, graph.Nodes.Count);
            Assert.Empty(graph.Links);
        }
    }

    [Fact]
    public async Task A_reader_given_no_readable_workspaces_returns_nothing()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var graph = await work.Resolve<IWorkspaceGraph>().ReadAsync(
                OpenWorkspace,
                [],
                GetWorkspaceGraphHandler.MaximumNodes,
                GetWorkspaceGraphHandler.MaximumLinks,
                Cancellation);

            Assert.Empty(graph.Nodes);
            Assert.Empty(graph.Links);
        }
    }

    [Fact]
    public async Task A_graph_read_inside_its_ceilings_does_not_claim_to_be_truncated()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>()
                .QueryAsync<GetWorkspaceGraph, Result<WorkspaceGraphResults>>(
                    new GetWorkspaceGraph(OpenWorkspace),
                    Cancellation);

            Assert.True(result.IsSuccess);
            Assert.False(result.Value.NodesTruncated);
            Assert.False(result.Value.LinksTruncated);
            Assert.Equal(GetWorkspaceGraphHandler.MaximumNodes, result.Value.NodeLimit);
            Assert.Equal(GetWorkspaceGraphHandler.MaximumLinks, result.Value.LinkLimit);
        }
    }

    private async Task<WorkspaceGraph> ReadGraphAsync(WorkspaceId workspaceId, Guid? credential = null)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            if (credential is { } id)
            {
                work.Resolve<CredentialSessionContext>().Set(id);
            }

            var result = await work.Resolve<NixDispatcher>()
                .QueryAsync<GetWorkspaceGraph, Result<WorkspaceGraphResults>>(
                    new GetWorkspaceGraph(workspaceId),
                    Cancellation);

            Assert.True(result.IsSuccess);
            return result.Value.Graph;
        }
    }

    private async Task AddLockedBodyEdgesAsync()
    {
        var sql = $"""
            INSERT INTO item_link (tenant_id, source_item_id, target_item_id, occurrences, seq)
            VALUES
                ({Literal(M0SchemaSeed.Alpha.TenantId)}, {Literal(VisibleRoot)}, {Literal(VisibleSource)}, 1, 1),
                ({Literal(M0SchemaSeed.Alpha.TenantId)}, {Literal(VisibleChild)}, {Literal(VisibleSource)}, 1, 1);
            """;
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }

    /// <summary>Locks <see cref="VisibleRoot"/>, with an open grant for one credential.</summary>
    private async Task LockVisibleRootAsync(Guid grantedTo)
    {
        var tenant = Literal(M0SchemaSeed.Alpha.TenantId);
        var principal = Literal(M0SchemaSeed.Alpha.PrincipalId);
        var root = Literal(VisibleRoot);
        var sql = $"""
            INSERT INTO item_lock (item_id, tenant_id, password_hash, locked_by, locked_at)
            VALUES ({root}, {tenant},
                    'pbkdf2-sha256$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
                    {principal}, now());
            INSERT INTO item_unlock (item_id, credential_id, tenant_id, principal_id, expires_at)
            VALUES ({root}, {Literal(grantedTo)}, {tenant}, {principal}, now() + interval '10 minutes');
            """;
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }

    /// <summary>
    /// Seeds two workspaces' worth of items and the edges between them.
    /// </summary>
    /// <remarks>
    /// Written as the migrator because Core holds <c>SELECT</c> on <c>item_link</c> and could not
    /// write these rows if it tried - which is the property under test elsewhere, and here is
    /// simply the reason the fixture cannot go through the application.
    /// </remarks>
    private async Task SeedGraphAsync()
    {
        var tenant = Literal(M0SchemaSeed.Alpha.TenantId);
        var openWorkspace = Literal(M0SchemaSeed.Alpha.WorkspaceId);
        var closedWorkspace = Literal(PrivateWorkspace);
        var principal = Literal(M0SchemaSeed.Alpha.PrincipalId);

        var sql = $$"""
            INSERT INTO principal
                (principal_id, tenant_id, external_subject, kind, display_name, email, status,
                 deprovisioned_at)
            VALUES ({{Literal(Member)}}, {{tenant}}, 'alpha-graph-member', 'user', 'Member',
                    'graph-member@example.test', 'active', NULL);

            INSERT INTO workspace_member
                (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            VALUES ({{openWorkspace}}, 'principal', {{Literal(Member)}}, {{tenant}}, 'viewer',
                    {{principal}}, now());

            INSERT INTO workspace
                (workspace_id, tenant_id, name, version_retention_days, coalesce_window_min,
                 storage_quota_bytes, created_at)
            VALUES ({{closedWorkspace}}, {{tenant}}, 'Alpha private', 30, 10, 1073741824, now());

            -- The root is sequenced last deliberately, so a low ceiling admits its child and cuts
            -- the parent. That is the case the parent self-join exists for.
            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                 purge_after, created_by, last_modified_by, created_at, last_modified_at)
            VALUES
                ({{Literal(VisibleSource)}}, {{tenant}}, {{openWorkspace}}, 'note', NULL, 2000,
                 '{"title": "Quarterly notes"}'::jsonb, 'active', NULL, {{principal}}, {{principal}},
                 now(), now()),
                ({{Literal(VisibleRoot)}}, {{tenant}}, {{openWorkspace}}, 'note', NULL, 5000,
                 '{"title": "Programme"}'::jsonb, 'active', NULL, {{principal}}, {{principal}},
                 now(), now()),
                ({{Literal(VisibleChild)}}, {{tenant}}, {{openWorkspace}}, 'note',
                 {{Literal(VisibleRoot)}}, 3000, '{"title": "Ledger review"}'::jsonb, 'active', NULL,
                 {{principal}}, {{principal}}, now(), now()),
                ({{Literal(PrivateItem)}}, {{tenant}}, {{closedWorkspace}}, 'note', NULL, 4000,
                 '{"title": "Confidential ledger"}'::jsonb, 'active', NULL, {{principal}},
                 {{principal}}, now(), now());

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            VALUES
                ({{Literal(VisibleSource)}}, {{Literal(VisibleSource)}}, {{tenant}}, {{openWorkspace}}, 0),
                ({{Literal(VisibleRoot)}}, {{Literal(VisibleRoot)}}, {{tenant}}, {{openWorkspace}}, 0),
                ({{Literal(VisibleChild)}}, {{Literal(VisibleChild)}}, {{tenant}}, {{openWorkspace}}, 0),
                ({{Literal(VisibleChild)}}, {{Literal(VisibleRoot)}}, {{tenant}}, {{openWorkspace}}, 1),
                ({{Literal(PrivateItem)}}, {{Literal(PrivateItem)}}, {{tenant}}, {{closedWorkspace}}, 0);

            -- The shared seed gives every tenant's item a link to itself, which is a plausible row
            -- for a links table and meaningless as an edge in a drawing. Removed here so the edges
            -- these tests assert on are the edges these tests seeded, and a count is readable.
            DELETE FROM item_link
             WHERE tenant_id = {{tenant}}
               AND source_item_id = target_item_id;

            -- One edge between two readable items, and one in each direction touching the item this
            -- caller may not read.
            INSERT INTO item_link (tenant_id, source_item_id, target_item_id, occurrences, seq)
            VALUES
                ({{tenant}}, {{Literal(VisibleSource)}}, {{Literal(VisibleChild)}}, 3, 1),
                ({{tenant}}, {{Literal(VisibleSource)}}, {{Literal(PrivateItem)}}, 1, 1),
                ({{tenant}}, {{Literal(PrivateItem)}}, {{Literal(VisibleChild)}}, 1, 1);
            """;

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }

    private async Task MarkCalendarItemsAsync(string provider, bool readOnly, bool managed)
    {
        var properties = new System.Text.Json.Nodes.JsonObject
        {
            [ItemProperties.CalendarSourceKey] = provider,
            [ItemProperties.CalendarReadOnlyKey] = readOnly,
        };
        var sql = $$"""
            UPDATE item
               SET properties = properties || '{{properties.ToJsonString()}}'::jsonb,
                   managed_by = {{(managed ? "'calendar_event'" : "NULL")}},
                   no_delete = {{(managed ? "true" : "false")}}
             WHERE id = {{Literal(VisibleSource)}};
            UPDATE item SET managed_by = 'calendar', no_delete = true
             WHERE id = {{Literal(VisibleRoot)}};
            UPDATE item
               SET properties = properties || '{"start":"2026-10-08T09:00:00Z"}'::jsonb,
                   managed_by = 'calendar_event', no_delete = true
             WHERE id = {{Literal(VisibleChild)}};
            INSERT INTO item_link (tenant_id, source_item_id, target_item_id, occurrences, seq)
            VALUES ({{Literal(M0SchemaSeed.Alpha.TenantId)}}, {{Literal(VisibleChild)}},
                    {{Literal(VisibleSource)}}, 1, 1);
            """;
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }

    private async Task SetLifecycleAsync(Guid itemId, string lifecycle)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $"UPDATE item SET lifecycle_state = '{lifecycle}' WHERE id = {Literal(itemId)};");
        }
    }

    private async Task SetSequenceAsync(Guid itemId, long sequence)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $"UPDATE item SET seq = {sequence.ToString(CultureInfo.InvariantCulture)} WHERE id = {Literal(itemId)};");
        }
    }

    private static string Literal(Guid value) =>
        $"'{value.ToString("D", CultureInfo.InvariantCulture)}'::uuid";
}
