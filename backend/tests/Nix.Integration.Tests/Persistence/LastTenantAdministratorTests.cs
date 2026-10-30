using Nix.Features.Roles;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// The last-administrator guard counts only grants that can act, and serializes concurrent revokes.
/// </summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class LastTenantAdministratorTests : IAsyncLifetime
{
    private static readonly Guid Other = new("100000d0-1111-4111-8111-100000d00001");
    private static readonly Guid Member = new("100000d0-1111-4111-8111-100000d00002");
    private static readonly Guid Group = new("100000d0-1111-4111-8111-100000d00003");

    private readonly NixPostgresFixture _fixture;

    public LastTenantAdministratorTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task A_suspended_administrator_does_not_count()
    {
        await ExecuteAsync($"{PrincipalSql(Other, "suspended")} {AdminSql("principal", Other)}");

        Assert.Equal(TenantAdminErrors.LastAdministratorCode, await RevokeSelfAsync());
    }

    [Fact]
    public async Task A_deprovisioned_administrator_does_not_count()
    {
        await ExecuteAsync($"{PrincipalSql(Other, "deprovisioned")} {AdminSql("principal", Other)}");

        Assert.Equal(TenantAdminErrors.LastAdministratorCode, await RevokeSelfAsync());
    }

    [Fact]
    public async Task An_empty_administrator_group_does_not_count()
    {
        await ExecuteAsync($"{GroupSql()} {AdminSql("group", Group)}");

        Assert.Equal(TenantAdminErrors.LastAdministratorCode, await RevokeSelfAsync());
    }

    [Fact]
    public async Task An_administrator_group_holding_only_the_target_or_a_suspended_member_does_not_count()
    {
        await ExecuteAsync($"""
            {GroupSql()} {AdminSql("group", Group)} {PrincipalSql(Member, "suspended")}
            {MemberSql(M0SchemaSeed.Alpha.PrincipalId)} {MemberSql(Member)}
            """);

        Assert.Equal(TenantAdminErrors.LastAdministratorCode, await RevokeSelfAsync());
    }

    [Fact]
    public async Task An_administrator_group_with_another_active_member_counts()
    {
        await ExecuteAsync($"{GroupSql()} {AdminSql("group", Group)} {PrincipalSql(Member, "active")} {MemberSql(Member)}");

        Assert.Null(await RevokeSelfAsync());
    }

    [Fact]
    public async Task Two_administrators_revoking_each_other_cannot_both_succeed()
    {
        await ExecuteAsync($"{PrincipalSql(Other, "active")} {AdminSql("principal", Other)}");

        var first = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (first.ConfigureAwait(false))
        {
            var removed = await first.Resolve<NixDispatcher>().SendAsync<RevokeTenantAdmin, Guid>(
                new RevokeTenantAdmin(M0SchemaSeed.Alpha.PrincipalId), Cancellation);
            Assert.True(removed.IsSuccess);

            // The second revoke must wait on the first's lock rather than count the first's grant.
            var second = Task.Run(
                async () =>
                {
                    var context = TestTenants.ContextFor(M0SchemaSeed.Alpha.TenantId, null, Other);
                    var unit = await _fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
                    await using (unit.ConfigureAwait(false))
                    {
                        var result = await unit.Resolve<NixDispatcher>().SendAsync<RevokeTenantAdmin, Guid>(
                            new RevokeTenantAdmin(Other), Cancellation);
                        if (result.IsSuccess)
                        {
                            await unit.CommitAsync(Cancellation);
                        }

                        return result;
                    }
                },
                Cancellation);

            await Task.Delay(1000, Cancellation);
            Assert.False(second.IsCompleted, "the second revoke should block on the first's lock");

            await first.CommitAsync(Cancellation);
            var outcome = await second.WaitAsync(TimeSpan.FromSeconds(30), Cancellation);
            Assert.True(outcome.IsFailure);
            Assert.Equal(TenantAdminErrors.LastAdministratorCode, outcome.Error.Code);
        }
    }

    private static string PrincipalSql(Guid id, string status) => $"""
        INSERT INTO principal (principal_id, tenant_id, external_subject, kind, display_name, email, status, deprovisioned_at)
        VALUES ('{id:D}', '{M0SchemaSeed.Alpha.TenantId:D}', 'sub-{id:N}', 'user', 'P {id:N}', '{id:N}@example.test', '{status}', NULL);
        """;

    private static string GroupSql() => $"""
        INSERT INTO principal_group (group_id, tenant_id, name, external_id)
        VALUES ('{Group:D}', '{M0SchemaSeed.Alpha.TenantId:D}', 'admins', 'admins-ext');
        """;

    private static string MemberSql(Guid principal) => $"""
        INSERT INTO group_membership (group_id, principal_id, tenant_id, source)
        VALUES ('{Group:D}', '{principal:D}', '{M0SchemaSeed.Alpha.TenantId:D}', 'directory');
        """;

    private static string AdminSql(string subjectType, Guid subject) => $"""
        INSERT INTO tenant_role (tenant_id, subject_type, subject_id, role, granted_by, granted_at)
        VALUES ('{M0SchemaSeed.Alpha.TenantId:D}', '{subjectType}', '{subject:D}', 'admin', '{M0SchemaSeed.Alpha.PrincipalId:D}', now());
        """;

    /// <summary>The seeded administrator revokes their own role; returns the error code, or null on success.</summary>
    private async Task<string?> RevokeSelfAsync()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var result = await work.Resolve<NixDispatcher>().SendAsync<RevokeTenantAdmin, Guid>(
                new RevokeTenantAdmin(M0SchemaSeed.Alpha.PrincipalId), Cancellation);
            return result.IsSuccess ? null : result.Error.Code;
        }
    }

    private async Task ExecuteAsync(string sql)
    {
        var connection = await _fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, sql);
        }
    }
}
