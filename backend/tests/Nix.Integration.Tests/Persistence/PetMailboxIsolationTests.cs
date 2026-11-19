using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Nix.Abstractions;
using Nix.Integration.Tests.Harness;
using Nix.Persistence;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class PetMailboxIsolationTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static readonly Guid OtherOwner = new("3b3b3b3b-3333-4333-8333-3b3b3b3b3b3b");
    private static readonly Guid OtherRule = new("3c3c3c3c-3333-4333-8333-3c3c3c3c3c3c");
    private static readonly Guid OtherConnection = new("3f3f3f3f-3333-4333-8333-3f3f3f3f3f3f");
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public static TheoryData<string> Tables
    {
        get
        {
            var data = new TheoryData<string>();
            foreach (var table in NixTables.ParentScoped)
            {
                data.Add(table);
            }
            return data;
        }
    }

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        await M0SchemaSeed.SeedCurrentSchemaRowsAsync(fixture);
        await using var connection = await fixture.OpenMigratorConnectionAsync();
        await RawSql.ExecuteAsync(connection, transaction: null, $"""
            INSERT INTO principal
                (principal_id, tenant_id, external_subject, kind, display_name, email, status, deprovisioned_at)
            VALUES ('{OtherOwner:D}', '{TestTenants.Alpha:D}', 'mailbox-neighbour', 'user', 'Mailbox neighbour',
                'mailbox-neighbour@example.test', 'active', NULL);
            INSERT INTO workspace_member
                (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            VALUES ('{TestTenants.AlphaWorkspace:D}', 'principal', '{OtherOwner:D}', '{TestTenants.Alpha:D}',
                'editor', '{TestTenants.AlphaPrincipal:D}', now());
            INSERT INTO automation_rule
                (id, tenant_id, workspace_id, owner_principal_id, name, enabled, trigger_type, trigger,
                 conditions, actions, schema_version, revision, consecutive_failures, created_at, updated_at)
            SELECT '{OtherRule:D}', tenant_id, workspace_id, '{OtherOwner:D}', 'Neighbour rule', false,
                trigger_type, trigger, conditions, actions, schema_version, revision, 0, created_at, updated_at
            FROM automation_rule WHERE id = '{M0SchemaSeed.Alpha.GroupId:D}';
            INSERT INTO pet_connector_grant
                (id, tenant_id, workspace_id, owner_id, revision, provider, resource_kind, resource_id, protected_tokens)
            SELECT '{OtherConnection:D}', tenant_id, workspace_id, '{OtherOwner:D}', revision, provider,
                resource_kind, resource_id, protected_tokens
            FROM pet_connector_grant WHERE id = '{M0SchemaSeed.Alpha.AclEntryId:D}';
            INSERT INTO pet_mailbox_cursor (rule_id, connection_id, connection_revision, cursor, baselined)
            VALUES ('{OtherRule:D}', '{OtherConnection:D}', '{M0SchemaSeed.Alpha.ItemId:D}', 'neighbour cursor', true);
            INSERT INTO pet_mailbox_seen (rule_id, connection_id, connection_revision, message_hash)
            VALUES ('{OtherRule:D}', '{OtherConnection:D}', '{M0SchemaSeed.Alpha.ItemId:D}', decode(repeat('a', 64), 'hex'));
            """);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Each_mailbox_table_forces_RLS()
    {
        await using var connection = await fixture.OpenMigratorConnectionAsync();
        foreach (var table in NixTables.ParentScoped)
        {
            Assert.Equal(1, await RawSql.CountAsync(connection, transaction: null, $"""
                SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relname = '{table}' AND c.relrowsecurity AND c.relforcerowsecurity
                """));
            Assert.Empty(await RawSql.TextListAsync(connection, $"""
                SELECT grantee || ':' || privilege_type FROM information_schema.table_privileges
                WHERE table_schema = 'public' AND table_name = '{table}' AND grantee IN ('PUBLIC', 'nix_collab')
                """));
        }
    }

    [Fact]
    public async Task Each_owner_reads_only_their_own_rows_without_a_parent_join()
    {
        var other = TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, OtherOwner);
        foreach (var (context, rule) in new[]
        {
            (TestTenants.AlphaContext, M0SchemaSeed.Alpha.GroupId),
            (TestTenants.BetaContext, M0SchemaSeed.Beta.GroupId),
            (other, OtherRule),
        })
        {
            await using var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
            foreach (var table in NixTables.ParentScoped)
            {
                var visible = await RawSql.GuidListAsync(Connection(work), Transaction(work), $"SELECT rule_id FROM {table}");
                Assert.Equal(rule, Assert.Single(visible));
            }
        }
    }

    [Fact]
    public async Task An_unscoped_session_reads_no_mailbox_rows()
    {
        await using var connection = await fixture.OpenApplicationConnectionAsync();
        foreach (var table in NixTables.ParentScoped)
        {
            Assert.Empty(await RawSql.GuidListAsync(connection, transaction: null, $"SELECT rule_id FROM {table}"));
        }
    }

    [Fact]
    public async Task The_owner_can_insert_and_save_the_current_checkpoint()
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var rows = M0SchemaSeed.Alpha;
        foreach (var table in NixTables.ParentScoped)
        {
            Assert.Equal(1, await RawSql.ExecuteAsync(Connection(work), Transaction(work),
                Insert(table, rows.GroupId, rows.ItemId, rows.AclEntryId)));
        }
        Assert.Equal(1, await RawSql.ExecuteAsync(Connection(work), Transaction(work), $"""
            INSERT INTO pet_mailbox_cursor (rule_id, connection_id, connection_revision, cursor, baselined)
            VALUES ('{rows.GroupId:D}', '{rows.ItemId:D}', '{rows.AclEntryId:D}', 'next cursor', true)
            ON CONFLICT (rule_id, connection_id, connection_revision) DO UPDATE SET cursor = excluded.cursor
            """));
        Assert.Equal("next cursor", await RawSql.TextAsync(Connection(work), Transaction(work), $"""
            SELECT cursor FROM pet_mailbox_cursor
            WHERE rule_id = '{rows.GroupId:D}' AND connection_id = '{rows.ItemId:D}'
            """));
    }

    [Fact]
    public async Task Foreign_or_mixed_tenant_parents_are_rejected_by_RLS()
    {
        foreach (var table in NixTables.ParentScoped)
        {
            await RefusedAsync(TestTenants.AlphaContext,
                Insert(table, M0SchemaSeed.Beta.GroupId, M0SchemaSeed.Beta.ItemId, M0SchemaSeed.Beta.AclEntryId));
            await RefusedAsync(TestTenants.AlphaContext,
                Insert(table, M0SchemaSeed.Beta.GroupId, M0SchemaSeed.Alpha.ItemId, M0SchemaSeed.Alpha.AclEntryId));
            await RefusedAsync(TestTenants.AlphaContext,
                Insert(table, M0SchemaSeed.Alpha.GroupId, M0SchemaSeed.Beta.ItemId, M0SchemaSeed.Beta.AclEntryId));
        }
    }

    [Theory]
    [InlineData(true, true)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    public async Task A_cursor_cannot_be_reparented_to_foreign_or_mixed_tenant_parents(bool foreignRule, bool foreignConnection)
    {
        var rule = foreignRule ? M0SchemaSeed.Beta : M0SchemaSeed.Alpha;
        var connection = foreignConnection ? M0SchemaSeed.Beta : M0SchemaSeed.Alpha;
        await RefusedAsync(TestTenants.AlphaContext, $"""
            UPDATE pet_mailbox_cursor SET rule_id = '{rule.GroupId:D}', connection_id = '{connection.ItemId:D}',
                connection_revision = '{connection.AclEntryId:D}'
            WHERE rule_id = '{M0SchemaSeed.Alpha.GroupId:D}' AND connection_id = '{M0SchemaSeed.Alpha.AclEntryId:D}'
            """);
    }

    [Fact]
    public async Task A_workspace_editor_cannot_insert_another_owners_mailbox_state()
    {
        var other = TestTenants.ContextFor(TestTenants.Alpha, TestTenants.AlphaWorkspace, OtherOwner);
        foreach (var table in NixTables.ParentScoped)
        {
            await RefusedAsync(other, Insert(table, M0SchemaSeed.Alpha.GroupId, M0SchemaSeed.Alpha.ItemId, M0SchemaSeed.Alpha.AclEntryId));
            await RefusedAsync(TestTenants.AlphaContext, Insert(table, OtherRule, OtherConnection, M0SchemaSeed.Alpha.ItemId));
        }
    }

    [Fact]
    public async Task A_checkpoint_for_a_different_connection_revision_is_rejected_by_RLS()
    {
        foreach (var table in NixTables.ParentScoped)
        {
            await RefusedAsync(TestTenants.AlphaContext,
                Insert(table, M0SchemaSeed.Alpha.GroupId, M0SchemaSeed.Alpha.AclEntryId, Guid.NewGuid()));
        }
    }

    [Theory]
    [MemberData(nameof(Tables))]
    public async Task Revoking_the_grant_hides_existing_state_and_refuses_new_state(string table)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        Assert.Single(await RawSql.GuidListAsync(Connection(work), Transaction(work), $"SELECT rule_id FROM {table}"));
        Assert.Equal(1, await RawSql.ExecuteAsync(Connection(work), Transaction(work), $"""
            UPDATE pet_connector_grant SET protected_tokens = NULL WHERE id = '{M0SchemaSeed.Alpha.AclEntryId:D}'
            """));
        Assert.Empty(await RawSql.GuidListAsync(Connection(work), Transaction(work), $"SELECT rule_id FROM {table}"));
        var failure = await Assert.ThrowsAsync<PostgresException>(() => RawSql.ExecuteAsync(Connection(work), Transaction(work),
            Insert(table, M0SchemaSeed.Alpha.GroupId, M0SchemaSeed.Alpha.AclEntryId, M0SchemaSeed.Alpha.ItemId)));
        Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, failure.SqlState);
    }

    private async Task RefusedAsync(NixSessionContext context, string statement)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        var failure = await Assert.ThrowsAsync<PostgresException>(() => RawSql.ExecuteAsync(Connection(work), Transaction(work), statement));
        Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, failure.SqlState);
    }

    private static NpgsqlConnection Connection(NixUnitOfWork work) => (NpgsqlConnection)work.DbContext.Database.GetDbConnection();

    private static NpgsqlTransaction Transaction(NixUnitOfWork work) => (NpgsqlTransaction)work.Transaction.GetDbTransaction();

    private static string Insert(string table, Guid ruleId, Guid connectionId, Guid revision) => table == NixTables.PetMailboxCursor
        ? $"""
            INSERT INTO pet_mailbox_cursor (rule_id, connection_id, connection_revision, cursor, baselined)
            VALUES ('{ruleId:D}', '{connectionId:D}', '{revision:D}', 'new cursor', true)
            """
        : $"""
            INSERT INTO pet_mailbox_seen (rule_id, connection_id, connection_revision, message_hash)
            VALUES ('{ruleId:D}', '{connectionId:D}', '{revision:D}', decode(repeat('b', 64), 'hex'))
            """;
}
