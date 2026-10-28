using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Primitives;
using Nix.Domain.Provisioning;
using Nix.Domain.Tenancy;
using Nix.Features.Calendar;
using Nix.Features.Workspaces;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Nix.Persistence.Workspaces;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class WorkspaceAdministrationTests : IAsyncLifetime
{
    private static readonly Guid Alice = new("71717171-1111-4111-8111-717171717171");
    private static readonly Guid Bob = new("72727272-2222-4222-8222-727272727272");
    private static readonly Guid Service = new("73737373-3333-4333-8333-737373737373");
    private static readonly Guid Visible = new("74747474-4444-4444-8444-747474747474");
    private static readonly Guid Hidden = new("75757575-5555-4555-8555-757575757575");
    private static readonly Guid Charlie = new("76767676-6666-4666-8666-767676767676");
    private static readonly Guid Dana = new("77777777-7777-4777-8777-777777777777");
    private static readonly Guid Editors = new("78787878-8888-4888-8888-787878787878");

    private readonly NixPostgresFixture _fixture;

    public WorkspaceAdministrationTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        await SeedAsync();
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Daily_calendar_entries_require_opt_in_membership_and_an_open_root()
    {
        await SetPersonalOwnerAsync();
        var opened = await OpenDailyThroughCoreAndCommitAsync(Alice, "2026-10-04");
        Assert.True(opened.IsSuccess);
        Assert.Empty((await ReadDailyCalendarAsync(Alice)).Value.Entries);
        var settingsWork = await _fixture.Application.BeginUnitOfWorkAsync(Context(Alice), Cancellation);
        await using (settingsWork.ConfigureAwait(false))
        {
            Assert.True(await settingsWork.Resolve<WorkspaceAdministrationStore>().SaveDailyNoteSettingsAsync(
                WorkspaceId.From(Visible), DailyNoteSettings.Create(true, "flat", "iso", null, 0, true).Value, Cancellation));
            await settingsWork.CommitAsync(Cancellation);
        }
        var listed = await ReadDailyCalendarAsync(Alice);
        Assert.True(listed.IsSuccess);
        var entry = Assert.Single(listed.Value.Entries).Entry;
        Assert.Equal(opened.Value.ItemId, entry.ItemId.Value);
        Assert.Equal("2026-10-04", entry.Value);
        Assert.True((await ReadDailyCalendarAsync(Bob)).IsFailure);

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, $"""
                INSERT INTO item_lock (item_id, tenant_id, password_hash, locked_by, locked_at)
                VALUES ('{DeterministicProvisioningId.DailyNotesRoot(WorkspaceId.From(Visible)):D}',
                        '{M0SchemaSeed.Alpha.TenantId:D}', '{new string('a', 64)}', '{Alice:D}', now());
                """);
        }
        Assert.Empty((await ReadDailyCalendarAsync(Alice)).Value.Entries);
    }

    private async Task<Result<WorkspaceCalendarResults>> ReadDailyCalendarAsync(Guid principalId)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(Context(principalId), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            return await work.Resolve<NixDispatcher>().QueryAsync<GetWorkspaceCalendar, Result<WorkspaceCalendarResults>>(
                new GetWorkspaceCalendar(WorkspaceId.From(Visible), "2026-10-01", "2026-10-31"), Cancellation);
        }
    }

    [Fact]
    public async Task Shared_daily_notes_require_opt_in_and_are_one_note_for_all_editors()
    {
        Assert.False((await OpenDailyThroughCoreAndCommitAsync(Alice, "2026-10-04")).IsSuccess);
        var enabling = await _fixture.Application.BeginUnitOfWorkAsync(Context(Alice), Cancellation);
        await using (enabling.ConfigureAwait(false))
        {
            Assert.True(await enabling.Resolve<WorkspaceAdministrationStore>().SaveDailyNoteSettingsAsync(
                WorkspaceId.From(Visible), DailyNoteSettings.Create(true, "by-month", "long", "# Start", 3, true).Value, Cancellation));
            await enabling.CommitAsync(Cancellation);
        }
        await AddGroupMembershipAsync(Bob, "editor");
        var first = await OpenDailyThroughCoreAndCommitAsync(Alice, "2026-10-04");
        var second = await OpenDailyThroughCoreAndCommitAsync(Bob, "2026-10-04");
        Assert.True(first.IsSuccess);
        Assert.True(first.Value.Created);
        Assert.True(second.IsSuccess);
        Assert.False(second.Value.Created);
        Assert.Equal(first.Value.ItemId, second.Value.ItemId);
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            Assert.Equal(3, await RawSql.CountAsync(connection, null,
                $"SELECT count(*) FROM item_closure WHERE descendant_id = '{first.Value.ItemId:D}' AND depth > 0"));
        }
    }

    [Fact]
    public async Task Shared_viewers_cannot_create_daily_notes_or_change_the_settings()
    {
        await AddGroupMembershipAsync(Bob, "viewer");
        var work = await _fixture.Application.BeginUnitOfWorkAsync(Context(Bob), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            Assert.NotNull(await work.Resolve<WorkspaceAdministrationStore>().ReadDailyNoteSettingsAsync(WorkspaceId.From(Visible), Cancellation));
            Assert.False(await work.Resolve<WorkspaceAdministrationStore>().SaveDailyNoteSettingsAsync(
                WorkspaceId.From(Visible), DailyNoteSettings.Default(true), Cancellation));
        }
        Assert.False((await OpenDailyThroughCoreAndCommitAsync(Bob, "2026-10-04")).IsSuccess);
    }

    [Fact]
    public async Task Later_daily_settings_do_not_move_or_retitle_an_existing_note()
    {
        await SetPersonalOwnerAsync();
        var first = await OpenDailyThroughCoreAndCommitAsync(Alice, "2026-10-04");
        var changing = await _fixture.Application.BeginUnitOfWorkAsync(Context(Alice), Cancellation);
        await using (changing.ConfigureAwait(false))
        {
            Assert.True(await changing.Resolve<WorkspaceAdministrationStore>().SaveDailyNoteSettingsAsync(
                WorkspaceId.From(Visible), DailyNoteSettings.Create(true, "by-month", "long", null, 0, false).Value, Cancellation));
            await changing.CommitAsync(Cancellation);
        }
        var reopened = await OpenDailyThroughCoreAndCommitAsync(Alice, "2026-10-04");
        Assert.Equal(first.Value.ItemId, reopened.Value.ItemId);
        Assert.False(reopened.Value.Created);
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            Assert.Equal(1, await RawSql.CountAsync(connection, null,
                $"SELECT count(*) FROM item WHERE id = '{first.Value.ItemId:D}' AND properties ->> 'title' = '2026-10-04' AND parent_id = '{DeterministicProvisioningId.DailyNotesRoot(WorkspaceId.From(Visible)):D}'"));
        }
    }

    [Fact]
    public async Task A_closed_daily_root_cannot_be_used_to_create_hidden_children()
    {
        await SetPersonalOwnerAsync();
        await SeedDailyRootAsync();
        var root = DeterministicProvisioningId.DailyNotesRoot(WorkspaceId.From(Visible));
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, $"""
                INSERT INTO item_lock (item_id, tenant_id, password_hash, locked_by, locked_at)
                VALUES ('{root:D}', '{M0SchemaSeed.Alpha.TenantId:D}', '{new string('a', 64)}', '{Alice:D}', now());
                """);
        }
        var opening = await OpenDailyThroughCoreAndCommitAsync(Alice, "2026-10-04");
        Assert.True(opening.IsFailure);
        Assert.Equal("workspaces.daily_notes_root_unavailable", opening.Error.Code);
    }

    [Fact]
    public async Task Listing_filters_in_sql_and_never_returns_an_unreachable_workspace()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(Context(Alice), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var rows = await work.Resolve<WorkspaceAdministrationStore>()
                .ListAsync(null, null, 20, Cancellation);

            var row = Assert.Single(rows);
            Assert.Equal(Visible, row.Id.Value);
            Assert.DoesNotContain(rows, workspace => workspace.Id.Value == Hidden);
            Assert.True(row.CanManageMembers);
        }
    }

    [Fact]
    public async Task Active_humans_create_shared_workspaces_but_service_principals_cannot()
    {
        var createdId = WorkspaceId.Create();
        var human = await _fixture.Application.BeginUnitOfWorkAsync(Context(Alice), Cancellation);
        await using (human.ConfigureAwait(false))
        {
            var store = human.Resolve<WorkspaceAdministrationStore>();
            Assert.True(await store.CreateAsync(createdId, "Alice project", DateTimeOffset.UtcNow, Cancellation));
            await store.SeedPresetsAsync(createdId, DateTimeOffset.UtcNow, Cancellation);
            Assert.Equal("Alice project", (await store.FindAsync(createdId, Cancellation))?.Name);
            await human.CommitAsync(Cancellation);
        }

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            Assert.Equal(3, await RawSql.CountAsync(
                connection,
                transaction: null,
                $"SELECT count(*) FROM workspace_template WHERE workspace_id = '{createdId.Value:D}'"));
        }

        var service = await _fixture.Application.BeginUnitOfWorkAsync(Context(Service), Cancellation);
        await using (service.ConfigureAwait(false))
        {
            Assert.False(await service.Resolve<WorkspaceAdministrationStore>().CreateAsync(
                WorkspaceId.Create(), "Machine project", DateTimeOffset.UtcNow, Cancellation));
        }
    }

    [Fact]
    public async Task Last_active_human_owner_is_not_demoted_until_another_owner_exists()
    {
        var invitationId = Guid.CreateVersion7();
        var work = await _fixture.Application.BeginUnitOfWorkAsync(Context(Alice), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var store = work.Resolve<WorkspaceAdministrationStore>();
            Assert.False(await store.ChangeMemberRoleAsync(
                WorkspaceId.From(Visible), PrincipalId.From(Alice), "editor", DateTimeOffset.UtcNow, Cancellation));

            var pending = await store.CreateInvitationAsync(
                WorkspaceId.From(Visible), invitationId, PrincipalId.From(Bob), "owner",
                DateTimeOffset.UtcNow, Cancellation);
            Assert.Equal("pending", pending.Invitation?.Status);
            Assert.Null(await store.FindPrincipalMemberAsync(
                WorkspaceId.From(Visible), PrincipalId.From(Bob), Cancellation));

            Assert.False(await store.ChangeMemberRoleAsync(
                WorkspaceId.From(Visible), PrincipalId.From(Alice), "editor", DateTimeOffset.UtcNow, Cancellation));
            await work.CommitAsync(Cancellation);
        }

        var accepting = await _fixture.Application.BeginUnitOfWorkAsync(Context(Bob), Cancellation);
        await using (accepting.ConfigureAwait(false))
        {
            Assert.True(await accepting.Resolve<WorkspaceAdministrationStore>().AcceptInvitationAsync(
                WorkspaceId.From(Visible), invitationId, DateTimeOffset.UtcNow, Cancellation));
            await accepting.CommitAsync(Cancellation);
        }

        var demoting = await _fixture.Application.BeginUnitOfWorkAsync(Context(Alice), Cancellation);
        await using (demoting.ConfigureAwait(false))
        {
            Assert.True(await demoting.Resolve<WorkspaceAdministrationStore>().ChangeMemberRoleAsync(
                WorkspaceId.From(Visible), PrincipalId.From(Alice), "editor", DateTimeOffset.UtcNow, Cancellation));
        }
    }

    [Fact]
    public async Task Personal_owner_is_protected_and_collaborators_cannot_be_assigned_owner()
    {
        await SetPersonalOwnerAsync();
        var work = await _fixture.Application.BeginUnitOfWorkAsync(Context(Alice), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var store = work.Resolve<WorkspaceAdministrationStore>();
            Assert.False(await store.RemoveMemberAsync(
                WorkspaceId.From(Visible), PrincipalId.From(Alice), false, Cancellation));
            var refused = await store.CreateInvitationAsync(
                WorkspaceId.From(Visible), Guid.CreateVersion7(), PrincipalId.From(Bob), "owner",
                DateTimeOffset.UtcNow, Cancellation);
            Assert.Equal("conflict", refused.Outcome);
            Assert.Null(refused.Invitation);
        }
    }

    [Fact]
    public async Task Invitee_search_matches_name_and_email_and_keeps_authorization_and_keyset_paging()
    {
        await InsertHumanAsync(Charlie, "charlie", "charlie@example.test", verified: true);
        await InsertHumanAsync(Dana, "dana", "dana@example.test", verified: true);
        await AddGroupMembershipAsync(Bob, "editor");
        var work = await _fixture.Application.BeginUnitOfWorkAsync(Context(Alice), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var store = work.Resolve<WorkspaceAdministrationStore>();
            var everyone = await store.ListInviteesAsync(WorkspaceId.From(Visible), null, 20, Cancellation);
            var self = Assert.Single(everyone, person => person.PrincipalId.Value == Alice);
            Assert.False(self.CanInvite);
            Assert.Equal("self", self.CannotInviteReason);
            Assert.DoesNotContain(everyone, person => person.PrincipalId.Value == Service);
            Assert.DoesNotContain(everyone, person => person.PrincipalId.Value == M0SchemaSeed.Beta.PrincipalId);
            var byName = await store.ListInviteesAsync(WorkspaceId.From(Visible), null, 20, Cancellation, "CHARLIE");
            Assert.Equal(Charlie, Assert.Single(byName).PrincipalId.Value);
            var byEmail = await store.ListInviteesAsync(WorkspaceId.From(Visible), null, 20, Cancellation, "DANA@EXAMPLE");
            Assert.Equal(Dana, Assert.Single(byEmail).PrincipalId.Value);
            Assert.Empty(await store.ListInviteesAsync(WorkspaceId.From(Visible), null, 20, Cancellation, "%"));
            var member = Assert.Single(await store.ListInviteesAsync(WorkspaceId.From(Visible), null, 20, Cancellation, "bob"));
            Assert.False(member.CanInvite);
            Assert.Equal("already_has_access", member.CannotInviteReason);
            var first = Assert.Single(await store.ListInviteesAsync(WorkspaceId.From(Visible), null, 1, Cancellation, "example.test"));
            var remaining = await store.ListInviteesAsync(WorkspaceId.From(Visible), first.PrincipalId, 20, Cancellation, "example.test");
            Assert.DoesNotContain(remaining, candidate => candidate.PrincipalId == first.PrincipalId);
            Assert.Contains(remaining, candidate => candidate.PrincipalId.Value == Dana);
            Assert.Empty(await store.ListInviteesAsync(WorkspaceId.From(Hidden), null, 20, Cancellation, "charlie"));
        }
        var viewerWork = await _fixture.Application.BeginUnitOfWorkAsync(Context(Bob), Cancellation);
        await using (viewerWork.ConfigureAwait(false))
        {
            Assert.Empty(await viewerWork.Resolve<WorkspaceAdministrationStore>().ListInviteesAsync(
                WorkspaceId.From(Visible), null, 20, Cancellation, "charlie"));
        }
    }

    [Fact]
    public async Task Pending_invitation_grants_nothing_until_the_target_accepts_it()
    {
        await InsertHumanAsync(Charlie, "charlie", "charlie@example.test", verified: true);
        var invitationId = Guid.CreateVersion7();
        var work = await _fixture.Application.BeginUnitOfWorkAsync(Context(Alice), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var store = work.Resolve<WorkspaceAdministrationStore>();
            var invitees = await store.ListInviteesAsync(
                WorkspaceId.From(Visible), null, 20, Cancellation);
            Assert.Contains(invitees, invitee => invitee.PrincipalId.Value == Charlie);
            var pending = await store.CreateInvitationAsync(
                WorkspaceId.From(Visible), invitationId, PrincipalId.From(Charlie), "editor",
                DateTimeOffset.UtcNow, Cancellation);
            Assert.Equal("pending", pending.Invitation?.Status);
            Assert.Equal(Charlie, pending.Invitation?.TargetPrincipalId?.Value);
            var pendingPerson = Assert.Single((await store.ListInviteesAsync(
                WorkspaceId.From(Visible), null, 20, Cancellation)), person => person.PrincipalId.Value == Charlie);
            Assert.False(pendingPerson.CanInvite);
            Assert.Equal("invitation_pending", pendingPerson.CannotInviteReason);
            Assert.Null(await store.FindPrincipalMemberAsync(
                WorkspaceId.From(Visible), PrincipalId.From(Charlie), Cancellation));

            var conflict = await store.CreateInvitationAsync(
                WorkspaceId.From(Visible), Guid.CreateVersion7(), PrincipalId.From(Charlie), "viewer",
                DateTimeOffset.UtcNow, Cancellation);
            Assert.Equal("conflict", conflict.Outcome);
            var history = Assert.Single(await store.ListInvitationsAsync(
                WorkspaceId.From(Visible), null, null, 20, Cancellation));
            Assert.Equal(invitationId, history.InvitationId);
            Assert.Equal("editor", history.Role);
            await work.CommitAsync(Cancellation);
        }

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            Assert.Equal(1, await RawSql.CountAsync(connection, null,
                $"SELECT count(*) FROM scheduled_trigger WHERE principal_id = '{Charlie:D}'::uuid AND source = 'workspace.invitation' AND rule_id = '{invitationId:D}'::uuid AND status = 'pending'"));
        }

        var accepting = await _fixture.Application.BeginUnitOfWorkAsync(Context(Charlie), Cancellation);
        await using (accepting.ConfigureAwait(false))
        {
            var store = accepting.Resolve<WorkspaceAdministrationStore>();
            var invited = await store.FindAsync(WorkspaceId.From(Visible), Cancellation);
            Assert.Equal(invitationId, invited?.PendingInvitationId);
            Assert.False(invited!.CanRename || invited.CanManageMembers || invited.CanLeave || invited.CanUseDailyNotes);
            Assert.Contains(await store.ListAsync(null, null, 50, Cancellation), row => row.Id.Value == Visible);
            Assert.False(await accepting.Resolve<IPermissionResolver>().CanReadWorkspaceAsync(
                WorkspaceId.From(Visible), Cancellation));
            Assert.True(await store.AcceptInvitationAsync(
                WorkspaceId.From(Visible), invitationId, DateTimeOffset.UtcNow, Cancellation));
            await accepting.CommitAsync(Cancellation);
        }

        var checking = await _fixture.Application.BeginUnitOfWorkAsync(Context(Alice), Cancellation);
        await using (checking.ConfigureAwait(false))
        {
            var accepted = Assert.Single(await checking.Resolve<WorkspaceAdministrationStore>()
                .ListInvitationsAsync(WorkspaceId.From(Visible), null, null, 20, Cancellation));
            Assert.Equal("accepted", accepted.Status);
            Assert.Equal(Charlie, accepted.AcceptedByPrincipalId?.Value);
            Assert.NotNull(accepted.AcceptedAt);
        }
    }

    [Fact]
    public async Task Accepting_an_invitation_never_lowers_a_role_already_held()
    {
        // A recovery can make a pending invitee an owner; accepting the old viewer offer keeps that.
        var invitationId = Guid.CreateVersion7();
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, $"""
                INSERT INTO workspace_member
                    (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
                VALUES ('{Visible:D}', 'principal', '{Bob:D}', '{M0SchemaSeed.Alpha.TenantId:D}',
                        'owner', '{Alice:D}', now());
                INSERT INTO workspace_invitation
                    (invitation_id, tenant_id, workspace_id, email_normalized, target_principal_id,
                     role, invited_by_principal_id, status, invited_at)
                VALUES ('{invitationId:D}', '{M0SchemaSeed.Alpha.TenantId:D}', '{Visible:D}',
                        'bob-recovered@example.test', '{Bob:D}', 'viewer', '{Alice:D}', 'pending', now());
                """);
        }

        var accepting = await _fixture.Application.BeginUnitOfWorkAsync(Context(Bob), Cancellation);
        await using (accepting.ConfigureAwait(false))
        {
            var store = accepting.Resolve<WorkspaceAdministrationStore>();
            Assert.True(await store.AcceptInvitationAsync(
                WorkspaceId.From(Visible), invitationId, DateTimeOffset.UtcNow, Cancellation));
            Assert.Equal("owner", (await store.FindPrincipalMemberAsync(
                WorkspaceId.From(Visible), PrincipalId.From(Bob), Cancellation))?.Role);
        }
    }

    [Fact]
    public async Task A_closed_workspace_refuses_new_invitations_and_holds_pending_ones()
    {
        await InsertHumanAsync(Charlie, "charlie", "charlie@example.test", verified: true);
        await InsertHumanAsync(Dana, "dana", "dana@example.test", verified: true);
        var invitationId = Guid.CreateVersion7();
        var work = await _fixture.Application.BeginUnitOfWorkAsync(Context(Alice), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var store = work.Resolve<WorkspaceAdministrationStore>();
            Assert.Equal("pending", (await store.CreateInvitationAsync(
                WorkspaceId.From(Visible), invitationId, PrincipalId.From(Charlie), "viewer",
                DateTimeOffset.UtcNow, Cancellation)).Invitation?.Status);
            Assert.True(await store.SetSharingAsync(WorkspaceId.From(Visible), true, null, Cancellation));
            Assert.Equal("locked", (await store.CreateInvitationAsync(
                WorkspaceId.From(Visible), Guid.CreateVersion7(), PrincipalId.From(Dana), "viewer",
                DateTimeOffset.UtcNow, Cancellation)).Outcome);
            await work.CommitAsync(Cancellation);
        }

        var outsider = await _fixture.Application.BeginUnitOfWorkAsync(Context(Bob), Cancellation);
        await using (outsider.ConfigureAwait(false))
        {
            Assert.False(await outsider.Resolve<WorkspaceAdministrationStore>().SetSharingAsync(
                WorkspaceId.From(Visible), false, false, Cancellation));
        }

        var accepting = await _fixture.Application.BeginUnitOfWorkAsync(Context(Charlie), Cancellation);
        await using (accepting.ConfigureAwait(false))
        {
            var store = accepting.Resolve<WorkspaceAdministrationStore>();
            Assert.False(await store.AcceptInvitationAsync(
                WorkspaceId.From(Visible), invitationId, DateTimeOffset.UtcNow, Cancellation));
            var held = await store.FindAsync(WorkspaceId.From(Visible), Cancellation);
            Assert.True(held?.MembershipLocked);
            Assert.Equal(invitationId, held?.PendingInvitationId);
        }
    }

    [Fact]
    public async Task Unverified_humans_are_visible_but_cannot_be_invited_and_a_decline_removes_the_invitation()
    {
        await InsertHumanAsync(Charlie, "charlie", "shared@example.test", verified: false);
        await InsertHumanAsync(Dana, "dana", "dana@example.test", verified: true);

        var invitationId = Guid.CreateVersion7();
        var work = await _fixture.Application.BeginUnitOfWorkAsync(Context(Alice), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var store = work.Resolve<WorkspaceAdministrationStore>();
            var invitees = await store.ListInviteesAsync(WorkspaceId.From(Visible), null, 20, Cancellation);
            var unverifiedPerson = Assert.Single(invitees, invitee => invitee.PrincipalId.Value == Charlie);
            Assert.False(unverifiedPerson.CanInvite);
            Assert.Equal("email_unverified", unverifiedPerson.CannotInviteReason);
            Assert.Contains(invitees, invitee => invitee.PrincipalId.Value == Dana);
            var unverified = await store.CreateInvitationAsync(
                WorkspaceId.From(Visible), Guid.CreateVersion7(), PrincipalId.From(Charlie), "viewer",
                DateTimeOffset.UtcNow, Cancellation);
            var pending = await store.CreateInvitationAsync(
                WorkspaceId.From(Visible), invitationId, PrincipalId.From(Dana), "viewer",
                DateTimeOffset.UtcNow, Cancellation);
            Assert.Equal("conflict", unverified.Outcome);
            Assert.Equal("pending", pending.Invitation?.Status);
            await work.CommitAsync(Cancellation);
        }

        var declining = await _fixture.Application.BeginUnitOfWorkAsync(Context(Dana), Cancellation);
        await using (declining.ConfigureAwait(false))
        {
            var store = declining.Resolve<WorkspaceAdministrationStore>();
            Assert.Equal(invitationId, (await store.FindAsync(
                WorkspaceId.From(Visible), Cancellation))?.PendingInvitationId);
            Assert.True(await store.DeclineInvitationAsync(
                WorkspaceId.From(Visible), invitationId, DateTimeOffset.UtcNow, Cancellation));
            Assert.Null(await store.FindAsync(WorkspaceId.From(Visible), Cancellation));
            await declining.CommitAsync(Cancellation);
        }
    }

    [Fact]
    public async Task A_last_owner_cannot_self_invite_to_a_lower_role()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(Context(Alice), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<WorkspaceAdministrationStore>().CreateInvitationAsync(
                WorkspaceId.From(Visible), Guid.CreateVersion7(), PrincipalId.From(Alice), "editor",
                DateTimeOffset.UtcNow, Cancellation);
            Assert.Equal("conflict", result.Outcome);
            Assert.Equal("owner", (await work.Resolve<WorkspaceAdministrationStore>()
                .FindPrincipalMemberAsync(WorkspaceId.From(Visible), PrincipalId.From(Alice), Cancellation))?.Role);
        }
    }

    [Fact]
    public async Task Only_the_personal_workspace_owner_can_open_daily_notes()
    {
        await SetPersonalOwnerAsync();
        await SeedDailyRootAsync();

        var ownerWorkspace = await FindWorkspaceAsync(Alice);
        Assert.True(ownerWorkspace?.CanUseDailyNotes);
        Assert.True((await ListWorkspacesAsync(Alice)).Single().CanUseDailyNotes);
        var owner = await OpenDailyThroughCoreAsync(Alice, "2026-08-29");
        Assert.True(owner.IsSuccess);

        await AddGroupMembershipAsync(Bob, "editor");
        Assert.False((await FindWorkspaceAsync(Bob))?.CanUseDailyNotes);
        Assert.False((await ListWorkspacesAsync(Bob)).Single().CanUseDailyNotes);
        Assert.False((await OpenDailyThroughCoreAsync(Bob, "2026-08-28")).IsSuccess);

        await GrantTenantAdminAsync(Bob);
        Assert.False((await FindWorkspaceAsync(Bob))?.CanUseDailyNotes);
        Assert.False((await OpenDailyThroughCoreAsync(Bob, "2026-08-27")).IsSuccess);

        await SetGroupRoleAsync("viewer");
        Assert.False((await OpenDailyThroughCoreAsync(Bob, "2026-08-26")).IsSuccess);
        await SetGroupRoleAsync("commenter");
        Assert.False((await OpenDailyThroughCoreAsync(Bob, "2026-08-25")).IsSuccess);

        await ClearPersonalOwnerAsync();
        Assert.False((await FindWorkspaceAsync(Alice))?.CanUseDailyNotes);
        Assert.False((await OpenDailyThroughCoreAsync(Alice, "2026-08-24")).IsSuccess);
    }

    [Fact]
    public async Task A_daily_open_cannot_commit_after_personal_ownership_is_converted()
    {
        await SetPersonalOwnerAsync();
        await SeedDailyRootAsync();
        const string date = "2026-08-23";
        var expected = DeterministicProvisioningId.DatedDailyNote(WorkspaceId.From(Visible), date);

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await using (var transaction = await connection.BeginTransactionAsync(Cancellation))
            {
                // This is the lock and ownership conversion performed by recovery. Keeping it open
                // makes the concurrent Daily Notes write wait at its authoritative ownership check.
                await RawSql.ExecuteAsync(connection, transaction, $"""
                    SELECT workspace_id FROM workspace
                    WHERE tenant_id = '{M0SchemaSeed.Alpha.TenantId:D}' AND workspace_id = '{Visible:D}'
                    FOR UPDATE;
                    UPDATE workspace SET personal_owner_principal_id = NULL
                    WHERE tenant_id = '{M0SchemaSeed.Alpha.TenantId:D}' AND workspace_id = '{Visible:D}';
                    """);

                var opening = OpenDailyThroughCoreAndCommitAsync(Alice, date);
                await transaction.CommitAsync(Cancellation);

                Assert.False((await opening).IsSuccess);
            }

            Assert.Equal(0, await RawSql.CountAsync(connection, null,
                $"SELECT count(*) FROM item WHERE id = '{expected:D}'::uuid"));
        }
    }

    [Fact]
    public async Task Recovery_requires_an_offboarded_personal_owner_and_converts_to_shared_once()
    {
        await SetPersonalOwnerAsync();
        await GrantTenantAdminAsync(Alice);
        var activeOwner = await RecoverAsync();
        Assert.False(activeOwner);

        await SetPrincipalStatusAsync(Alice, "suspended");
        Assert.True(await RecoverAsync());
        Assert.False(await RecoverAsync());

        var work = await _fixture.Application.BeginUnitOfWorkAsync(Context(Alice), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var recovered = await work.Resolve<WorkspaceAdministrationStore>().FindAsync(
                WorkspaceId.From(Visible), Cancellation);
            Assert.Null(recovered?.PersonalOwnerPrincipalId);
            Assert.Equal("owner", (await work.Resolve<WorkspaceAdministrationStore>()
                .FindPrincipalMemberAsync(WorkspaceId.From(Visible), PrincipalId.From(Bob), Cancellation))?.Role);
        }
    }

    [Fact]
    public async Task Two_simultaneous_daily_opens_return_the_one_deterministic_item()
    {
        await SetPersonalOwnerAsync();
        await SeedDailyRootAsync();
        const string date = "2026-08-30";
        var expected = DeterministicProvisioningId.DatedDailyNote(WorkspaceId.From(Visible), date);

        async Task<Guid?> OpenAsync()
        {
            var work = await _fixture.Application.BeginUnitOfWorkAsync(Context(Alice), Cancellation);
            await using (work.ConfigureAwait(false))
            {
                var opening = await work.Resolve<WorkspaceAdministrationStore>().OpenDailyNoteAsync(
                    WorkspaceId.From(Visible),
                    DeterministicProvisioningId.DailyNotesRoot(WorkspaceId.From(Visible)),
                    Candidates(date),
                    DateOnly.ParseExact(date, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture),
                    date,
                    DateTimeOffset.UtcNow,
                    Cancellation);
                await work.CommitAsync(Cancellation);
                return opening.ItemId;
            }
        }

        var opened = await Task.WhenAll(OpenAsync(), OpenAsync());
        Assert.All(opened, itemId => Assert.Equal(expected, itemId));

        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var count = await RawSql.CountAsync(
                connection,
                transaction: null,
                $"SELECT count(*) FROM item WHERE id = '{expected:D}'::uuid");
            Assert.Equal(1, count);
        }
    }

    [Fact]
    public async Task A_trashed_daily_note_reports_trash_instead_of_a_missing_workspace()
    {
        await SetPersonalOwnerAsync();
        var first = await OpenDailyThroughCoreAndCommitAsync(Alice, "2026-10-04");
        Assert.True(first.IsSuccess);
        await ExecuteAsMigratorAsync($"UPDATE item SET lifecycle_state = 'deleted' WHERE id = '{first.Value.ItemId:D}'");

        var reopened = await OpenDailyThroughCoreAndCommitAsync(Alice, "2026-10-04");

        Assert.True(reopened.IsFailure);
        Assert.Equal("workspaces.daily_note_in_trash", reopened.Error.Code);
        Assert.Equal(1, await CountDailyNotesAsync("2026-10-04"));
    }

    [Fact]
    public async Task A_daily_note_under_a_trashed_month_folder_reports_trash()
    {
        await SetPersonalOwnerAsync();
        await SaveDailySettingsAsync(DailyNoteSettings.Create(true, "by-month", "iso", null, 0, false).Value);
        var first = await OpenDailyThroughCoreAndCommitAsync(Alice, "2026-10-04");
        Assert.True(first.IsSuccess);
        var month = DeterministicProvisioningId.DailyNotesFolder(WorkspaceId.From(Visible), "2026-10");
        await ExecuteAsMigratorAsync($"UPDATE item SET lifecycle_state = 'deleted' WHERE id = '{month:D}'");

        var reopened = await OpenDailyThroughCoreAndCommitAsync(Alice, "2026-10-04");

        Assert.True(reopened.IsFailure);
        Assert.Equal("workspaces.daily_note_in_trash", reopened.Error.Code);
        Assert.Equal(1, await CountDailyNotesAsync("2026-10-04"));
    }

    [Fact]
    public async Task A_daily_note_under_a_closed_lock_reports_the_lock()
    {
        await SetPersonalOwnerAsync();
        var first = await OpenDailyThroughCoreAndCommitAsync(Alice, "2026-10-04");
        Assert.True(first.IsSuccess);
        await ExecuteAsMigratorAsync($"""
            INSERT INTO item_lock (item_id, tenant_id, password_hash, locked_by, locked_at)
            VALUES ('{DeterministicProvisioningId.DailyNotesRoot(WorkspaceId.From(Visible)):D}',
                    '{M0SchemaSeed.Alpha.TenantId:D}', '{new string('a', 64)}', '{Alice:D}', now());
            """);

        var reopened = await OpenDailyThroughCoreAndCommitAsync(Alice, "2026-10-04");

        Assert.True(reopened.IsFailure);
        Assert.Equal("workspaces.daily_note_locked", reopened.Error.Code);
        Assert.Equal(1, await CountDailyNotesAsync("2026-10-04"));
    }

    [Fact]
    public async Task A_caller_who_cannot_write_learns_nothing_about_a_trashed_daily_note()
    {
        await SetPersonalOwnerAsync();
        var first = await OpenDailyThroughCoreAndCommitAsync(Alice, "2026-10-04");
        Assert.True(first.IsSuccess);
        await ExecuteAsMigratorAsync($"UPDATE item SET lifecycle_state = 'deleted' WHERE id = '{first.Value.ItemId:D}'");
        await AddGroupMembershipAsync(Bob, "editor");

        // An editor of someone else's personal workspace gets the answer a stranger gets, not the
        // note's state.
        var refused = await OpenDailyThroughCoreAsync(Bob, "2026-10-04");

        Assert.True(refused.IsFailure);
        Assert.Equal("workspaces.not_found", refused.Error.Code);
    }

    [Fact]
    public async Task The_day_keeps_its_newest_note_when_an_older_identifier_frees_up_or_returns()
    {
        await SetPersonalOwnerAsync();
        var first = await OpenDailyThroughCoreAndCommitAsync(Alice, "2026-10-04");
        Assert.True(first.IsSuccess);
        await ExecuteAsMigratorAsync($"""
            SELECT set_config('nix.tenant_id', '{M0SchemaSeed.Alpha.TenantId:D}', true);
            DELETE FROM item_closure WHERE descendant_id = '{first.Value.ItemId:D}' AND depth > 0;
            UPDATE item SET workspace_id = '{Hidden:D}', parent_id = NULL WHERE id = '{first.Value.ItemId:D}';
            """);
        var successor = await OpenDailyThroughCoreAndCommitAsync(Alice, "2026-10-04");
        Assert.True(successor.IsSuccess);
        Assert.Equal(Candidates("2026-10-04")[1], successor.Value.ItemId);

        // The original comes back into this workspace: the successor, which has been in use since,
        // stays the day's note.
        await ExecuteAsMigratorAsync($"""
            SELECT set_config('nix.tenant_id', '{M0SchemaSeed.Alpha.TenantId:D}', true);
            UPDATE item SET workspace_id = '{Visible:D}' WHERE id = '{first.Value.ItemId:D}';
            """);
        var afterReturn = await OpenDailyThroughCoreAndCommitAsync(Alice, "2026-10-04");
        Assert.True(afterReturn.IsSuccess);
        Assert.False(afterReturn.Value.Created);
        Assert.Equal(successor.Value.ItemId, afterReturn.Value.ItemId);

        // The original disappears outright, as a purged workspace's items do: its identifier is
        // free again but sits below the successor, so it is not reused.
        await ExecuteAsMigratorAsync($"""
            SELECT set_config('nix.tenant_id', '{M0SchemaSeed.Alpha.TenantId:D}', true);
            DELETE FROM item_closure WHERE descendant_id = '{first.Value.ItemId:D}' OR ancestor_id = '{first.Value.ItemId:D}';
            DELETE FROM item WHERE id = '{first.Value.ItemId:D}';
            """);
        var afterDelete = await OpenDailyThroughCoreAndCommitAsync(Alice, "2026-10-04");
        Assert.True(afterDelete.IsSuccess);
        Assert.False(afterDelete.Value.Created);
        Assert.Equal(successor.Value.ItemId, afterDelete.Value.ItemId);
    }

    [Fact]
    public async Task A_purged_daily_note_is_left_alone_and_the_day_opens_one_fresh_note()
    {
        await SetPersonalOwnerAsync();
        var first = await OpenDailyThroughCoreAndCommitAsync(Alice, "2026-10-04");
        Assert.True(first.IsSuccess);
        Assert.Equal(Candidates("2026-10-04")[0], first.Value.ItemId);
        await ExecuteAsMigratorAsync($"UPDATE item SET lifecycle_state = 'purged' WHERE id = '{first.Value.ItemId:D}'");

        var fresh = await OpenDailyThroughCoreAndCommitAsync(Alice, "2026-10-04");
        var again = await OpenDailyThroughCoreAndCommitAsync(Alice, "2026-10-04");

        Assert.True(fresh.IsSuccess);
        Assert.True(fresh.Value.Created);
        Assert.Equal(Candidates("2026-10-04")[1], fresh.Value.ItemId);
        Assert.True(again.IsSuccess);
        Assert.False(again.Value.Created);
        Assert.Equal(fresh.Value.ItemId, again.Value.ItemId);
        Assert.Equal(1, await CountDailyNotesAsync("2026-10-04"));
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            Assert.Equal(1, await RawSql.CountAsync(connection, null,
                $"SELECT count(*) FROM item WHERE id = '{first.Value.ItemId:D}' AND lifecycle_state = 'purged'"));
        }
    }

    [Fact]
    public async Task Concurrent_opens_of_a_purged_day_converge_on_one_successor()
    {
        await SetPersonalOwnerAsync();
        var first = await OpenDailyThroughCoreAndCommitAsync(Alice, "2026-10-04");
        await ExecuteAsMigratorAsync($"UPDATE item SET lifecycle_state = 'purged' WHERE id = '{first.Value.ItemId:D}'");

        var opened = await Task.WhenAll(
            OpenDailyThroughCoreAndCommitAsync(Alice, "2026-10-04"),
            OpenDailyThroughCoreAndCommitAsync(Alice, "2026-10-04"));

        Assert.All(opened, opening => Assert.Equal(Candidates("2026-10-04")[1], opening.Value.ItemId));
        Assert.Single(opened, opening => opening.Value.Created);
        Assert.Equal(1, await CountDailyNotesAsync("2026-10-04"));
    }

    [Fact]
    public async Task A_daily_note_moved_to_another_workspace_frees_the_day_for_a_new_note()
    {
        await SetPersonalOwnerAsync();
        var first = await OpenDailyThroughCoreAndCommitAsync(Alice, "2026-10-04");
        Assert.True(first.IsSuccess);
        await ExecuteAsMigratorAsync($"""
            SELECT set_config('nix.tenant_id', '{M0SchemaSeed.Alpha.TenantId:D}', true);
            DELETE FROM item_closure WHERE descendant_id = '{first.Value.ItemId:D}' AND depth > 0;
            UPDATE item SET workspace_id = '{Hidden:D}', parent_id = NULL WHERE id = '{first.Value.ItemId:D}';
            """);

        var fresh = await OpenDailyThroughCoreAndCommitAsync(Alice, "2026-10-04");

        Assert.True(fresh.IsSuccess);
        Assert.True(fresh.Value.Created);
        Assert.NotEqual(first.Value.ItemId, fresh.Value.ItemId);
        Assert.Equal(1, await CountDailyNotesAsync("2026-10-04"));
    }

    [Fact]
    public async Task A_purged_daily_notes_root_starts_a_new_tree_and_keeps_existing_days()
    {
        await SetPersonalOwnerAsync();
        var workspace = WorkspaceId.From(Visible);
        var root = DeterministicProvisioningId.DailyNotesRoot(workspace);
        var earlier = await OpenDailyThroughCoreAndCommitAsync(Alice, "2026-10-04");
        Assert.True(earlier.IsSuccess);
        await PurgeContainerAsync(root, null);

        var later = await OpenDailyThroughCoreAndCommitAsync(Alice, "2026-10-05");
        var reopened = await OpenDailyThroughCoreAndCommitAsync(Alice, "2026-10-04");

        Assert.True(later.IsSuccess);
        Assert.True(later.Value.Created);
        var successor = DeterministicProvisioningId.DailyNotesRoot(workspace, 1);
        Assert.Equal(1, await CountAsMigratorAsync(
            $"SELECT count(*) FROM item WHERE id = '{later.Value.ItemId:D}' AND parent_id = '{successor:D}'"));
        Assert.Equal(1, await CountAsMigratorAsync(
            $"SELECT count(*) FROM item WHERE id = '{root:D}' AND lifecycle_state = 'purged'"));
        // The day that already had a note opens it where the purge left it.
        Assert.True(reopened.IsSuccess);
        Assert.False(reopened.Value.Created);
        Assert.Equal(earlier.Value.ItemId, reopened.Value.ItemId);
    }

    [Fact]
    public async Task A_purged_month_folder_is_replaced_for_new_days_in_that_month()
    {
        await SetPersonalOwnerAsync();
        await SaveDailySettingsAsync(DailyNoteSettings.Create(true, "by-month", "iso", null, 0, false).Value);
        var workspace = WorkspaceId.From(Visible);
        var first = await OpenDailyThroughCoreAndCommitAsync(Alice, "2026-10-04");
        Assert.True(first.IsSuccess);
        var year = DeterministicProvisioningId.DailyNotesFolder(workspace, "2026");
        await PurgeContainerAsync(DeterministicProvisioningId.DailyNotesFolder(workspace, "2026-10"), year);

        var next = await OpenDailyThroughCoreAndCommitAsync(Alice, "2026-10-20");

        Assert.True(next.IsSuccess);
        Assert.True(next.Value.Created);
        var month = DeterministicProvisioningId.DailyNotesFolder(workspace, "2026-10", 1);
        Assert.Equal(1, await CountAsMigratorAsync(
            $"SELECT count(*) FROM item WHERE id = '{next.Value.ItemId:D}' AND parent_id = '{month:D}'"));
        Assert.Equal(1, await CountAsMigratorAsync(
            $"SELECT count(*) FROM item WHERE id = '{month:D}' AND parent_id = '{year:D}' AND lifecycle_state = 'active'"));
    }

    /// <summary>What <c>PurgeItem</c> does to a container: children move up a level, the row is kept as purged.</summary>
    private async Task PurgeContainerAsync(Guid container, Guid? grandparent)
    {
        var parent = grandparent is { } value ? $"'{value:D}'" : "NULL";
        await ExecuteAsMigratorAsync($"""
            SELECT set_config('nix.tenant_id', '{M0SchemaSeed.Alpha.TenantId:D}', true);
            DELETE FROM item_closure
            WHERE ancestor_id = '{container:D}' AND depth > 0;
            UPDATE item SET parent_id = {parent} WHERE parent_id = '{container:D}';
            UPDATE item SET lifecycle_state = 'purged' WHERE id = '{container:D}';
            """);
    }

    private async Task<int> CountAsMigratorAsync(string sql)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            return (int)await RawSql.CountAsync(connection, null, sql);
        }
    }

    [Fact]
    public async Task Daily_calendar_entries_disappear_when_daily_notes_are_switched_off()
    {
        await SetPersonalOwnerAsync();
        await SaveDailySettingsAsync(DailyNoteSettings.Create(true, "flat", "iso", null, 0, true).Value);
        Assert.True((await OpenDailyThroughCoreAndCommitAsync(Alice, "2026-10-04")).IsSuccess);
        Assert.Single((await ReadDailyCalendarAsync(Alice)).Value.Entries);

        await SaveDailySettingsAsync(DailyNoteSettings.Create(false, "flat", "iso", null, 0, true).Value);

        var listed = await ReadDailyCalendarAsync(Alice);
        Assert.True(listed.IsSuccess);
        Assert.Empty(listed.Value.Entries);
    }

    private static Guid[] Candidates(string date)
    {
        var candidates = new Guid[64];
        for (var generation = 0; generation < candidates.Length; generation++)
        {
            candidates[generation] = DeterministicProvisioningId.DatedDailyNote(WorkspaceId.From(Visible), date, generation);
        }

        return candidates;
    }

    private async Task SaveDailySettingsAsync(DailyNoteSettings settings)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(Context(Alice), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            Assert.True(await work.Resolve<WorkspaceAdministrationStore>().SaveDailyNoteSettingsAsync(
                WorkspaceId.From(Visible), settings, Cancellation));
            await work.CommitAsync(Cancellation);
        }
    }

    private async Task ExecuteAsMigratorAsync(string sql)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, sql);
        }
    }

    private async Task<long> CountDailyNotesAsync(string date)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            return await RawSql.CountAsync(connection, null, $"""
                SELECT count(*) FROM item
                WHERE workspace_id = '{Visible:D}' AND properties ->> '$daily' = '{date}'
                  AND lifecycle_state <> 'purged'
                """);
        }
    }

    private async Task SeedAsync()
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, $"""
                INSERT INTO principal
                    (principal_id, tenant_id, external_issuer, external_subject, kind, display_name,
                     email, email_normalized, email_verified, status)
                VALUES
                    ('{Alice:D}', '{M0SchemaSeed.Alpha.TenantId:D}', 'https://issuer.alpha.test',
                     'alice', 'user', 'Alice', 'alice@example.test', 'alice@example.test', true, 'active'),
                    ('{Bob:D}', '{M0SchemaSeed.Alpha.TenantId:D}', 'https://issuer.alpha.test',
                     'bob', 'user', 'Bob', 'bob@example.test', 'bob@example.test', true, 'active'),
                    ('{Service:D}', '{M0SchemaSeed.Alpha.TenantId:D}', 'https://issuer.alpha.test',
                     'service', 'service', 'Service', NULL, NULL, false, 'active');

                INSERT INTO workspace
                    (workspace_id, tenant_id, name, version_retention_days,
                     coalesce_window_min, storage_quota_bytes, created_at)
                VALUES
                    ('{Visible:D}', '{M0SchemaSeed.Alpha.TenantId:D}', 'Visible', 90, 10, 10737418240, now()),
                    ('{Hidden:D}', '{M0SchemaSeed.Alpha.TenantId:D}', 'Hidden', 90, 10, 10737418240, now());

                INSERT INTO workspace_member
                    (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
                VALUES ('{Visible:D}', 'principal', '{Alice:D}', '{M0SchemaSeed.Alpha.TenantId:D}',
                        'owner', '{Alice:D}', now());
                """);
        }
    }

    private async Task SetPersonalOwnerAsync()
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, $"""
                UPDATE workspace SET personal_owner_principal_id = '{Alice:D}'
                 WHERE workspace_id = '{Visible:D}';
                """);
        }
    }

    private async Task ClearPersonalOwnerAsync()
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, $"""
                UPDATE workspace SET personal_owner_principal_id = NULL
                WHERE workspace_id = '{Visible:D}';
                """);
        }
    }

    private async Task SeedDailyRootAsync()
    {
        var root = DeterministicProvisioningId.DailyNotesRoot(WorkspaceId.From(Visible));
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, $"""
                INSERT INTO item
                    (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                     created_by, last_modified_by, created_at, last_modified_at)
                VALUES ('{root:D}', '{M0SchemaSeed.Alpha.TenantId:D}', '{Visible:D}', 'note', NULL,
                        1000, jsonb_build_object('title', 'Daily notes'), 'active',
                        '{Alice:D}', '{Alice:D}', now(), now());
                INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
                VALUES ('{root:D}', '{root:D}', '{M0SchemaSeed.Alpha.TenantId:D}', '{Visible:D}', 0);
                """);
        }
    }

    private async Task InsertHumanAsync(Guid id, string subject, string email, bool verified)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, $"""
                INSERT INTO principal
                    (principal_id, tenant_id, external_issuer, external_subject, kind, display_name,
                     email, email_normalized, email_verified, status)
                VALUES ('{id:D}', '{M0SchemaSeed.Alpha.TenantId:D}', 'https://issuer.alpha.test',
                        '{subject}', 'user', '{subject}', '{email}',
                        {(verified ? $"'{email}'" : "NULL")}, {(verified ? "true" : "false")}, 'active');
                """);
        }
    }

    private async Task AddGroupMembershipAsync(Guid principalId, string role)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, $"""
                INSERT INTO principal_group (group_id, tenant_id, name, external_id)
                VALUES ('{Editors:D}', '{M0SchemaSeed.Alpha.TenantId:D}', 'Editors', 'workspace-admin-editors');
                INSERT INTO group_membership (group_id, principal_id, tenant_id, source)
                VALUES ('{Editors:D}', '{principalId:D}', '{M0SchemaSeed.Alpha.TenantId:D}', 'directory');
                INSERT INTO workspace_member
                    (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
                VALUES ('{Visible:D}', 'group', '{Editors:D}', '{M0SchemaSeed.Alpha.TenantId:D}',
                        '{role}', '{Alice:D}', now());
                """);
        }
    }

    private async Task SetGroupRoleAsync(string role)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, $"""
                UPDATE workspace_member SET role = '{role}'
                WHERE workspace_id = '{Visible:D}' AND subject_type = 'group' AND subject_id = '{Editors:D}';
                """);
        }
    }

    private async Task<Result<DailyNoteOpened>> OpenDailyThroughCoreAsync(Guid principalId, string date)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(Context(principalId), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            return await work.Resolve<NixDispatcher>().SendAsync<OpenDailyNote, DailyNoteOpened>(
                new OpenDailyNote(WorkspaceId.From(Visible), date), Cancellation);
        }
    }

    private async Task<Result<DailyNoteOpened>> OpenDailyThroughCoreAndCommitAsync(Guid principalId, string date)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(Context(principalId), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>().SendAsync<OpenDailyNote, DailyNoteOpened>(
                new OpenDailyNote(WorkspaceId.From(Visible), date), Cancellation);
            if (result.IsSuccess)
            {
                await work.CommitAsync(Cancellation);
            }
            return result;
        }
    }

    private async Task<WorkspaceSnapshot?> FindWorkspaceAsync(Guid principalId)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(Context(principalId), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            return await work.Resolve<WorkspaceAdministrationStore>().FindAsync(
                WorkspaceId.From(Visible), Cancellation);
        }
    }

    private async Task<IReadOnlyList<WorkspaceSnapshot>> ListWorkspacesAsync(Guid principalId)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(Context(principalId), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            return await work.Resolve<WorkspaceAdministrationStore>().ListAsync(null, null, 20, Cancellation);
        }
    }

    private async Task GrantTenantAdminAsync(Guid principalId)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, $"""
                INSERT INTO tenant_role (tenant_id, subject_type, subject_id, role, granted_by, granted_at)
                VALUES ('{M0SchemaSeed.Alpha.TenantId:D}', 'principal', '{principalId:D}', 'admin',
                        '{principalId:D}', now());
                """);
        }
    }

    private async Task SetPrincipalStatusAsync(Guid principalId, string status)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, $"""
                UPDATE principal SET status = '{status}' WHERE principal_id = '{principalId:D}';
                """);
        }
    }

    private async Task<bool> RecoverAsync()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(Context(Alice), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var recovered = await work.Resolve<WorkspaceAdministrationStore>().RecoverAsync(
                WorkspaceId.From(Visible), PrincipalId.From(Bob), DateTimeOffset.UtcNow, Cancellation);
            if (recovered)
            {
                await work.CommitAsync(Cancellation);
            }
            return recovered;
        }
    }

    private static NixSessionContext Context(Guid principalId) => NixSessionContext.ForTenant(
        TenantId.From(M0SchemaSeed.Alpha.TenantId), PrincipalId.From(principalId));
}
