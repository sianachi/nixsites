using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Notifications;
using Nix.Domain.Tenancy;
using Nix.Features.Notifications;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class NotificationsPersistenceTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static readonly Guid SecondAlphaPrincipal = new("1c1c1c1c-1111-4111-8111-1c1c1c1c1c1c");

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static NixSessionContext SecondAlphaContext =>
        TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, SecondAlphaPrincipal);

    private static string ValidP256dh()
    {
        var key = new byte[65];
        key[0] = 0x04;
        return Convert.ToBase64String(key).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            // These tests exercise first-write behavior, unlike the fully populated schema fixture.
            await RawSql.ExecuteAsync(connection, transaction: null, "DELETE FROM principal_preferences");
            await RawSql.ExecuteAsync(connection, transaction: null, "DELETE FROM notification");
            await RawSql.ExecuteAsync(connection, transaction: null, "DELETE FROM push_subscription");
            await RawSql.ExecuteAsync(connection, transaction: null, "DELETE FROM notification_inbox");

            // A second principal in the alpha tenant, so per-principal behaviour is tested
            // between two people who share a tenant rather than only across tenants.
            await RawSql.ExecuteAsync(connection, transaction: null, $"""
                INSERT INTO principal
                    (principal_id, tenant_id, external_issuer, external_subject, kind, display_name,
                     email, email_normalized, email_verified, status, deprovisioned_at)
                VALUES ('{SecondAlphaPrincipal}', '{TestTenants.Alpha}', 'https://issuer.alpha.test', 'alpha-second-subject', 'user',
                        'alpha second user', 'alpha-second@example.test', 'alpha-second@example.test', true, 'active', NULL)
                ON CONFLICT DO NOTHING
                """);
        }
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Preferences_survive_a_new_request_and_refuse_stale_writes()
    {
        var input = new PreferencesInput("Europe/London", "22:00", "07:00", "08:30", true, false, []);
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var saved = await work.Resolve<NixDispatcher>().SendAsync<SavePreferences, PrincipalPreferencesResponse>(new(0, input), Cancellation);
            Assert.True(saved.IsSuccess);
            Assert.Equal(1, saved.Value.Revision);
            await work.CommitAsync(Cancellation);
        }

        work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var read = await dispatcher.QueryAsync<GetPreferences, PrincipalPreferencesResponse>(new(), Cancellation);
            Assert.Equal(1, read.Revision);
            Assert.Equal("Europe/London", read.TimeZone);
            Assert.Equal("22:00", read.QuietStart);

            var conflict = await dispatcher.SendAsync<SavePreferences, PrincipalPreferencesResponse>(new(0, input), Cancellation);
            Assert.True(conflict.IsFailure);
            Assert.Equal("notifications.preferences_conflict", conflict.Error.Code);

            var updated = await dispatcher.SendAsync<SavePreferences, PrincipalPreferencesResponse>(new(1, input with { DueReminders = false }), Cancellation);
            Assert.True(updated.IsSuccess);
            Assert.Equal(2, updated.Value.Revision);
            await work.CommitAsync(Cancellation);
        }
    }

    [Fact]
    public async Task An_unknown_zone_and_a_malformed_time_are_refused()
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var badZone = await dispatcher.SendAsync<SavePreferences, PrincipalPreferencesResponse>(
                new(0, new PreferencesInput("Not/AZone", null, null, "09:00", true, true, [])), Cancellation);
            Assert.True(badZone.IsFailure);
            Assert.Equal("notifications.invalid_preferences", badZone.Error.Code);

            var badTime = await dispatcher.SendAsync<SavePreferences, PrincipalPreferencesResponse>(
                new(0, new PreferencesInput("Etc/UTC", null, null, "9:00am", true, true, [])), Cancellation);
            Assert.True(badTime.IsFailure);
            Assert.Equal("notifications.invalid_preferences", badTime.Error.Code);
        }
    }

    [Fact]
    public async Task Preferences_rls_hides_other_tenants_and_other_principals()
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            await work.Resolve<NixDispatcher>().SendAsync<SavePreferences, PrincipalPreferencesResponse>(
                new(0, new PreferencesInput("Etc/UTC", null, null, "09:00", true, true, [])), Cancellation);
            await work.CommitAsync(Cancellation);
        }

        foreach (var context in new[] { TestTenants.BetaContext,
            TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, TestTenants.BetaPrincipal) })
        {
            work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                Assert.Empty(await work.DbContext.Set<PrincipalPreferences>().AsNoTracking().ToListAsync(Cancellation));
                var store = work.Resolve<IPrincipalPreferencesStore>();
                Assert.Null(await store.FindAsync(TestTenants.AlphaContext.TenantId, TestTenants.AlphaContext.PrincipalId, Cancellation));
            }
        }
    }

    [Fact]
    public async Task Preferences_rls_refuses_a_forged_owner_on_insert()
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var error = await Assert.ThrowsAsync<PostgresException>(() => work.Resolve<IPrincipalPreferencesStore>().SaveAsync(new PrincipalPreferences
            {
                TenantId = TestTenants.BetaContext.TenantId,
                PrincipalId = TestTenants.BetaContext.PrincipalId,
                TimeZone = "Etc/UTC",
                DueReminderTime = new TimeOnly(9, 0),
                DueReminders = true,
                HabitReminders = true,
                MutedContainerIds = [],
                Revision = 1,
            }, 0, Cancellation));
            Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, error.SqlState);
        }
    }

    [Fact]
    public async Task Creating_a_notification_twice_with_the_same_dedupe_key_returns_the_first_one()
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var writer = work.Resolve<INotificationWriter>();
            var first = await writer.CreateAsync(TestTenants.AlphaContext.PrincipalId, NotificationKind.Reminder,
                "Task due", "Finish the report", null, null, "reminder:same-key", Cancellation);
            var second = await writer.CreateAsync(TestTenants.AlphaContext.PrincipalId, NotificationKind.Reminder,
                "Different title", "Different body", null, null, "reminder:same-key", Cancellation);
            Assert.True(first.Created);
            Assert.False(second.Created);
            Assert.Equal(first.Notification.Id, second.Notification.Id);
            Assert.Equal("Task due", second.Notification.Title);

            var store = work.Resolve<INotificationStore>();
            var (unread, revision) = await store.SummaryAsync(TestTenants.AlphaContext.TenantId, TestTenants.AlphaContext.PrincipalId, Cancellation);
            Assert.Equal(1, unread);
            Assert.True(revision > 0);
            await work.CommitAsync(Cancellation);
        }
    }

    [Theory]
    [InlineData(true, "question", "Pet has a question")]
    [InlineData(false, "proposal", "Pet needs approval")]
    public async Task A_pet_decision_creates_one_private_inbox_notice(
        bool isQuestion, string kind, string title)
    {
        var context = TestTenants.AlphaContext;
        var itemId = ItemId.From(M0SchemaSeed.Alpha.ItemId);
        var workspaceId = WorkspaceId.From(TestTenants.AlphaWorkspace);
        var target = new NotificationPetDecisionTarget(Guid.NewGuid(), Guid.NewGuid(), isQuestion);

        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation))
        {
            var writer = work.Resolve<INotificationWriter>();
            var first = await writer.CreatePetDecisionAsync(context.PrincipalId, itemId, workspaceId, target, Cancellation);
            var duplicate = await writer.CreatePetDecisionAsync(context.PrincipalId, itemId, workspaceId, target, Cancellation);
            Assert.True(first.Created);
            Assert.False(duplicate.Created);
            Assert.Equal(first.Notification.Id, duplicate.Notification.Id);
            await work.CommitAsync(Cancellation);
        }

        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var page = await dispatcher.QueryAsync<GetNotifications, NotificationsPageResponse>(new(null, false), Cancellation);
            var notice = Assert.Single(page.Items);
            Assert.Equal(1, page.Unread);
            Assert.Equal(1, page.Revision);
            Assert.Equal("system", notice.Kind);
            Assert.Equal(title, notice.Title);
            Assert.Equal("Open the pet dialog to continue.", notice.Body);
            Assert.Equal(itemId.Value, notice.ItemId);
            Assert.Equal(workspaceId.Value, notice.WorkspaceId);
            Assert.Equal(new NotificationPetDecisionDto(target.RunId, target.DecisionId, kind), notice.PetDecision);
            Assert.False(await work.Resolve<INotificationStore>().ClaimPushAsync(
                context.TenantId, context.PrincipalId, notice.Id, Cancellation));
        }

        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(SecondAlphaContext, Cancellation))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var page = await dispatcher.QueryAsync<GetNotifications, NotificationsPageResponse>(new(null, false), Cancellation);
            Assert.Empty(page.Items);
            Assert.Equal(0, page.Unread);
        }
    }

    [Fact]
    public async Task Notifications_refuse_writing_to_another_principal_in_the_writer_and_in_rls()
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            // The writer refuses a recipient other than the session's principal before any SQL.
            var writer = work.Resolve<INotificationWriter>();
            await Assert.ThrowsAsync<InvalidOperationException>(() => writer.CreateAsync(
                PrincipalId.From(SecondAlphaPrincipal), NotificationKind.System, "Forged", "Forged", null, null, "forged-key", Cancellation));

            // And row-level security refuses the same insert on its own, whoever issues it.
            var error = await Assert.ThrowsAsync<PostgresException>(() => work.DbContext.Database.ExecuteSqlInterpolatedAsync($"""
                INSERT INTO notification (tenant_id, id, principal_id, kind, title, body, created_at, dedupe_key)
                VALUES ({TestTenants.Alpha}, {Guid.NewGuid()}, {SecondAlphaPrincipal}, 'system', 'Forged', 'Forged', now(), 'forged-raw')
                """, Cancellation));
            Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, error.SqlState);
        }
    }

    [Fact]
    public async Task The_same_dedupe_key_creates_one_notification_per_principal()
    {
        foreach (var context in new[] { TestTenants.AlphaContext, SecondAlphaContext })
        {
            var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                var result = await work.Resolve<INotificationWriter>().CreateAsync(context.PrincipalId,
                    NotificationKind.Reminder, "Shared key", "Body", null, null, "automation:rule:2026-09-29", Cancellation);
                Assert.True(result.Created);
                Assert.Equal(context.PrincipalId, result.Notification.PrincipalId);
                await work.CommitAsync(Cancellation);
            }
        }
    }

    [Fact]
    public async Task The_inbox_revision_moves_forward_on_every_create_and_read()
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var writer = work.Resolve<INotificationWriter>();
            var store = work.Resolve<INotificationStore>();
            var tenant = TestTenants.AlphaContext.TenantId;
            var principal = TestTenants.AlphaContext.PrincipalId;

            var (_, empty) = await store.SummaryAsync(tenant, principal, Cancellation);
            var created = await writer.CreateAsync(principal, NotificationKind.Reminder, "One", "Body", null, null, "rev-1", Cancellation);
            var (_, afterCreate) = await store.SummaryAsync(tenant, principal, Cancellation);
            await writer.CreateAsync(principal, NotificationKind.Reminder, "One again", "Body", null, null, "rev-1", Cancellation);
            var (_, afterDuplicate) = await store.SummaryAsync(tenant, principal, Cancellation);
            Assert.True(await store.MarkReadAsync(tenant, principal, created.Notification.Id, Cancellation));
            var (_, afterRead) = await store.SummaryAsync(tenant, principal, Cancellation);
            await writer.CreateAsync(principal, NotificationKind.Reminder, "Two", "Body", null, null, "rev-2", Cancellation);
            await store.MarkAllReadAsync(tenant, principal, Cancellation);
            var (unread, afterAllRead) = await store.SummaryAsync(tenant, principal, Cancellation);

            Assert.Equal(0, empty);
            Assert.True(afterCreate > empty);
            Assert.Equal(afterCreate, afterDuplicate);
            Assert.True(afterRead > afterCreate);
            Assert.True(afterAllRead > afterRead);
            Assert.Equal(0, unread);
        }
    }

    [Fact]
    public async Task Another_principals_notification_and_device_are_invisible_to_read_and_delete()
    {
        Guid othersNotification;
        var endpoint = "https://fcm.googleapis.com/fcm/send/second-alpha-device";
        var work = await fixture.Application.BeginUnitOfWorkAsync(SecondAlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var created = await work.Resolve<INotificationWriter>().CreateAsync(SecondAlphaContext.PrincipalId,
                NotificationKind.System, "Private", "Body", null, null, "private", Cancellation);
            othersNotification = created.Notification.Id;
            var saved = await work.Resolve<NixDispatcher>().SendAsync<AddPushSubscription, PushSubscriptionDto>(
                new(endpoint, ValidP256dh(), "AAAAAAAAAAAAAAAAAAAAAA", "second-agent"), Cancellation);
            Assert.True(saved.IsSuccess);
            await work.CommitAsync(Cancellation);
        }

        work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var read = await dispatcher.SendAsync<MarkNotificationRead, NotificationReadResponse>(new(othersNotification), Cancellation);
            Assert.True(read.IsFailure);
            Assert.Equal("notifications.not_found", read.Error.Code);
            var removed = await dispatcher.SendAsync<RemovePushSubscription, bool>(new(endpoint), Cancellation);
            Assert.True(removed.IsSuccess);
            Assert.False(removed.Value);
            await work.CommitAsync(Cancellation);
        }

        work = await fixture.Application.BeginUnitOfWorkAsync(SecondAlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            Assert.Single(await work.DbContext.Set<PushSubscription>().AsNoTracking().ToListAsync(Cancellation));
            Assert.Null((await work.DbContext.Set<Notification>().AsNoTracking().SingleAsync(Cancellation)).ReadAt);
        }
    }

    [Fact]
    public async Task Notification_tables_grant_the_application_role_only()
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            foreach (var table in new[] { "principal_preferences", "notification", "push_subscription", "notification_inbox" })
            {
                foreach (var (role, expected) in new[] { ("nix_app", true), ("nix_collab", false) })
                {
                    var command = connection.CreateCommand();
                    await using (command.ConfigureAwait(false))
                    {
                        command.CommandText = "SELECT has_table_privilege(@role, @table, 'SELECT')";
                        command.Parameters.AddWithValue("role", role);
                        command.Parameters.AddWithValue("table", table);
                        Assert.Equal(expected, (bool)(await command.ExecuteScalarAsync(Cancellation))!);
                    }
                }
            }
        }
    }

    [Fact]
    public async Task Half_set_quiet_hours_are_refused()
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var saved = await work.Resolve<NixDispatcher>().SendAsync<SavePreferences, PrincipalPreferencesResponse>(
                new(0, new PreferencesInput("Europe/London", "22:00", null, "08:30", true, true, [])), Cancellation);
            Assert.True(saved.IsFailure);
            Assert.Equal("notifications.invalid_preferences", saved.Error.Code);
        }
    }

    [Fact]
    public async Task Notifications_rls_hides_other_tenants_and_other_principals()
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            await work.Resolve<INotificationWriter>().CreateAsync(TestTenants.AlphaContext.PrincipalId,
                NotificationKind.System, "Alpha only", "Alpha only body", null, null, "alpha-only", Cancellation);
            await work.CommitAsync(Cancellation);
        }

        foreach (var context in new[] { TestTenants.BetaContext,
            TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, TestTenants.BetaPrincipal) })
        {
            work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                Assert.Empty(await work.DbContext.Set<Notification>().AsNoTracking().ToListAsync(Cancellation));
            }
        }
    }

    [Fact]
    public async Task Marking_read_updates_the_unread_count_and_refuses_someone_elses_notification()
    {
        Guid notificationId;
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var created = await work.Resolve<INotificationWriter>().CreateAsync(TestTenants.AlphaContext.PrincipalId,
                NotificationKind.Reminder, "Read me", "Body", null, null, "read-me", Cancellation);
            notificationId = created.Notification.Id;
            await work.CommitAsync(Cancellation);
        }

        work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var read = await dispatcher.SendAsync<MarkNotificationRead, NotificationReadResponse>(new(notificationId), Cancellation);
            Assert.True(read.IsSuccess);
            Assert.Equal(0, read.Value.Unread);

            var missing = await dispatcher.SendAsync<MarkNotificationRead, NotificationReadResponse>(new(Guid.NewGuid()), Cancellation);
            Assert.True(missing.IsFailure);
            Assert.Equal("notifications.not_found", missing.Error.Code);
            await work.CommitAsync(Cancellation);
        }
    }

    [Fact]
    public async Task Push_subscriptions_round_trip_and_refuse_a_bad_endpoint()
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();
            var p256dh = ValidP256dh();
            var auth = Convert.ToBase64String(new byte[16]).TrimEnd('=').Replace('+', '-').Replace('/', '_');

            var saved = await dispatcher.SendAsync<AddPushSubscription, PushSubscriptionDto>(
                new("https://fcm.googleapis.com/fcm/send/abc", p256dh, auth, "test-agent"), Cancellation);
            Assert.True(saved.IsSuccess);

            var disallowed = await dispatcher.SendAsync<AddPushSubscription, PushSubscriptionDto>(
                new("https://attacker.example.com/collect", p256dh, auth, "test-agent"), Cancellation);
            Assert.True(disallowed.IsFailure);
            Assert.Equal("notifications.invalid_subscription", disallowed.Error.Code);

            var removed = await dispatcher.SendAsync<RemovePushSubscription, bool>(new("https://fcm.googleapis.com/fcm/send/abc"), Cancellation);
            Assert.True(removed.IsSuccess);
            Assert.True(removed.Value);

            var removedAgain = await dispatcher.SendAsync<RemovePushSubscription, bool>(new("https://fcm.googleapis.com/fcm/send/abc"), Cancellation);
            Assert.True(removedAgain.IsSuccess);
            Assert.False(removedAgain.Value);
            await work.CommitAsync(Cancellation);
        }
    }

    [Fact]
    public async Task Push_subscriptions_rls_hides_other_tenants_and_other_principals()
    {
        var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var p256dh = ValidP256dh();
            var auth = Convert.ToBase64String(new byte[16]).TrimEnd('=').Replace('+', '-').Replace('/', '_');
            await work.Resolve<NixDispatcher>().SendAsync<AddPushSubscription, PushSubscriptionDto>(
                new("https://fcm.googleapis.com/fcm/send/xyz", p256dh, auth, "test-agent"), Cancellation);
            await work.CommitAsync(Cancellation);
        }

        foreach (var context in new[] { TestTenants.BetaContext,
            TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, TestTenants.BetaPrincipal) })
        {
            work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
            await using (work.ConfigureAwait(false))
            {
                Assert.Empty(await work.DbContext.Set<PushSubscription>().AsNoTracking().ToListAsync(Cancellation));
            }
        }
    }
}
