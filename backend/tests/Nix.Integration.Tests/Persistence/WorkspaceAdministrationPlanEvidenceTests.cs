using System.Globalization;
using System.Text;
using Nix.Integration.Tests.Harness;
using Nix.Persistence.Sql.Statements;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Integration.Tests.Persistence;

[Trait("Category", "PlanEvidence")]
[Collection(PostgresCollectionDefinition.Name)]
public sealed class WorkspaceAdministrationPlanEvidenceTests : IAsyncLifetime
{
    private const int CorpusSize = 10000;
    private static readonly Guid InviteeWorkspaceId = Guid.Parse("7d72f23f-a29b-44ba-bf7c-1c52f6a48672");
    private readonly NixPostgresFixture _fixture;
    private readonly ITestOutputHelper _output;

    public WorkspaceAdministrationPlanEvidenceTests(NixPostgresFixture fixture, ITestOutputHelper output)
    {
        _fixture = fixture;
        _output = output;
    }

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
        await SeedCorpusAsync();
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Workspace_hot_queries_use_their_ordered_and_partial_indexes()
    {
        await AssertWorkspaceListingPlanAsync();
        await AssertMemberListingPlanAsync();
        await AssertInviteeListingPlanAsync();
        await AssertLastOwnerAndEmailPlansAsync();
        await AssertInvitationPlansAsync();
    }

