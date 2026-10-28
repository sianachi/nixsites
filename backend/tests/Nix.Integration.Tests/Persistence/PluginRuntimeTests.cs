using Microsoft.Extensions.DependencyInjection;
using Nix.Domain.Plugins;
using Nix.Domain.Tenancy;
using Nix.Integration.Tests.Harness;
using Nix.Persistence.ObjectStorage;
using Nix.Persistence.Plugins;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>Proves tenant-pinned installation data and the exact durable plugin dispatch boundary.</summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class PluginRuntimeTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Registration_pins_the_publisher_key_and_is_idempotent_per_workspace()
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation);
        var store = work.Resolve<PluginInstallationStore>();
        var registration = Registration(
            TestTenants.Alpha,
            "example.plugins",
            "example.plugins/planner",
            "1.2.3-alpha-beta.1+arm64",
            0x41,
            0x51);

        var created = await store.RegisterAsync(
            WorkspaceId.From(TestTenants.AlphaWorkspace),
            registration,
            Cancellation);
        var installation = Assert.IsType<PluginInstallationSnapshot>(created.Installation);
        Assert.Equal(PluginRegistrationOutcome.Created, created.Outcome);
        Assert.False(installation.Enabled);
        Assert.Empty(installation.Capabilities);

        var replay = await store.RegisterAsync(
            WorkspaceId.From(TestTenants.AlphaWorkspace),
            registration,
            Cancellation);
        Assert.Equal(PluginRegistrationOutcome.Existing, replay.Outcome);
        Assert.Equal(installation.Id, replay.Installation?.Id);

        var granted = await store.ReplaceGrantsAsync(
            WorkspaceId.From(TestTenants.AlphaWorkspace),
            installation.Id,
            new HashSet<string>(StringComparer.Ordinal)
            {
                PluginRuntimePolicy.ReadItemMetadataCapability,
            },
            Cancellation);
        Assert.Equal([PluginRuntimePolicy.ReadItemMetadataCapability], granted?.Capabilities);
        Assert.True((await store.SetEnabledAsync(
            WorkspaceId.From(TestTenants.AlphaWorkspace),
            installation.Id,
            enabled: true,
            Cancellation))?.Enabled);

        var conflict = await store.RegisterAsync(
            WorkspaceId.From(TestTenants.AlphaWorkspace),
            Registration(
                TestTenants.Alpha,
                "example.plugins",
                "example.plugins/another",
                "1.0.0",
                0x42,
                0x52),
            Cancellation);
        Assert.Equal(PluginRegistrationOutcome.PublisherKeyConflict, conflict.Outcome);

        var visible = await store.ListAsync(
            WorkspaceId.From(TestTenants.AlphaWorkspace),
            Cancellation);
        Assert.Contains(visible, value => value.Id == installation.Id && value.Enabled);
        Assert.Empty(await store.ListAsync(
            WorkspaceId.From(TestTenants.BetaWorkspace),
            Cancellation));
    }

    [Fact]
    public async Task Listing_pairs_each_installation_with_its_own_component_publisher_and_grants()
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation);
        var store = work.Resolve<PluginInstallationStore>();
        var workspace = WorkspaceId.From(TestTenants.AlphaWorkspace);
        var second = await store.RegisterAsync(workspace, Registration(TestTenants.Alpha, "list.b", "list.b/two", "2.0.0", 0x62, 0x72), Cancellation);
        var first = await store.RegisterAsync(workspace, Registration(TestTenants.Alpha, "list.a", "list.a/one", "1.0.0", 0x61, 0x71), Cancellation);
        await store.ReplaceGrantsAsync(
            workspace,
            second.Installation!.Id,
            new HashSet<string>(StringComparer.Ordinal) { PluginRuntimePolicy.ReadItemMetadataCapability },
            Cancellation);

        var listed = (await store.ListAsync(workspace, Cancellation))
            .Where(value => value.ComponentId.StartsWith("list.", StringComparison.Ordinal))
            .ToList();

        Assert.Equal(["list.a/one", "list.b/two"], listed.Select(value => value.ComponentId));
        Assert.Equal(first.Installation!.Id, listed[0].Id);
        Assert.Empty(listed[0].Capabilities);
        Assert.Equal([PluginRuntimePolicy.ReadItemMetadataCapability], listed[1].Capabilities);
        Assert.Equal("2.0.0", listed[1].Version);
        Assert.True(listed[1].PublicKey.Span.SequenceEqual(Enumerable.Repeat((byte)0x62, 32).ToArray()));
    }

    [Fact]
    public async Task Separate_tenants_may_pin_the_same_publisher_name_to_different_keys()
    {
        await RegisterAndCommitAsync(
            TestTenants.AlphaContext,
            Registration(
                TestTenants.Alpha,
                "tenant.publisher",
                "tenant.publisher/reader",
                "1.0.0",
                0x11,
                0x21));
        await RegisterAndCommitAsync(
            TestTenants.BetaContext,
            Registration(
                TestTenants.Beta,
                "tenant.publisher",
                "tenant.publisher/reader",
                "1.0.0",
                0x12,
                0x22));

        await using var alpha = await fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation);
        var alphaRows = await alpha.Resolve<PluginInstallationStore>().ListAsync(
            WorkspaceId.From(TestTenants.AlphaWorkspace),
            Cancellation);
        var alphaKey = Enumerable.Repeat((byte)0x11, 32).ToArray();
        var betaKey = Enumerable.Repeat((byte)0x12, 32).ToArray();
        Assert.Contains(alphaRows, value => value.ComponentId == "tenant.publisher/reader"
            && value.PublicKey.Span.SequenceEqual(alphaKey));
        Assert.DoesNotContain(alphaRows, value => value.PublicKey.Span.SequenceEqual(betaKey));
    }

    [Fact]
    public async Task Exact_outbox_events_are_leased_once_and_completion_replays_idempotently()
    {
        var eventId = Guid.NewGuid();
        await InsertOutboxEventAsync(eventId, M0SchemaSeed.Alpha, aggregateVersion: 7);
        var store = DispatchStore();
        var envelope = Envelope(eventId, M0SchemaSeed.Alpha, aggregateVersion: 7);

        var prepared = await store.PrepareAsync(envelope, 60, Cancellation);
        Assert.Equal(PluginPreparationOutcome.Prepared, prepared.Outcome);
        var plan = Assert.Single(prepared.Plans);
        Assert.Equal(1, plan.Attempt);
        Assert.Equal("nix.seed/alpha", plan.ComponentId);
        Assert.Equal([PluginRuntimePolicy.ReadItemMetadataCapability], plan.Capabilities);

        var busy = await store.PrepareAsync(envelope, 60, Cancellation);
        Assert.Equal(PluginPreparationOutcome.Busy, busy.Outcome);
        Assert.Empty(busy.Plans);

        var metadata = Assert.IsType<PluginItemMetadata>(await store.ReadItemMetadataAsync(
            plan.InvocationId,
            M0SchemaSeed.Alpha.ItemId,
            Cancellation));
        Assert.Equal(M0SchemaSeed.Alpha.WorkspaceId, metadata.WorkspaceId);
        Assert.Equal(eventId, metadata.CausationId);
        Assert.Null(await store.ReadItemMetadataAsync(
            plan.InvocationId,
            M0SchemaSeed.Beta.ItemId,
            Cancellation));

        var applied = await store.CompleteAsync(
            plan.InvocationId,
            succeeded: true,
            retryable: false,
            errorCode: null,
            errorDetail: null,
            Cancellation);
        Assert.Equal(PluginCompletionOutcome.Applied, applied.Outcome);
        Assert.False(applied.ShouldRequeue);

        var replayed = await store.CompleteAsync(
            plan.InvocationId,
            succeeded: true,
            retryable: false,
            errorCode: null,
            errorDetail: null,
            Cancellation);
        Assert.Equal(PluginCompletionOutcome.Replayed, replayed.Outcome);

        var conflicting = await store.CompleteAsync(
            plan.InvocationId,
            succeeded: false,
            retryable: false,
            errorCode: "plugin.failed",
            errorDetail: "A different result.",
            Cancellation);
        Assert.Equal(PluginCompletionOutcome.Conflict, conflicting.Outcome);

        var settled = await store.PrepareAsync(envelope, 60, Cancellation);
        Assert.Equal(PluginPreparationOutcome.Settled, settled.Outcome);
    }

    [Fact]
    public async Task Fabricated_or_scope_modified_broker_events_never_create_invocations()
    {
        var eventId = Guid.NewGuid();
        await InsertOutboxEventAsync(eventId, M0SchemaSeed.Alpha, aggregateVersion: 9);
        var store = DispatchStore();

        var fabricated = await store.PrepareAsync(
            Envelope(Guid.NewGuid(), M0SchemaSeed.Alpha, aggregateVersion: 9),
            60,
            Cancellation);
        Assert.Equal(PluginPreparationOutcome.NotFound, fabricated.Outcome);

        var changedVersion = await store.PrepareAsync(
            Envelope(eventId, M0SchemaSeed.Alpha, aggregateVersion: 10),
            60,
            Cancellation);
        Assert.Equal(PluginPreparationOutcome.Conflict, changedVersion.Outcome);

        var changedTenant = await store.PrepareAsync(
            new PluginEventEnvelope(
                eventId,
                M0SchemaSeed.Beta.TenantId,
                M0SchemaSeed.Beta.WorkspaceId,
                M0SchemaSeed.Beta.ItemId,
                "item.changed",
                9,
                eventId,
                0),
            60,
            Cancellation);
        Assert.Equal(PluginPreparationOutcome.Conflict, changedTenant.Outcome);
    }

    [Fact]
    public async Task Retryable_failures_stop_requeueing_after_five_durable_attempts()
    {
        var eventId = Guid.NewGuid();
        await InsertOutboxEventAsync(eventId, M0SchemaSeed.Alpha, aggregateVersion: 11);
        var store = DispatchStore();
        var envelope = Envelope(eventId, M0SchemaSeed.Alpha, aggregateVersion: 11);

        for (var attempt = 1; attempt <= PluginRuntimePolicy.MaximumAttempts; attempt++)
        {
            var prepared = await store.PrepareAsync(envelope, 60, Cancellation);
            var plan = Assert.Single(prepared.Plans);
            Assert.Equal(attempt, plan.Attempt);
            var completion = await store.CompleteAsync(
                plan.InvocationId,
                succeeded: false,
                retryable: true,
                errorCode: "plugin.transient",
                errorDetail: "The host call can be retried.",
                Cancellation);
            Assert.Equal(
                attempt < PluginRuntimePolicy.MaximumAttempts,
                completion.ShouldRequeue);
        }

        var terminal = await store.PrepareAsync(envelope, 60, Cancellation);
        Assert.Equal(PluginPreparationOutcome.Settled, terminal.Outcome);
        Assert.Empty(terminal.Plans);
    }

    [Fact]
    public async Task Expired_leases_are_recovered_but_revoked_grants_stop_host_reads()
    {
        var eventId = Guid.NewGuid();
        await InsertOutboxEventAsync(eventId, M0SchemaSeed.Alpha, aggregateVersion: 13);
        var store = DispatchStore();
        var envelope = Envelope(eventId, M0SchemaSeed.Alpha, aggregateVersion: 13);
        var first = Assert.Single((await store.PrepareAsync(envelope, 60, Cancellation)).Plans);
        await ExpireInvocationAsync(first.InvocationId.Value);

        var second = Assert.Single((await store.PrepareAsync(envelope, 60, Cancellation)).Plans);
        Assert.Equal(2, second.Attempt);
        Assert.NotEqual(first.InvocationId, second.InvocationId);

        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(
            TestTenants.AlphaContext,
            Cancellation))
        {
            var installations = work.Resolve<PluginInstallationStore>();
            var changed = await installations.ReplaceGrantsAsync(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId),
                PluginInstallationId.From(M0SchemaSeed.Alpha.ProviderId),
                new HashSet<string>(StringComparer.Ordinal),
                Cancellation);
            Assert.NotNull(changed);
            await work.CommitAsync(Cancellation);
        }

        Assert.Null(await store.ReadItemMetadataAsync(
            second.InvocationId,
            M0SchemaSeed.Alpha.ItemId,
            Cancellation));
    }

    [Fact]
    public async Task Host_reads_withhold_an_item_under_a_lock_but_not_the_locked_item_itself()
    {
        var child = Guid.NewGuid();
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await ExecuteAsync(
                connection,
                """
                INSERT INTO item (id, tenant_id, workspace_id, type, parent_id, seq, properties,
                                  lifecycle_state, created_by, last_modified_by, created_at, last_modified_at)
                VALUES (@child, @tenant_id, @workspace_id, 'note', @parent, 99001,
                        jsonb_build_object('title', 'Inside the lock'), 'active', @principal, @principal, now(), now());
                INSERT INTO item_closure (tenant_id, workspace_id, ancestor_id, descendant_id, depth)
                SELECT tenant_id, workspace_id, ancestor_id, @child, depth + 1
                  FROM item_closure WHERE tenant_id = @tenant_id AND descendant_id = @parent
                UNION ALL SELECT @tenant_id, @workspace_id, @child, @child, 0;
                INSERT INTO item_lock (item_id, tenant_id, password_hash, locked_by, locked_at)
                VALUES (@parent, @tenant_id,
                        'pbkdf2-sha256$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
                        @principal, now())
                ON CONFLICT DO NOTHING;
                """,
                new NpgsqlParameter("child", child),
                new NpgsqlParameter("parent", M0SchemaSeed.Alpha.ItemId),
                new NpgsqlParameter("tenant_id", M0SchemaSeed.Alpha.TenantId),
                new NpgsqlParameter("workspace_id", M0SchemaSeed.Alpha.WorkspaceId),
                new NpgsqlParameter("principal", M0SchemaSeed.Alpha.PrincipalId));
        }

        var eventId = Guid.NewGuid();
        await InsertOutboxEventAsync(eventId, M0SchemaSeed.Alpha, aggregateVersion: 21);
        var store = DispatchStore();
        var plan = Assert.Single((await store.PrepareAsync(
            Envelope(eventId, M0SchemaSeed.Alpha, aggregateVersion: 21), 60, Cancellation)).Plans);

        // A plugin holds no unlock, so what the lock covers is not its to read; the lock's own
        // item answers as it does in its parent's children.
        Assert.NotNull(await store.ReadItemMetadataAsync(plan.InvocationId, M0SchemaSeed.Alpha.ItemId, Cancellation));
        Assert.Null(await store.ReadItemMetadataAsync(plan.InvocationId, child, Cancellation));
    }

    private async Task RegisterAndCommitAsync(
        Nix.Abstractions.NixSessionContext session,
        PluginComponentRegistration registration)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(session, Cancellation);
        var result = await work.Resolve<PluginInstallationStore>().RegisterAsync(
            session.WorkspaceId!.Value,
            registration,
            Cancellation);
        Assert.Equal(PluginRegistrationOutcome.Created, result.Outcome);
        await work.CommitAsync(Cancellation);
    }

    private PluginDispatchStore DispatchStore()
    {
        var scope = fixture.Application.CreateUnscopedScope();
        return scope.ServiceProvider.GetRequiredService<PluginDispatchStore>();
    }

    private async Task InsertOutboxEventAsync(
        Guid eventId,
        M0TenantRows tenant,
        long aggregateVersion)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await ExecuteAsync(
                connection,
                """
                INSERT INTO worker_outbox_event
                    (event_id, tenant_id, workspace_id, item_id, kind, aggregate_version,
                     payload, available_at, attempts)
                VALUES (@event_id, @tenant_id, @workspace_id, @item_id, 'item.changed',
                        @aggregate_version, '{}'::jsonb, now(), 0)
                """,
                new NpgsqlParameter("event_id", eventId),
                new NpgsqlParameter("tenant_id", tenant.TenantId),
                new NpgsqlParameter("workspace_id", tenant.WorkspaceId),
                new NpgsqlParameter("item_id", tenant.ItemId),
                new NpgsqlParameter("aggregate_version", aggregateVersion));
        }
    }

    private async Task ExpireInvocationAsync(Guid invocationId)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await ExecuteAsync(
                connection,
                "UPDATE plugin_invocation SET lease_until = now() - interval '1 second' WHERE invocation_id = @invocation_id",
                new NpgsqlParameter("invocation_id", invocationId));
        }
    }

    private static async Task ExecuteAsync(
        NpgsqlConnection connection,
        string sql,
        params NpgsqlParameter[] parameters)
    {
#pragma warning disable CA2100 // Justification: every caller passes static test SQL and bound values.
        var command = new NpgsqlCommand(sql, connection);
#pragma warning restore CA2100
        await using (command.ConfigureAwait(false))
        {
            command.Parameters.AddRange(parameters);
            await command.ExecuteNonQueryAsync(Cancellation);
        }
    }

    private static PluginEventEnvelope Envelope(
        Guid eventId,
        M0TenantRows tenant,
        long aggregateVersion) => new(
        eventId,
        tenant.TenantId,
        tenant.WorkspaceId,
        tenant.ItemId,
        "item.changed",
        aggregateVersion,
        eventId,
        0);

    private static PluginComponentRegistration Registration(
        Guid tenantId,
        string publisherId,
        string componentId,
        string version,
        byte keyByte,
        byte signatureByte)
    {
        var digest = new string('C', 64);
        return new PluginComponentRegistration(
            publisherId,
            componentId,
            version,
            ObjectStorageKeys.PluginComponent(
                TenantId.From(tenantId),
                componentId,
                version,
                digest),
            digest,
            8,
            Enumerable.Repeat(keyByte, 32).ToArray(),
            Enumerable.Repeat(signatureByte, 64).ToArray());
    }
}
