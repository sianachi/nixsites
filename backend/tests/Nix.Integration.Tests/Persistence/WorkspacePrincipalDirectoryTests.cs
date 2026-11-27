using System.Text;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Integration.Tests.Harness;
using Nix.Persistence.Workspaces;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresSecondaryCollectionDefinition.Name)]
public sealed class WorkspacePrincipalDirectoryTests : IAsyncLifetime
{
    private static readonly Guid Direct = new("90909090-1111-4111-8111-909090909091");
    private static readonly Guid Group = new("90909090-1111-4111-8111-909090909092");
    private static readonly Guid Inactive = new("90909090-1111-4111-8111-909090909093");
    private static readonly Guid Revoked = new("90909090-1111-4111-8111-909090909094");
    private static readonly Guid OtherWorkspaceOnly = new("90909090-1111-4111-8111-909090909095");
    private static readonly Guid OtherWorkspace = new("90909090-1111-4111-8111-909090909096");
    private readonly NixPostgresFixture _fixture;
    private readonly ITestOutputHelper _output;

    public WorkspacePrincipalDirectoryTests(NixPostgresFixture fixture, ITestOutputHelper output)
    {
        _fixture = fixture;
        _output = output;
    }

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        await SeedDirectoryAsync();
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Lists_active_direct_and_group_members_once_and_excludes_inactive_revoked_other_workspace_and_other_tenant()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(Context(M0SchemaSeed.Alpha.PrincipalId), Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var store = work.Resolve<WorkspacePrincipalDirectoryStore>();
            var all = await store.ListAsync(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId), null, null, 100, Cancellation);
            Assert.Contains(all, principal => principal.PrincipalId.Value == Direct);
            Assert.Contains(all, principal => principal.PrincipalId.Value == Group);
            Assert.DoesNotContain(all, principal => principal.PrincipalId.Value == Inactive);
            Assert.DoesNotContain(all, principal => principal.PrincipalId.Value == Revoked);
            Assert.DoesNotContain(all, principal => principal.PrincipalId.Value == OtherWorkspaceOnly);
            Assert.DoesNotContain(all, principal => principal.PrincipalId.Value == M0SchemaSeed.Beta.PrincipalId);
            Assert.Equal(all.Count, all.Select(principal => principal.PrincipalId).Distinct().Count());

