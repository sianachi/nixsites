using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Nix.Integration.Tests.Harness;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The constraints of the agent-records tables (<c>item_reference</c>, <c>public_link</c>,
/// <c>record_key</c>) and the new file-version state column, proved as the runtime role on a
/// database built from migrations only. Tenant isolation and grants for these tables are covered
/// by <see cref="M0SchemaIsolationTests"/>, which iterates every tenant-scoped table.
/// </summary>
[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class AgentRecordsSchemaTests : IAsyncLifetime
{
    private const string UniqueViolation = "23505";
    private const string CheckViolation = "23514";
    private const string ForeignKeyViolation = "23503";
    private const string RowSecurityViolation = "42501";

    private static readonly M0TenantRows Alpha = M0SchemaSeed.Alpha;
    private static readonly M0TenantRows Beta = M0SchemaSeed.Beta;

    private readonly NixPostgresFixture _fixture;

    public AgentRecordsSchemaTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public Task A_record_key_value_is_unique_within_its_scope_and_field() =>
        ExpectAsync(
            $"INSERT INTO record_key (tenant_id, scope_item_id, field, value, item_id) VALUES ('{Alpha.TenantId}', '{Alpha.ItemId}', 'seed', 'alpha-key', '{Alpha.ItemId}')",
            UniqueViolation);

    [Fact]
    public Task A_record_key_value_is_bounded() =>
        ExpectAsync(
            $"INSERT INTO record_key (tenant_id, scope_item_id, field, value, item_id) VALUES ('{Alpha.TenantId}', '{Alpha.ItemId}', 'other', repeat('x', 2049), '{Alpha.ItemId}')",
            CheckViolation);

    [Fact]
    public Task An_item_can_have_only_one_active_public_link() =>
        ExpectAsync(
            $"INSERT INTO public_link (id, tenant_id, workspace_id, item_id, nonce, service_principal_id, created_by, created_at) VALUES (gen_random_uuid(), '{Alpha.TenantId}', '{Alpha.WorkspaceId}', '{Alpha.ItemId}', 'second', '{Alpha.PrincipalId}', '{Alpha.PrincipalId}', now())",
            UniqueViolation);

    [Fact]
    public async Task A_revoked_public_link_frees_the_item_for_a_new_one()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            await Exec(work, $"UPDATE public_link SET revoked_at = now() WHERE item_id = '{Alpha.ItemId}'");
            await Exec(work, $"INSERT INTO public_link (id, tenant_id, workspace_id, item_id, nonce, service_principal_id, created_by, created_at) VALUES (gen_random_uuid(), '{Alpha.TenantId}', '{Alpha.WorkspaceId}', '{Alpha.ItemId}', 'second', '{Alpha.PrincipalId}', '{Alpha.PrincipalId}', now())");
        }
    }

    [Fact]
    public async Task Two_unpinned_roleless_references_between_the_same_items_are_one_too_many()
    {
        // NULL role and NULL version must compare equal, or the unique edge would never bite.
        var insert = $"INSERT INTO item_reference (id, tenant_id, workspace_id, holder_item_id, target_item_id, created_by, created_at) VALUES (gen_random_uuid(), '{Alpha.TenantId}', '{Alpha.WorkspaceId}', '{Alpha.ItemId}', '{Alpha.ItemId}', '{Alpha.PrincipalId}', now())";
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            await Exec(work, insert);
            var failure = await Assert.ThrowsAnyAsync<Exception>(
                () => Exec(work, insert));
            Assert.Equal(UniqueViolation, SqlState(failure));
        }
    }

    [Fact]
    public Task A_reference_can_pin_only_a_version_of_its_target_item() =>
        // The seeded version belongs to Alpha's item; naming it against a different target fails the composite key.
        ExpectAsync(
            $"INSERT INTO item_reference (id, tenant_id, workspace_id, holder_item_id, target_item_id, target_file_version_id, created_by, created_at) VALUES (gen_random_uuid(), '{Alpha.TenantId}', '{Alpha.WorkspaceId}', '{Alpha.ItemId}', '{Alpha.ItemId}', gen_random_uuid(), '{Alpha.PrincipalId}', now())",
            ForeignKeyViolation);

    [Fact]
    public Task A_file_version_state_must_be_one_of_the_four() =>
        ExpectAsync(
            $"UPDATE file_version SET state = 'published' WHERE tenant_id = '{Alpha.TenantId}'",
            CheckViolation);

    [Fact]
    public async Task A_file_version_starts_as_a_draft_and_a_workspace_denies_agents_by_default()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var connection = (NpgsqlConnection)work.DbContext.Database.GetDbConnection();
            var transaction = (NpgsqlTransaction)work.Transaction.GetDbTransaction();
            Assert.Equal(
                "draft",
                await RawSql.TextAsync(connection, transaction, "SELECT state FROM file_version LIMIT 1"));
            Assert.Equal(
                "false|false",
                await RawSql.TextAsync(
                    connection,
                    transaction,
                    "SELECT agents_may_approve || '|' || agents_may_create_public_links FROM workspace LIMIT 1"));
        }
    }

    [Fact]
    public Task A_row_cannot_be_planted_under_another_tenant() =>
        ExpectAsync(
            $"INSERT INTO record_key (tenant_id, scope_item_id, field, value, item_id) VALUES ('{Beta.TenantId}', '{Beta.ItemId}', 'planted', 'x', '{Beta.ItemId}')",
            RowSecurityViolation);

    [Fact]
    public Task A_record_key_cannot_point_at_another_tenants_item() =>
        ExpectAsync(
            $"INSERT INTO record_key (tenant_id, scope_item_id, field, value, item_id) VALUES ('{Alpha.TenantId}', '{Beta.ItemId}', 'cross', 'x', '{Beta.ItemId}')",
            ForeignKeyViolation);

    [Fact]
    public async Task Deleting_a_workspace_removes_pins_and_version_bound_links_with_it()
    {
        var version = M0SchemaSeed.Alpha.TemplateSourceId;
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            await Exec(work, $"INSERT INTO item_reference (id, tenant_id, workspace_id, holder_item_id, target_item_id, target_file_version_id, role, created_by, created_at) VALUES (gen_random_uuid(), '{Alpha.TenantId}', '{Alpha.WorkspaceId}', '{Alpha.ItemId}', '{Alpha.ItemId}', '{version}', 'pin', '{Alpha.PrincipalId}', now())");
            await Exec(work, $"UPDATE public_link SET file_version_id = '{version}' WHERE item_id = '{Alpha.ItemId}'");

            // The statement shape of WorkspaceAdministrationSql.FinalizePurge, minus its job gate.
            var deleted = await Exec(work, $"DELETE FROM workspace w WHERE w.tenant_id = '{Alpha.TenantId}' AND w.workspace_id = '{Alpha.WorkspaceId}'");

            Assert.Equal(1, deleted);
            var connection = (NpgsqlConnection)work.DbContext.Database.GetDbConnection();
            var transaction = (NpgsqlTransaction)work.Transaction.GetDbTransaction();
            foreach (var table in new[] { "item_reference", "public_link", "record_key", "file_version" })
            {
                Assert.Equal(0, await RawSql.CountAsync(connection, transaction, $"SELECT count(*) FROM {table}"));
            }
        }
    }

    private static Task<int> Exec(NixUnitOfWork work, string sql) => RawSql.ExecuteAsync(
        (NpgsqlConnection)work.DbContext.Database.GetDbConnection(),
        (NpgsqlTransaction)work.Transaction.GetDbTransaction(),
        sql);

    private async Task ExpectAsync(string sql, string sqlState)
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var failure = await Assert.ThrowsAnyAsync<Exception>(
                () => Exec(work, sql));
            Assert.Equal(sqlState, SqlState(failure));
        }
    }

    private static string? SqlState(Exception failure) =>
        (failure as PostgresException ?? failure.InnerException as PostgresException)?.SqlState;
}