    private async Task AssertLastOwnerAndEmailPlansAsync()
    {
        const string lastOwner = """
            SELECT count(*)
            FROM workspace_member owner
            JOIN principal p ON p.tenant_id = owner.tenant_id AND p.principal_id = owner.subject_id
            WHERE owner.tenant_id = @tenant_id AND owner.workspace_id = @workspace_id
              AND owner.subject_type = 'principal' AND owner.role = 'owner'
              AND p.kind = 'user' AND p.status = 'active'
            """;
        var ownerPlan = await ExplainAsync(
            lastOwner,
            [Uuid("workspace_id", M0SchemaSeed.Alpha.WorkspaceId)]);
        Report("last active human owner", ownerPlan);
        Assert.Contains("ix_workspace_member_direct_owner", ownerPlan, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan on workspace_member owner", ownerPlan, StringComparison.Ordinal);

        const string exactEmail = """
            SELECT principal_id
            FROM principal
            WHERE tenant_id = @tenant_id AND kind = 'user' AND status = 'active'
              AND email_verified AND email_normalized = @email_normalized
            """;
        var emailPlan = await ExplainAsync(
            exactEmail,
            [Text("email_normalized", "plan-5000@example.test")]);
        Report("verified exact email", emailPlan);
        Assert.Contains("IX_principal_tenant_id_email_normalized", emailPlan, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan on principal", emailPlan, StringComparison.Ordinal);
    }

    private async Task AssertWorkspaceListingPlanAsync()
    {
        var plan = await ExplainAsync(
            WorkspaceAdministrationSql.List,
            [
                Uuid("principal_id", M0SchemaSeed.Alpha.PrincipalId),
                TimestampNull("after_created_at"), UuidNull("after_id"), Integer("limit", 51),
            ]);
        Report("workspace listing", plan);
        Assert.Contains("ix_workspace_list", plan, StringComparison.Ordinal);
        Assert.Contains("ix_workspace_invitation_pending_target", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan on workspace w", plan, StringComparison.Ordinal);
    }

    private async Task AssertInviteeListingPlanAsync()
    {
        var plan = await ExplainAsync(
            WorkspaceAdministrationSql.Invitees,
            [
                Uuid("principal_id", M0SchemaSeed.Alpha.PrincipalId),
                Uuid("workspace_id", InviteeWorkspaceId),
                UuidNull("after_id"), Integer("limit", 51), TextNull("query"),
            ]);
        Report("invitee listing", plan);
        Assert.Contains("AK_principal_tenant_id_principal_id", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan on principal candidate", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Sort", plan, StringComparison.Ordinal);
    }

    private async Task AssertMemberListingPlanAsync()
    {
        var plan = await ExplainAsync(
            WorkspaceAdministrationSql.Members,
            [
                Uuid("principal_id", M0SchemaSeed.Alpha.PrincipalId),
                Uuid("workspace_id", M0SchemaSeed.Alpha.WorkspaceId),
                TimestampNull("after_granted_at"), TextNull("after_subject_type"),
                UuidNull("after_id"), UuidNull("target_principal_id"), Integer("limit", 51),
            ]);
        Report("member listing", plan);
        Assert.Contains("ix_workspace_member_history", plan, StringComparison.Ordinal);
        Assert.Contains("ix_workspace_member_direct_owner", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan on workspace_member wm", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Sort", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Incremental Sort", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan on principal candidate", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("Bitmap Heap Scan on principal candidate", plan, StringComparison.Ordinal);
    }

    private async Task AssertInvitationPlansAsync()
    {
        var history = await ExplainAsync(
            WorkspaceAdministrationSql.Invitations,
            [
                Uuid("principal_id", M0SchemaSeed.Alpha.PrincipalId),
                Uuid("workspace_id", M0SchemaSeed.Alpha.WorkspaceId),
                TimestampNull("after_invited_at"), UuidNull("after_id"), Integer("limit", 51),
            ]);
        Report("invitation history", history);
        Assert.Contains("ix_workspace_invitation_history", history, StringComparison.Ordinal);

        const string redemption = """
            SELECT invitation_id
            FROM workspace_invitation
            WHERE tenant_id = @tenant_id AND email_normalized = @email_normalized
              AND status = 'pending'
            ORDER BY invited_at, invitation_id
            """;
        var redemptionPlan = await ExplainAsync(
            redemption,
            [Text("email_normalized", "invite-5000@example.test")]);
        Report("invitation redemption", redemptionPlan);
        Assert.Contains("ix_workspace_invitation_redemption", redemptionPlan, StringComparison.Ordinal);
        Assert.DoesNotContain("Seq Scan on workspace_invitation", redemptionPlan, StringComparison.Ordinal);
    }

    private async Task<string> ExplainAsync(string sql, IReadOnlyList<NpgsqlParameter> parameters)
    {
        var connection = await _fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var transaction = await connection.BeginTransactionAsync(TestContext.Current.CancellationToken);
            await using (transaction.ConfigureAwait(false))
            {
                var context = new NpgsqlCommand(
                    """
                    SELECT set_config('nix.tenant_id', @tenant, true),
                           set_config('nix.principal_id', @principal, true)
                    """,
                    connection,
                    transaction);
                await using (context.ConfigureAwait(false))
                {
                    context.Parameters.Add(Text("tenant", M0SchemaSeed.Alpha.TenantId.ToString("D", CultureInfo.InvariantCulture)));
                    context.Parameters.Add(Text("principal", M0SchemaSeed.Alpha.PrincipalId.ToString("D", CultureInfo.InvariantCulture)));
                    await context.ExecuteNonQueryAsync(TestContext.Current.CancellationToken);
                }

#pragma warning disable CA2100 // Justification: every statement is a production-owned static SQL constant.
                var command = new NpgsqlCommand("EXPLAIN (ANALYZE, BUFFERS) " + sql, connection, transaction);
#pragma warning restore CA2100
                await using (command.ConfigureAwait(false))
                {
                    command.Parameters.Add(Uuid("tenant_id", M0SchemaSeed.Alpha.TenantId));
                    foreach (var parameter in parameters)
                    {
                        command.Parameters.Add(parameter);
                    }

                    var plan = new StringBuilder();
                    var reader = await command.ExecuteReaderAsync(TestContext.Current.CancellationToken);
                    await using (reader.ConfigureAwait(false))
                    {
                        while (await reader.ReadAsync(TestContext.Current.CancellationToken))
                        {
                            plan.AppendLine(reader.GetString(0));
                        }
                    }

                    return plan.ToString();
                }
            }
        }
    }

    private void Report(string name, string plan) => _output.WriteLine(
        "EXPLAIN (ANALYZE, BUFFERS), {0}, {1} rows:{2}{3}",
        name, CorpusSize, Environment.NewLine, plan);

    private async Task SeedCorpusAsync()
    {
        var tenant = Literal(M0SchemaSeed.Alpha.TenantId);
        var workspace = Literal(M0SchemaSeed.Alpha.WorkspaceId);
        var principal = Literal(M0SchemaSeed.Alpha.PrincipalId);
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, null, $$"""
                INSERT INTO principal
                    (principal_id, tenant_id, external_issuer, external_subject, kind,
                     display_name, email, email_normalized, email_verified, status)
                SELECT md5('workspace-plan-principal-' || n)::uuid, {{tenant}},
                       'https://plan.alpha.test', 'subject-' || n, 'user', 'Plan user ' || n,
                       'plan-' || n || '@example.test', 'plan-' || n || '@example.test', true, 'active'
                FROM generate_series(1, {{CorpusSize}}) n;

                -- Include unverified people who are visible with disabled invitation eligibility.
                INSERT INTO principal
                    (principal_id, tenant_id, external_issuer, external_subject, kind,
                     display_name, email, email_normalized, email_verified, status)
                SELECT md5('workspace-plan-unverified-' || n)::uuid, {{tenant}},
                       'https://plan.alpha.test', 'unverified-' || n, 'user', 'Unverified user ' || n,
                       'unverified-' || n || '@example.test', NULL, false, 'active'
                FROM generate_series(1, {{CorpusSize}}) n;

                INSERT INTO workspace
                    (workspace_id, tenant_id, name, version_retention_days,
                     coalesce_window_min, storage_quota_bytes, created_at)
                SELECT md5('workspace-plan-' || n)::uuid, {{tenant}}, 'Plan workspace ' || n,
                       90, 10, 10737418240, now() - (n || ' seconds')::interval
                FROM generate_series(1, {{CorpusSize}}) n;

                INSERT INTO workspace
                    (workspace_id, tenant_id, name, version_retention_days,
                     coalesce_window_min, storage_quota_bytes, created_at)
                VALUES ({{Literal(InviteeWorkspaceId)}}, {{tenant}}, 'Invitee plan workspace',
                        90, 10, 10737418240, now());

                INSERT INTO workspace_member
                    (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
                SELECT {{workspace}}, 'principal', md5('workspace-plan-principal-' || n)::uuid,
                       {{tenant}}, CASE WHEN n = 1 THEN 'owner' ELSE 'viewer' END,
                       {{principal}}, TIMESTAMPTZ '2026-08-30 12:00:00+00'
                FROM generate_series(1, {{CorpusSize}}) n;

                INSERT INTO workspace_invitation
                    (invitation_id, tenant_id, workspace_id, email_normalized, target_principal_id, role,
                     invited_by_principal_id, status, invited_at)
                SELECT md5('workspace-plan-invitation-' || n)::uuid, {{tenant}}, {{workspace}},
                       'invite-' || n || '@example.test', md5('workspace-plan-principal-' || n)::uuid,
                       'viewer', {{principal}}, 'pending',
                       now() - (n || ' seconds')::interval
                FROM generate_series(1, {{CorpusSize}}) n;

                ANALYZE principal;
                ANALYZE workspace;
                ANALYZE workspace_member;
                ANALYZE workspace_invitation;
                """, commandTimeoutSeconds: 120);
        }
    }

    private static string Literal(Guid value) => $"'{value:D}'::uuid";
    private static NpgsqlParameter Uuid(string name, Guid value) => new(name, NpgsqlDbType.Uuid) { Value = value };
    private static NpgsqlParameter UuidNull(string name) => new(name, NpgsqlDbType.Uuid) { Value = DBNull.Value };
    private static NpgsqlParameter TimestampNull(string name) => new(name, NpgsqlDbType.TimestampTz) { Value = DBNull.Value };
    private static NpgsqlParameter Integer(string name, int value) => new(name, NpgsqlDbType.Integer) { Value = value };
    private static NpgsqlParameter Text(string name, string value) => new(name, NpgsqlDbType.Text) { Value = value };
    private static NpgsqlParameter TextNull(string name) => new(name, NpgsqlDbType.Text) { Value = DBNull.Value };
}