            var first = Assert.Single(await store.ListAsync(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId), "Group Person", null, 1, Cancellation));
            Assert.Equal(Group, first.PrincipalId.Value);

            var firstPage = await store.ListAsync(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId), null, null, 1, Cancellation);
            var secondPage = await store.ListAsync(
                WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId), null, firstPage[0].PrincipalId, 1, Cancellation);
            Assert.Single(firstPage);
            Assert.Single(secondPage);
            Assert.True(firstPage[0].PrincipalId.Value.CompareTo(secondPage[0].PrincipalId.Value) < 0);

        }

        var viewer = await _fixture.Application.BeginUnitOfWorkAsync(Context(Direct), Cancellation);
        await using (viewer.ConfigureAwait(false))
        {
            var inaccessible = await viewer.Resolve<WorkspacePrincipalDirectoryStore>()
                .ListAsync(WorkspaceId.From(OtherWorkspace), null, null, 100, Cancellation);
            Assert.Empty(inaccessible);
        }
    }

    [Fact]
    public async Task Directory_query_plan_uses_membership_indexes_for_a_realistic_paged_corpus()
    {
        const int corpusSize = 12_000;
        await SeedPlanCorpusAsync(corpusSize);
        var plan = await ExplainDirectoryQueryAsync(101);
        _output.WriteLine("EXPLAIN (ANALYZE, BUFFERS), workspace principal directory, {0} principals:{1}{2}",
            corpusSize, Environment.NewLine, plan);
        Assert.Contains("ix_workspace_member_actor_reach", plan, StringComparison.Ordinal);
        Assert.Contains("IX_group_membership_tenant_id_principal_id", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan on group_membership", plan, StringComparison.Ordinal);
    }

    private async Task SeedPlanCorpusAsync(int count)
    {
        var tenant = M0SchemaSeed.Alpha.TenantId;
        var workspace = M0SchemaSeed.Alpha.WorkspaceId;
        var actor = M0SchemaSeed.Alpha.PrincipalId;
        var group = M0SchemaSeed.Alpha.GroupId;
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, $$"""
                INSERT INTO principal
                    (principal_id, tenant_id, external_issuer, external_subject, kind, display_name, status)
                SELECT md5('directory-plan-' || n)::uuid, '{{tenant:D}}',
                       'https://directory-plan.alpha.test', 'principal-' || n, 'user', 'Directory person ' || n, 'active'
                FROM generate_series(1, {{count}}) n;

                INSERT INTO workspace_member
                    (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
                SELECT '{{workspace:D}}', 'principal', md5('directory-plan-' || n)::uuid, '{{tenant:D}}',
                       'viewer', '{{actor:D}}', now()
                FROM generate_series(1, {{count / 2}}) n;

                INSERT INTO group_membership (group_id, principal_id, tenant_id, source)
                SELECT '{{group:D}}', md5('directory-plan-' || n)::uuid, '{{tenant:D}}', 'directory'
                FROM generate_series({{count / 2 + 1}}, {{count}}) n;

                ANALYZE principal;
                ANALYZE workspace_member;
                ANALYZE principal_group;
                ANALYZE group_membership;
                """);
        }
    }

    private async Task<string> ExplainDirectoryQueryAsync(int limit)
    {
        var context = Context(M0SchemaSeed.Alpha.PrincipalId);
        var tenant = context.TenantId.Value;
        var workspace = WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId).Value;
        var connection = await _fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var transaction = await connection.BeginTransactionAsync(Cancellation);
            await using (transaction.ConfigureAwait(false))
            {
                await using (var setContext = new NpgsqlCommand(
                    "SELECT set_config('nix.tenant_id', @tenant, true), set_config('nix.principal_id', @principal, true)",
                    connection,
                    transaction))
                {
                    setContext.Parameters.Add(new NpgsqlParameter("tenant", NpgsqlDbType.Text)
                    {
                        Value = context.TenantId.Value.ToString("D"),
                    });
                    setContext.Parameters.Add(new NpgsqlParameter("principal", NpgsqlDbType.Text)
                    {
                        Value = context.PrincipalId.Value.ToString("D"),
                    });
                    await setContext.ExecuteNonQueryAsync(Cancellation);
                }

#pragma warning disable CA2100 // Justification: EXPLAIN wraps the production-owned static directory query.
                await using var command = new NpgsqlCommand(
                    "EXPLAIN (ANALYZE, BUFFERS) " + WorkspacePrincipalDirectorySql.List,
                    connection,
                    transaction);
#pragma warning restore CA2100
                command.Parameters.Add(new NpgsqlParameter("tenant_id", NpgsqlDbType.Uuid) { Value = tenant });
                command.Parameters.Add(new NpgsqlParameter("workspace_id", NpgsqlDbType.Uuid) { Value = workspace });
                command.Parameters.Add(new NpgsqlParameter("after_principal_id", NpgsqlDbType.Uuid) { Value = DBNull.Value });
                command.Parameters.Add(new NpgsqlParameter("query", NpgsqlDbType.Text) { Value = DBNull.Value });
                command.Parameters.Add(new NpgsqlParameter("limit", NpgsqlDbType.Integer) { Value = limit });
                command.Parameters.Add(new NpgsqlParameter("everyone", NpgsqlDbType.Boolean) { Value = true });
                command.Parameters.Add(new NpgsqlParameter("ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = Array.Empty<Guid>() });
                var plan = new StringBuilder();
                await using var reader = await command.ExecuteReaderAsync(Cancellation);
                while (await reader.ReadAsync(Cancellation))
                {
                    plan.AppendLine(reader.GetString(0));
                }

                return plan.ToString();
            }
        }
    }

    private async Task SeedDirectoryAsync()
    {
        var alpha = M0SchemaSeed.Alpha;
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, $"""
                INSERT INTO workspace (workspace_id, tenant_id, name, version_retention_days, coalesce_window_min,
                    storage_quota_bytes, created_at)
                VALUES ('{OtherWorkspace:D}', '{alpha.TenantId:D}', 'Other workspace', 30, 10, 1073741824, now());

                INSERT INTO principal
                    (principal_id, tenant_id, external_issuer, external_subject, kind, display_name, status)
                VALUES
                    ('{Direct:D}', '{alpha.TenantId:D}', 'https://issuer.alpha.test', 'directory-direct', 'user', 'Direct Person', 'active'),
                    ('{Group:D}', '{alpha.TenantId:D}', 'https://issuer.alpha.test', 'directory-group', 'user', 'Group Person', 'active'),
                    ('{Inactive:D}', '{alpha.TenantId:D}', 'https://issuer.alpha.test', 'directory-inactive', 'user', 'Inactive Person', 'suspended'),
                    ('{Revoked:D}', '{alpha.TenantId:D}', 'https://issuer.alpha.test', 'directory-revoked', 'user', 'Revoked Person', 'active'),
                    ('{OtherWorkspaceOnly:D}', '{alpha.TenantId:D}', 'https://issuer.alpha.test', 'directory-other-workspace', 'user', 'Other Workspace Person', 'active');

                INSERT INTO group_membership (group_id, principal_id, tenant_id, source)
                VALUES
                    ('{alpha.GroupId:D}', '{Group:D}', '{alpha.TenantId:D}', 'directory'),
                    ('{alpha.GroupId:D}', '{Inactive:D}', '{alpha.TenantId:D}', 'directory'),
                    ('{alpha.GroupId:D}', '{Revoked:D}', '{alpha.TenantId:D}', 'directory');

                INSERT INTO workspace_member
                    (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
                VALUES
                    ('{alpha.WorkspaceId:D}', 'group', '{alpha.GroupId:D}', '{alpha.TenantId:D}', 'editor', '{alpha.PrincipalId:D}', now()),
                    ('{alpha.WorkspaceId:D}', 'principal', '{Direct:D}', '{alpha.TenantId:D}', 'viewer', '{alpha.PrincipalId:D}', now()),
                    ('{OtherWorkspace:D}', 'principal', '{OtherWorkspaceOnly:D}', '{alpha.TenantId:D}', 'viewer', '{alpha.PrincipalId:D}', now());

                DELETE FROM group_membership
                WHERE tenant_id = '{alpha.TenantId:D}' AND group_id = '{alpha.GroupId:D}' AND principal_id = '{Revoked:D}';
                """);
        }
    }

    private static NixSessionContext Context(Guid principalId) => NixSessionContext.ForTenant(
        TenantId.From(M0SchemaSeed.Alpha.TenantId), PrincipalId.From(principalId));
}
