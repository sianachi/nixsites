using System.Globalization;
using Nix.Abstractions;
using Nix.Domain.Calendar;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.Calendar;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The collated calendar returns only what the acting principal may read, and the filtering happens
/// inside the query rather than after it.
/// </summary>
/// <remarks>
/// <para>
/// The second-widest read in the product, and it discloses something the graph does not: when
/// things are happening. Every other item read starts from an identifier the caller already holds,
/// so nothing they supply bounds this one. A permission filter one step too late surfaces here as a
/// month that looks empty, and an empty month is indistinguishable from a quiet one.
/// </para>
/// <para>
/// Two tenants, and inside one tenant two workspaces. The second workspace is the interesting one:
/// row-level security has nothing to say about it - both belong to the same tenant, so every row is
/// visible to the policy - and only the permission predicate keeps it out of the answer. The
/// cross-tenant case is the backstop, asserted by handing the reader a readable set it has no
/// business being given and finding the policy still returns nothing.
/// </para>
/// </remarks>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class WorkspaceCalendarAuthorizationTests : IAsyncLifetime
{
    /// <summary>A second workspace in Alpha's tenant, which the acting principal is not a member of.</summary>
    private static readonly Guid PrivateWorkspace = new("7b5b5000-2222-4222-8222-7b5b50000001");

    /// <summary>A container placing its children on a property it calls <c>due</c>.</summary>
    private static readonly Guid DueContainer = new("7b5b5000-2222-4222-8222-7b5b50000002");

    /// <summary>A container placing its children on a differently named property, <c>starts</c>.</summary>
    private static readonly Guid StartsContainer = new("7b5b5000-2222-4222-8222-7b5b50000003");

    /// <summary>A container offering a calendar that names no property to place by.</summary>
    private static readonly Guid UnplaceableContainer = new("7b5b5000-2222-4222-8222-7b5b50000004");

    /// <summary>A container offering two calendars, on different properties.</summary>
    private static readonly Guid TwiceContainer = new("7b5b5000-2222-4222-8222-7b5b50000005");

    /// <summary>An all-day item inside <see cref="DueContainer"/>.</summary>
    private static readonly Guid AllDay = new("7b5b5000-2222-4222-8222-7b5b50000006");

    /// <summary>A zoned moment inside <see cref="StartsContainer"/>.</summary>
    private static readonly Guid Moment = new("7b5b5000-2222-4222-8222-7b5b50000007");

    /// <summary>An item dated outside every window these tests ask for.</summary>
    private static readonly Guid FarFuture = new("7b5b5000-2222-4222-8222-7b5b50000008");

    /// <summary>A dated item in the workspace the acting principal is not a member of.</summary>
    private static readonly Guid PrivateDated = new("7b5b5000-2222-4222-8222-7b5b50000009");

    /// <summary>The item inside <see cref="TwiceContainer"/>, carrying both properties.</summary>
    private static readonly Guid Twice = new("7b5b5000-2222-4222-8222-7b5b5000000a");

    /// <summary>A child of a container whose calendar names a property this child does not carry.</summary>
    private static readonly Guid Undated = new("7b5b5000-2222-4222-8222-7b5b5000000b");

    /// <summary>
    /// A member of the open workspace and of nothing else.
    /// </summary>
    /// <remarks>
    /// Not the seeded Alpha principal, who is a tenant administrator and therefore reaches every
    /// workspace in the tenant by design - which would make every assertion below pass for the
    /// wrong reason.
    /// </remarks>
    private static readonly Guid Member = new("7b5b5000-2222-4222-8222-7b5b5000000c");

    /// <summary>A no-view ancestor used only to exercise derived container visibility.</summary>
    private static readonly Guid DeletedAncestor = new("7b5b5000-2222-4222-8222-7b5b5000000d");

    private readonly NixPostgresFixture _fixture;

    public WorkspaceCalendarAuthorizationTests(NixPostgresFixture fixture) => _fixture = fixture;

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
        await SeedCalendarsAsync();
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task A_date_is_a_date_wherever_it_was_set()
    {
        // The whole point of collating. Two containers place their children on differently named
        // properties, and both arrive in one answer carrying the key each was placed by - which is
        // what lets a client show them together without deciding one of them was wrong.
        var calendar = await ReadAsync("2026-03-01", "2026-03-31");

        var allDay = calendar.Entries.Single(entry => entry.ItemId == ItemId.From(AllDay));
        var moment = calendar.Entries.Single(entry => entry.ItemId == ItemId.From(Moment));

        Assert.Equal("due", allDay.DateProperty);
        Assert.Equal("starts", moment.DateProperty);
    }

    [Fact]
    public async Task An_entry_says_which_container_placed_it()
    {
        var calendar = await ReadAsync("2026-03-01", "2026-03-31");

        var allDay = calendar.Entries.Single(entry => entry.ItemId == ItemId.From(AllDay));

        Assert.Equal(ItemId.From(DueContainer), allDay.ContainerId);
        Assert.Equal("Deadlines", allDay.ContainerTitle);
    }

    [Fact]
    public async Task A_value_comes_back_exactly_as_it_was_stored()
    {
        // Not normalised, and not converted. Only the reader's own zone decides which day a moment
        // falls on, so a server that helpfully rewrote this into UTC would be choosing a day on
        // their behalf and hiding that it had.
        var calendar = await ReadAsync("2026-03-01", "2026-03-31");

        var moment = calendar.Entries.Single(entry => entry.ItemId == ItemId.From(Moment));

        Assert.Equal("2026-03-17T09:00:00+00:00[Europe/London]", moment.Value);
        Assert.Equal(CalendarEntryKind.Timestamp, moment.Kind);
    }

    [Fact]
    public async Task An_all_day_date_is_told_apart_from_a_moment()
    {
        var calendar = await ReadAsync("2026-03-01", "2026-03-31");

        var allDay = calendar.Entries.Single(entry => entry.ItemId == ItemId.From(AllDay));

        Assert.Equal("2026-03-12", allDay.Value);
        Assert.Equal(CalendarEntryKind.Date, allDay.Kind);
    }

    [Fact]
    public async Task An_item_appears_once_even_when_its_container_offers_two_calendars()
    {
        // The container declares a calendar on `due` and another on `starts`, and the item carries
        // both. Returning it twice would put one note on two days with nothing to say which was
        // meant; the first view the container declares wins.
        var calendar = await ReadAsync("2026-03-01", "2026-03-31");

        var entry = Assert.Single(calendar.Entries, candidate => candidate.ItemId == ItemId.From(Twice));

        Assert.Equal("due", entry.DateProperty);
    }

    [Fact]
    public async Task A_container_that_offers_a_calendar_and_names_no_property_is_reported()
    {
        // Being honest about what could not be read. Passed over in silence, this container would be
        // indistinguishable from one with nothing scheduled in it, and a reader would believe the
        // second.
        var calendar = await ReadAsync("2026-03-01", "2026-03-31");

        var unplaceable = Assert.Single(calendar.Unplaceable);

        Assert.Equal(ItemId.From(UnplaceableContainer), unplaceable.ContainerId);
        Assert.Equal("Misconfigured", unplaceable.ContainerTitle);
    }

    [Fact]
    public async Task A_child_without_the_property_its_container_places_by_is_simply_absent()
    {
        // Not an error and not an explanation: an item with no date is an item nobody has scheduled,
        // which is the ordinary case rather than a fault.
        var calendar = await ReadAsync("2026-03-01", "2026-03-31");

        Assert.DoesNotContain(calendar.Entries, entry => entry.ItemId == ItemId.From(Undated));
    }

    [Fact]
    public async Task The_window_includes_both_of_its_ends()
    {
        // Asked as exactly the day the all-day item falls on, from and to the same date. An
        // exclusive bound would answer nothing here and look like an empty day.
        var calendar = await ReadAsync("2026-03-12", "2026-03-12");

        Assert.Contains(calendar.Entries, entry => entry.ItemId == ItemId.From(AllDay));
    }

    [Fact]
    public async Task The_window_excludes_what_falls_outside_it()
    {
        var calendar = await ReadAsync("2026-03-01", "2026-03-31");

        Assert.DoesNotContain(calendar.Entries, entry => entry.ItemId == ItemId.From(FarFuture));
    }

    [Fact]
    public async Task A_zoned_moment_is_windowed_by_the_day_it_is_written_with()
    {
        // The window compares the first ten characters, which is the day for both stored shapes.
        // This is the assertion that would fail if the statement ever tried to cast the value: the
        // bracketed zone is not something Postgres can parse as a timestamp.
        var calendar = await ReadAsync("2026-03-17", "2026-03-17");

        Assert.Contains(calendar.Entries, entry => entry.ItemId == ItemId.From(Moment));
    }

    [Fact]
    public async Task A_calendar_omits_an_item_the_caller_may_not_read()
    {
        // Same tenant, so row-level security lets the row through and only the permission predicate
        // stops it.
        var calendar = await ReadAsync("2026-03-01", "2026-03-31");

        Assert.DoesNotContain(calendar.Entries, entry => entry.ItemId == ItemId.From(PrivateDated));
    }

    [Fact]
    public async Task A_calendar_omits_an_active_calendar_container_below_a_deleted_ancestor()
    {
        await HideContainersBelowDeletedAncestorAsync(DueContainer, UnplaceableContainer);

        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var calendar = await work.Resolve<IWorkspaceCalendar>().ReadAsync(
                OpenWorkspace,
                [OpenWorkspace],
                "2026-03-01",
                "2026-03-31",
                entryLimit: 1,
                Cancellation);

            var entry = Assert.Single(calendar.Entries);
            Assert.Equal(ItemId.From(Moment), entry.ItemId);
            Assert.Empty(calendar.Unplaceable);
        }
    }

    [Fact]
    public async Task The_calendar_of_a_workspace_the_caller_may_not_read_is_reported_as_not_found()
    {
        var result = await QueryAsync(WorkspaceId.From(PrivateWorkspace), "2026-03-01", "2026-03-31");

        // Not an empty calendar, which for a workspace identifier somebody guessed is still a
        // statement about a workspace they may not see.
        Assert.True(result.IsFailure);
        Assert.Equal("workspaces.not_found", result.Error.Code);
    }

    [Fact]
    public async Task One_tenant_never_reads_another_tenant_s_calendar()
    {
        // The permission resolver is deliberately bypassed: the reader is handed Beta's workspace as
        // though the caller were entitled to it, inside a session established for Alpha. Nothing but
        // row-level security is left to refuse it, which is the point - the two controls are
        // independent, and this asserts the second one alone.
        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var beta = WorkspaceId.From(M0SchemaSeed.Beta.WorkspaceId);

            var calendar = await work.Resolve<IWorkspaceCalendar>().ReadAsync(
                beta,
                [beta],
                "2000-01-01",
                "2099-12-31",
                GetWorkspaceCalendarHandler.MaximumEntries,
                Cancellation);

            Assert.Empty(calendar.Entries);
            Assert.Empty(calendar.Unplaceable);
        }
    }

    [Fact]
    public async Task A_reader_given_no_readable_workspaces_returns_nothing()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var calendar = await work.Resolve<IWorkspaceCalendar>().ReadAsync(
                OpenWorkspace,
                [],
                "2000-01-01",
                "2099-12-31",
                GetWorkspaceCalendarHandler.MaximumEntries,
                Cancellation);

            Assert.Empty(calendar.Entries);
            Assert.Empty(calendar.Unplaceable);
        }
    }

    [Fact]
    public async Task A_window_that_ends_before_it_begins_is_refused_rather_than_answered_empty()
    {
        var result = await QueryAsync(OpenWorkspace, "2026-03-31", "2026-03-01");

        Assert.True(result.IsFailure);
        Assert.Equal("calendar.invalid_window", result.Error.Code);
    }

    [Fact]
    public async Task A_window_that_is_not_a_date_is_refused_rather_than_compared_as_text()
    {
        // '2026-13-45' orders perfectly well as a string and would quietly match nothing, which a
        // reader would read as "nothing is scheduled" rather than "you asked for a month that does
        // not exist".
        var result = await QueryAsync(OpenWorkspace, "2026-13-45", "2026-13-46");

        Assert.True(result.IsFailure);
        Assert.Equal("calendar.invalid_window", result.Error.Code);
    }

    [Fact]
    public async Task A_window_wider_than_the_bound_is_refused()
    {
        var result = await QueryAsync(OpenWorkspace, "2020-01-01", "2030-01-01");

        Assert.True(result.IsFailure);
        Assert.Equal("calendar.invalid_window", result.Error.Code);
    }

    [Fact]
    public async Task A_read_inside_its_ceiling_does_not_claim_to_be_truncated()
    {
        var result = await QueryAsync(OpenWorkspace, "2026-03-01", "2026-03-31");

        Assert.True(result.IsSuccess);
        Assert.False(result.Value.EntriesTruncated);
        Assert.Equal(GetWorkspaceCalendarHandler.MaximumEntries, result.Value.EntryLimit);
    }

    [Fact]
    public async Task Entries_arrive_earliest_first_so_a_truncated_read_keeps_the_start_of_the_window()
    {
        var calendar = await ReadAsync("2026-03-01", "2026-03-31");

        var values = calendar.Entries.Select(entry => entry.Value).ToList();

        Assert.Equal(values.OrderBy(value => value, StringComparer.Ordinal), values);
    }

    /// <summary>
    /// The stored calendar these tests are about: the concrete entries and the containers that
    /// could not place one.
    /// </summary>
    /// <remarks>
    /// Generated occurrences are filtered out on purpose. This file asks what one principal may
    /// see of what is stored, and a series occurrence is computed from a rule rather than read
    /// from a row - it has its own authorization test, and letting it through here would make
    /// these assertions depend on recurrence arithmetic that has nothing to do with permissions.
    /// </remarks>
    private async Task<WorkspaceCalendar> ReadAsync(string firstDay, string lastDay)
    {
        var result = await QueryAsync(OpenWorkspace, firstDay, lastDay);
        Assert.True(result.IsSuccess);

        return new WorkspaceCalendar(
            [.. result.Value.Entries.Where(row => !row.Generated).Select(row => row.Entry)],
            result.Value.UnplaceableContainers);
    }

    private async Task<Result<WorkspaceCalendarResults>> QueryAsync(
        WorkspaceId workspaceId,
        string firstDay,
        string lastDay)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(MemberContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            return await work.Resolve<NixDispatcher>()
                .QueryAsync<GetWorkspaceCalendar, Result<WorkspaceCalendarResults>>(
                    new GetWorkspaceCalendar(workspaceId, firstDay, lastDay),
                    Cancellation);
        }
    }

    private async Task HideContainersBelowDeletedAncestorAsync(Guid datedContainerId, Guid unplaceableContainerId)
    {
        var tenant = RawSql.Literal(M0SchemaSeed.Alpha.TenantId);
        var workspace = RawSql.Literal(M0SchemaSeed.Alpha.WorkspaceId);
        var principal = RawSql.Literal(M0SchemaSeed.Alpha.PrincipalId);

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
                      ({{RawSql.Literal(DeletedAncestor)}}, {{tenant}}, {{workspace}}, 'note', NULL, 900,
                       '{"title":"Deleted ancestor"}'::jsonb, 'deleted', NULL, {{principal}},
                       {{principal}}, now(), now());

                  UPDATE item
                     SET parent_id = {{RawSql.Literal(DeletedAncestor)}}
                   WHERE id IN ({{RawSql.Literal(datedContainerId)}}, {{RawSql.Literal(unplaceableContainerId)}});

                  INSERT INTO item_closure
                      (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
                  VALUES
                      ({{RawSql.Literal(DeletedAncestor)}}, {{RawSql.Literal(DeletedAncestor)}},
                       {{tenant}}, {{workspace}}, 0),
                      ({{RawSql.Literal(datedContainerId)}}, {{RawSql.Literal(DeletedAncestor)}},
                       {{tenant}}, {{workspace}}, 1),
                      ({{RawSql.Literal(unplaceableContainerId)}}, {{RawSql.Literal(DeletedAncestor)}},
                       {{tenant}}, {{workspace}}, 1);
                  """);
        }
    }

    /// <summary>
    /// Seeds four containers, their calendar views, and the children they place.
    /// </summary>
    /// <remarks>
    /// Written as the migrator for the same reason the graph fixture is: the shape under test is
    /// what the statement reads, not what the application is able to write.
    /// </remarks>
    private async Task SeedCalendarsAsync()
    {
        var tenant = RawSql.Literal(M0SchemaSeed.Alpha.TenantId);
        var open = RawSql.Literal(M0SchemaSeed.Alpha.WorkspaceId);
        var closed = RawSql.Literal(PrivateWorkspace);
        var principal = RawSql.Literal(M0SchemaSeed.Alpha.PrincipalId);

        var sql = $$"""
            INSERT INTO principal
                (principal_id, tenant_id, external_subject, kind, display_name, email, status,
                 deprovisioned_at)
            VALUES ({{RawSql.Literal(Member)}}, {{tenant}}, 'alpha-calendar-member', 'user', 'Member',
                    'calendar-member@example.test', 'active', NULL);

            INSERT INTO workspace_member
                (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            VALUES ({{open}}, 'principal', {{RawSql.Literal(Member)}}, {{tenant}}, 'viewer',
                    {{principal}}, now());

            INSERT INTO workspace
                (workspace_id, tenant_id, name, version_retention_days, coalesce_window_min,
                 storage_quota_bytes, created_at)
            VALUES ({{closed}}, {{tenant}}, 'Alpha private', 30, 10, 1073741824, now());

            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties, views,
                 lifecycle_state, purge_after, created_by, last_modified_by, created_at,
                 last_modified_at)
            VALUES
                -- Containers. Each declares the property its children are placed by.
                ({{RawSql.Literal(DueContainer)}}, {{tenant}}, {{open}}, 'note', NULL, 1000,
                 '{"title": "Deadlines"}'::jsonb,
                 '{"views": [{"id": "v1", "kind": "calendar", "name": "By due", "dateProperty": "due"}]}'::jsonb,
                 'active', NULL, {{principal}}, {{principal}}, now(), now()),

                ({{RawSql.Literal(StartsContainer)}}, {{tenant}}, {{open}}, 'note', NULL, 2000,
                 '{"title": "Sessions"}'::jsonb,
                 '{"views": [{"id": "v1", "kind": "list", "name": "All"}, {"id": "v2", "kind": "calendar", "name": "When", "dateProperty": "starts"}]}'::jsonb,
                 'active', NULL, {{principal}}, {{principal}}, now(), now()),

                -- Offers a calendar and names nothing to place by.
                ({{RawSql.Literal(UnplaceableContainer)}}, {{tenant}}, {{open}}, 'note', NULL, 3000,
                 '{"title": "Misconfigured"}'::jsonb,
                 '{"views": [{"id": "v1", "kind": "calendar", "name": "Unset"}]}'::jsonb,
                 'active', NULL, {{principal}}, {{principal}}, now(), now()),

                -- Two calendars. The first declared is the one that counts.
                ({{RawSql.Literal(TwiceContainer)}}, {{tenant}}, {{open}}, 'note', NULL, 4000,
                 '{"title": "Both"}'::jsonb,
                 '{"views": [{"id": "v1", "kind": "calendar", "name": "A", "dateProperty": "due"}, {"id": "v2", "kind": "calendar", "name": "B", "dateProperty": "starts"}]}'::jsonb,
                 'active', NULL, {{principal}}, {{principal}}, now(), now()),

                -- A container in the workspace this caller may not read.
                ({{RawSql.Literal(PrivateWorkspace)}}, {{tenant}}, {{closed}}, 'note', NULL, 5000,
                 '{"title": "Confidential"}'::jsonb,
                 '{"views": [{"id": "v1", "kind": "calendar", "name": "When", "dateProperty": "due"}]}'::jsonb,
                 'active', NULL, {{principal}}, {{principal}}, now(), now()),

                -- The dated children.
                ({{RawSql.Literal(AllDay)}}, {{tenant}}, {{open}}, 'note', {{RawSql.Literal(DueContainer)}}, 1100,
                 '{"title": "Filing", "due": "2026-03-12"}'::jsonb, NULL,
                 'active', NULL, {{principal}}, {{principal}}, now(), now()),

                ({{RawSql.Literal(Undated)}}, {{tenant}}, {{open}}, 'note', {{RawSql.Literal(DueContainer)}}, 1200,
                 '{"title": "Someday"}'::jsonb, NULL,
                 'active', NULL, {{principal}}, {{principal}}, now(), now()),

                ({{RawSql.Literal(Moment)}}, {{tenant}}, {{open}}, 'note', {{RawSql.Literal(StartsContainer)}}, 2100,
                 '{"title": "Standup", "starts": "2026-03-17T09:00:00+00:00[Europe/London]"}'::jsonb, NULL,
                 'active', NULL, {{principal}}, {{principal}}, now(), now()),

                ({{RawSql.Literal(FarFuture)}}, {{tenant}}, {{open}}, 'note', {{RawSql.Literal(StartsContainer)}}, 2200,
                 '{"title": "Later", "starts": "2027-01-04"}'::jsonb, NULL,
                 'active', NULL, {{principal}}, {{principal}}, now(), now()),

                ({{RawSql.Literal(Twice)}}, {{tenant}}, {{open}}, 'note', {{RawSql.Literal(TwiceContainer)}}, 4100,
                 '{"title": "Ambiguous", "due": "2026-03-20", "starts": "2026-03-25"}'::jsonb, NULL,
                 'active', NULL, {{principal}}, {{principal}}, now(), now()),

                ({{RawSql.Literal(PrivateDated)}}, {{tenant}}, {{closed}}, 'note',
                 {{RawSql.Literal(PrivateWorkspace)}}, 5100,
                 '{"title": "Board pack", "due": "2026-03-15"}'::jsonb, NULL,
                 'active', NULL, {{principal}}, {{principal}}, now(), now());
            """;

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }
}
