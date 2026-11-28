using System.Globalization;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Domain.Views;
using Nix.Features.Query;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// A saved query returns only what the acting principal may read, filtered inside the statement,
/// and its operators mean on real Postgres what they claim to mean.
/// </summary>
/// <remarks>
/// <para>
/// This is the product's first server-side filter over property values and its second-widest read
/// after the graph: one request, and back come rows from every container at once. The crown-jewel
/// assertions are the graph suite's, re-made here: another tenant's matches never return, another
/// workspace's matches in the same tenant never return (the case row-level security cannot catch),
/// and the ceiling is spent only on readable rows - a limit spent on refused rows would make a
/// full list come back looking empty.
/// </para>
/// <para>
/// The operator semantics need real Postgres because they are claims about Postgres: that a
/// bracketed-zone timestamp survives <c>left(value, 10)</c> where a cast would throw, and that
/// <c>IS DISTINCT FROM</c> matches an item that never had the property at all.
/// </para>
/// </remarks>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class ItemQueryAuthorizationTests : IAsyncLifetime
{
    private const string TodayText = "2026-08-15";
    private static readonly DateOnly Today = new(2026, 8, 15);

    /// <summary>A second workspace in Alpha's tenant, which the acting principal is not a member of.</summary>
    private static readonly Guid PrivateWorkspace = new("7b7b7000-1111-4111-8111-7b7b70000000");

    /// <summary>The smart list itself: holds the Overdue query view, and never lists itself.</summary>
    private static readonly Guid SmartList = new("7b7b7000-1111-4111-8111-7b7b70000001");

    /// <summary>Due five days ago, never marked done. The archetypal overdue row.</summary>
    private static readonly Guid Overdue = new("7b7b7000-1111-4111-8111-7b7b70000002");

    /// <summary>Due two weeks ago and done - the rule the not-equals arm exists for.</summary>
    private static readonly Guid DoneOverdue = new("7b7b7000-1111-4111-8111-7b7b70000003");

    /// <summary>Due in five days.</summary>
    private static readonly Guid Future = new("7b7b7000-1111-4111-8111-7b7b70000004");

    /// <summary>Due today.</summary>
    private static readonly Guid DueToday = new("7b7b7000-1111-4111-8111-7b7b70000005");

    /// <summary>Overdue by its day, stored as an RFC 9557 timestamp with a bracketed zone.</summary>
    private static readonly Guid ZonedOverdue = new("7b7b7000-1111-4111-8111-7b7b70000006");

    /// <summary>Due on the last day of a seven-day window from today.</summary>
    private static readonly Guid WindowEdge = new("7b7b7000-1111-4111-8111-7b7b70000007");

    /// <summary>Due one day past that window.</summary>
    private static readonly Guid PastWindow = new("7b7b7000-1111-4111-8111-7b7b70000008");

    /// <summary>Overdue, but deleted - lifecycle keeps it out.</summary>
    private static readonly Guid DeletedOverdue = new("7b7b7000-1111-4111-8111-7b7b70000009");

    /// <summary>Three overdue matches in the workspace the caller may not read.</summary>
    private static readonly Guid PrivateA = new("7b7b7000-1111-4111-8111-7b7b7000000a");
    private static readonly Guid PrivateB = new("7b7b7000-1111-4111-8111-7b7b7000000b");
    private static readonly Guid PrivateC = new("7b7b7000-1111-4111-8111-7b7b7000000c");

    /// <summary>A member of the open workspace and of nothing else - not the tenant administrator.</summary>
    private static readonly Guid Member = new("7b7b7000-1111-4111-8111-7b7b7000000d");

    /// <summary>The container the dated items live in, so rows carry a container title.</summary>
    private static readonly Guid Tracker = new("7b7b7000-1111-4111-8111-7b7b7000000e");

    /// <summary>An overdue match in the other tenant entirely.</summary>
    private static readonly Guid BetaOverdue = new("7b7b7000-2222-4222-8222-7b7b7000000f");

    private readonly NixPostgresFixture _fixture;

    public ItemQueryAuthorizationTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static NixSessionContext MemberContext => TestTenants.ContextFor(
        M0SchemaSeed.Alpha.TenantId,
        M0SchemaSeed.Alpha.WorkspaceId,
        Member);

    private static WorkspaceId OpenWorkspace => WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId);

    private static readonly Nix.Domain.Views.FilterRule[] OverdueRules =
    [
        new("due", "before", "today"),
        new("done", "not-equals", "true"),
    ];

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        await SeedQueryCorpusAsync();
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task The_overdue_query_matches_the_undone_past_due_rows_and_nothing_else()
    {
        var results = await RunAsync(OverdueRules, limit: RunItemQueryHandler.MaximumResults);

        // Overdue and ZonedOverdue share the day 2026-08-10, so the id is the tie-break (Overdue's
        // sorts first); DoneOverdue is out by its done flag whatever its date, Future and DueToday
        // by their dates, DeletedOverdue by lifecycle, and the smart list itself by construction -
        // its own `due` is before today precisely so this test would catch it listing itself.
        Assert.Equal(
            [ItemId.From(Overdue), ItemId.From(ZonedOverdue)],
            results.Items.Select(item => item.Id).ToArray());
        Assert.False(results.Truncated);
    }

    [Fact]
    public async Task An_item_that_never_had_the_property_counts_as_not_equal()
    {
        // Overdue has no `done` key at all. IS DISTINCT FROM is what admits it; a plain <> would
        // silently drop every item nobody ever marked, which is most of an overdue list.
        var results = await RunAsync(OverdueRules, limit: RunItemQueryHandler.MaximumResults);

        Assert.Contains(results.Items, item => item.Id == ItemId.From(Overdue));
    }

    [Fact]
    public async Task A_bracketed_zone_timestamp_is_compared_by_its_day_rather_than_throwing()
    {
        // The value is `2026-08-10T09:00:00+00:00[Europe/London]`. A timestamptz cast would throw
        // on the suffix; left(value, 10) reads its day.
        var results = await RunAsync(OverdueRules, limit: RunItemQueryHandler.MaximumResults);

        Assert.Contains(results.Items, item => item.Id == ItemId.From(ZonedOverdue));
    }

    [Fact]
    public async Task Within_next_includes_today_and_the_window_edge_and_not_the_day_past_it()
    {
        var results = await RunAsync(
            [new("due", "within-next", "7")],
            limit: RunItemQueryHandler.MaximumResults);

        Assert.Equal(
            new HashSet<ItemId>
            {
                ItemId.From(DueToday),
                ItemId.From(Future),
                ItemId.From(WindowEdge),
            },
            results.Items.Select(item => item.Id).ToHashSet());
        Assert.DoesNotContain(results.Items, item => item.Id == ItemId.From(PastWindow));
    }

    [Fact]
    public async Task Rows_in_a_workspace_the_caller_may_not_read_never_return_and_never_spend_the_limit()
    {
        // Three private matches exist beside two readable ones. With the ceiling at exactly the
        // readable count, both readable rows return untruncated: a filter applied after the limit
        // would have spent it on rows the caller may not see and come back short.
        var results = await RunAsync(OverdueRules, limit: 2);

        Assert.Equal(2, results.Items.Count);
        Assert.False(results.Truncated);
        Assert.DoesNotContain(
            results.Items,
            item => item.Id == ItemId.From(PrivateA)
                || item.Id == ItemId.From(PrivateB)
                || item.Id == ItemId.From(PrivateC));
    }

    [Fact]
    public async Task An_active_match_below_a_deleted_ancestor_is_excluded_before_ordering_and_limit()
    {
        await HideBelowDeletedItemAsync(Overdue, DeletedOverdue);

        var results = await RunAsync(OverdueRules, limit: 1);

        var item = Assert.Single(results.Items);
        Assert.Equal(ItemId.From(ZonedOverdue), item.Id);
        Assert.False(results.Truncated);
    }

    [Fact]
    public async Task Another_tenant_s_matches_never_return()
    {
        var results = await RunAsync(OverdueRules, limit: RunItemQueryHandler.MaximumResults);

        Assert.DoesNotContain(results.Items, item => item.Id == ItemId.From(BetaOverdue));
    }

    [Fact]
    public async Task A_reader_handed_another_tenant_s_workspace_still_returns_nothing()
    {
        // The permission resolver is deliberately bypassed: the reader is given Beta's workspace
        // as though the caller were entitled to it, inside a session established for Alpha.
        // Nothing but row-level security is left to refuse it - the two controls are independent,
        // and this asserts the second one alone.
        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var results = await work.Resolve<IItemQuery>().RunAsync(
                ItemId.From(SmartList),
                [.. OverdueRules],
                new QueryOrder("due", IsDay: true, Descending: false),
                Today,
                [WorkspaceId.From(M0SchemaSeed.Beta.WorkspaceId)],
                RunItemQueryHandler.MaximumResults,
                Cancellation);

            Assert.Empty(results.Items);
        }
    }

    [Fact]
    public async Task The_same_read_twice_returns_the_same_rows_in_the_same_order()
    {
        var first = await RunAsync(OverdueRules, limit: RunItemQueryHandler.MaximumResults);
        var second = await RunAsync(OverdueRules, limit: RunItemQueryHandler.MaximumResults);

        Assert.Equal(
            first.Items.Select(item => item.Id).ToArray(),
            second.Items.Select(item => item.Id).ToArray());
    }

    [Fact]
    public async Task A_read_past_the_ceiling_says_so_and_a_read_at_it_does_not()
    {
        var cut = await RunAsync(OverdueRules, limit: 1);
        Assert.Single(cut.Items);
        Assert.True(cut.Truncated);

        var exact = await RunAsync(OverdueRules, limit: 2);
        Assert.Equal(2, exact.Items.Count);
        Assert.False(exact.Truncated);
    }

    [Fact]
    public async Task The_whole_path_runs_from_the_stored_view_and_carries_the_container_title()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>()
                .QueryAsync<RunItemQuery, Result<ItemQueryResults>>(
                    new RunItemQuery(ItemId.From(SmartList), "overdue", TodayText),
                    Cancellation);

            Assert.True(result.IsSuccess);

            var run = result.Value;
            Assert.Equal(2, run.Results.Items.Count);
            Assert.All(run.Results.Items, item => Assert.Equal("Tracker", item.ContainerTitle));
            Assert.DoesNotContain(run.Results.Items, item => item.Id == ItemId.From(SmartList));
        }
    }

    private async Task<Nix.Domain.Query.QueryResults> RunAsync(
        Nix.Domain.Views.FilterRule[] rules,
        int limit)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            return await work.Resolve<IItemQuery>().RunAsync(
                ItemId.From(SmartList),
                [.. rules],
                new QueryOrder("due", IsDay: true, Descending: false),
                Today,
                [OpenWorkspace],
                limit,
                Cancellation);
        }
    }

    private async Task SeedQueryCorpusAsync()
    {
        var tenant = RawSql.Literal(M0SchemaSeed.Alpha.TenantId);
        var beta = RawSql.Literal(M0SchemaSeed.Beta.TenantId);
        var openWorkspace = RawSql.Literal(M0SchemaSeed.Alpha.WorkspaceId);
        var betaWorkspace = RawSql.Literal(M0SchemaSeed.Beta.WorkspaceId);
        var closedWorkspace = RawSql.Literal(PrivateWorkspace);
        var principal = RawSql.Literal(M0SchemaSeed.Alpha.PrincipalId);
        var betaPrincipal = RawSql.Literal(M0SchemaSeed.Beta.PrincipalId);

        var sql = $$"""
            INSERT INTO principal
                (principal_id, tenant_id, external_subject, kind, display_name, email, status,
                 deprovisioned_at)
            VALUES ({{RawSql.Literal(Member)}}, {{tenant}}, 'alpha-query-member', 'user', 'Member',
                    'query-member@example.test', 'active', NULL);

            INSERT INTO workspace_member
                (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            VALUES ({{openWorkspace}}, 'principal', {{RawSql.Literal(Member)}}, {{tenant}}, 'viewer',
                    {{principal}}, now());

            INSERT INTO workspace
                (workspace_id, tenant_id, name, version_retention_days, coalesce_window_min,
                 storage_quota_bytes, created_at)
            VALUES ({{closedWorkspace}}, {{tenant}}, 'Alpha private', 30, 10, 1073741824, now());

            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties, views,
                 lifecycle_state, purge_after, created_by, last_modified_by, created_at,
                 last_modified_at)
            VALUES
                ({{RawSql.Literal(SmartList)}}, {{tenant}}, {{openWorkspace}}, 'query', NULL, 1000,
                 '{"title": "Overdue things", "due": "2026-01-01"}'::jsonb,
                 '{"views":[{"id":"overdue","name":"Overdue","kind":"query","sortDescending":false,
                   "filters":[{"property":"due","operator":"before","value":"today"},
                              {"property":"done","operator":"not-equals","value":"true"}]}],
                   "default":"overdue"}'::jsonb,
                 'active', NULL, {{principal}}, {{principal}}, now(), now()),
                ({{RawSql.Literal(Tracker)}}, {{tenant}}, {{openWorkspace}}, 'note', NULL, 2000,
                 '{"title": "Tracker"}'::jsonb, NULL,
                 'active', NULL, {{principal}}, {{principal}}, now(), now()),
                ({{RawSql.Literal(Overdue)}}, {{tenant}}, {{openWorkspace}}, 'note', {{RawSql.Literal(Tracker)}},
                 3000, '{"title": "Water plants", "due": "2026-08-10"}'::jsonb, NULL,
                 'active', NULL, {{principal}}, {{principal}}, now(), now()),
                ({{RawSql.Literal(DoneOverdue)}}, {{tenant}}, {{openWorkspace}}, 'note',
                 {{RawSql.Literal(Tracker)}}, 4000,
                 '{"title": "Ship invoice", "due": "2026-08-01", "done": true}'::jsonb, NULL,
                 'active', NULL, {{principal}}, {{principal}}, now(), now()),
                ({{RawSql.Literal(Future)}}, {{tenant}}, {{openWorkspace}}, 'note', {{RawSql.Literal(Tracker)}},
                 5000, '{"title": "Order filament", "due": "2026-08-20"}'::jsonb, NULL,
                 'active', NULL, {{principal}}, {{principal}}, now(), now()),
                ({{RawSql.Literal(DueToday)}}, {{tenant}}, {{openWorkspace}}, 'note', {{RawSql.Literal(Tracker)}},
                 6000, '{"title": "Stand-up notes", "due": "2026-08-15"}'::jsonb, NULL,
                 'active', NULL, {{principal}}, {{principal}}, now(), now()),
                ({{RawSql.Literal(ZonedOverdue)}}, {{tenant}}, {{openWorkspace}}, 'note',
                 {{RawSql.Literal(Tracker)}}, 7000,
                 '{"title": "Zoned call", "due": "2026-08-10T09:00:00+00:00[Europe/London]"}'::jsonb,
                 NULL, 'active', NULL, {{principal}}, {{principal}}, now(), now()),
                ({{RawSql.Literal(WindowEdge)}}, {{tenant}}, {{openWorkspace}}, 'note',
                 {{RawSql.Literal(Tracker)}}, 8000,
                 '{"title": "Window edge", "due": "2026-08-22"}'::jsonb, NULL,
                 'active', NULL, {{principal}}, {{principal}}, now(), now()),
                ({{RawSql.Literal(PastWindow)}}, {{tenant}}, {{openWorkspace}}, 'note',
                 {{RawSql.Literal(Tracker)}}, 9000,
                 '{"title": "Past window", "due": "2026-08-23"}'::jsonb, NULL,
                 'active', NULL, {{principal}}, {{principal}}, now(), now()),
                ({{RawSql.Literal(DeletedOverdue)}}, {{tenant}}, {{openWorkspace}}, 'note',
                 {{RawSql.Literal(Tracker)}}, 10000,
                 '{"title": "Old chore", "due": "2026-08-02"}'::jsonb, NULL,
                 'deleted', NULL, {{principal}}, {{principal}}, now(), now()),
                ({{RawSql.Literal(PrivateA)}}, {{tenant}}, {{closedWorkspace}}, 'note', NULL, 11000,
                 '{"title": "Private a", "due": "2026-08-01"}'::jsonb, NULL,
                 'active', NULL, {{principal}}, {{principal}}, now(), now()),
                ({{RawSql.Literal(PrivateB)}}, {{tenant}}, {{closedWorkspace}}, 'note', NULL, 12000,
                 '{"title": "Private b", "due": "2026-08-02"}'::jsonb, NULL,
                 'active', NULL, {{principal}}, {{principal}}, now(), now()),
                ({{RawSql.Literal(PrivateC)}}, {{tenant}}, {{closedWorkspace}}, 'note', NULL, 13000,
                 '{"title": "Private c", "due": "2026-08-03"}'::jsonb, NULL,
                 'active', NULL, {{principal}}, {{principal}}, now(), now()),
                ({{RawSql.Literal(BetaOverdue)}}, {{beta}}, {{betaWorkspace}}, 'note', NULL, 14000,
                 '{"title": "Beta overdue", "due": "2026-08-01"}'::jsonb, NULL,
                 'active', NULL, {{betaPrincipal}}, {{betaPrincipal}}, now(), now());

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT id, id, tenant_id, workspace_id, 0 FROM item
             WHERE id IN ({{RawSql.Literal(SmartList)}}, {{RawSql.Literal(Tracker)}}, {{RawSql.Literal(Overdue)}},
                          {{RawSql.Literal(DoneOverdue)}}, {{RawSql.Literal(Future)}}, {{RawSql.Literal(DueToday)}},
                          {{RawSql.Literal(ZonedOverdue)}}, {{RawSql.Literal(WindowEdge)}},
                          {{RawSql.Literal(PastWindow)}}, {{RawSql.Literal(DeletedOverdue)}},
                          {{RawSql.Literal(PrivateA)}}, {{RawSql.Literal(PrivateB)}}, {{RawSql.Literal(PrivateC)}},
                          {{RawSql.Literal(BetaOverdue)}});

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            SELECT id, {{RawSql.Literal(Tracker)}}, tenant_id, workspace_id, 1 FROM item
             WHERE parent_id = {{RawSql.Literal(Tracker)}};
            """;

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }

    private async Task HideBelowDeletedItemAsync(Guid itemId, Guid deletedAncestorId)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(
                connection,
                transaction: null,
                $$"""
                  DELETE FROM item_closure
                   WHERE descendant_id = {{RawSql.Literal(itemId)}}
                     AND depth > 0;

                  UPDATE item
                     SET parent_id = {{RawSql.Literal(deletedAncestorId)}}
                   WHERE id = {{RawSql.Literal(itemId)}};

                  INSERT INTO item_closure
                      (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
                  VALUES
                      ({{RawSql.Literal(itemId)}}, {{RawSql.Literal(deletedAncestorId)}},
                       {{RawSql.Literal(M0SchemaSeed.Alpha.TenantId)}},
                       {{RawSql.Literal(M0SchemaSeed.Alpha.WorkspaceId)}}, 1);
                  """);
        }
    }
}
