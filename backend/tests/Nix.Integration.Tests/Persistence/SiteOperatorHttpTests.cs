using System.Net;
using Nix.Domain.Items;
using Nix.Integration.Tests.Harness;
using Npgsql;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Site approvers granted in Settings and tenant administrators managed over the API, through the
/// real pipeline: authorization is server-side, grants are tenant-scoped, and a database grant
/// never widens the instance-wide operator flag.
/// </summary>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class SiteOperatorHttpTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static readonly Dictionary<string, string?> Configured = new()
    {
        ["Nix:Sites:RequireOperatorApproval"] = "true",
        ["Nix:Sites:Operators:0"] = SiteScenario.Viewer.ToString(),
    };

    private SiteScenario _scenario = null!;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
        _scenario = await SiteScenario.CreateAsync(fixture);
    }

    public async ValueTask DisposeAsync() => await _scenario.DisposeAsync();

    [Fact]
    public async Task A_configured_operator_grants_lists_and_revokes_an_approver_and_each_change_is_audited()
    {
        await using var host = SiteHttpHost.Create(fixture, Configured);
        var viewer = await host.TokenAsync(SiteScenario.ViewerContext);
        var editor = await host.TokenAsync(SiteScenario.EditorContext);
        var path = $"/api/v1/sites/operators/{SiteScenario.Editor}";

        using (var denied = await host.SendAsync(HttpMethod.Get, "/api/v1/sites/operators", editor))
        {
            Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
            Assert.Equal("sites.operator_required", await SiteHttpHost.ProblemCodeAsync(denied));
        }

        using (var deniedWrite = await host.SendAsync(HttpMethod.Put, path, editor))
        {
            Assert.Equal(HttpStatusCode.Forbidden, deniedWrite.StatusCode);
        }

        // Twice: the second grant is a no-op and must not audit again.
        for (var attempt = 0; attempt < 2; attempt++)
        {
            using var granted = await host.SendAsync(HttpMethod.Put, path, viewer);
            Assert.Equal(HttpStatusCode.NoContent, granted.StatusCode);
        }

        using (var listed = await host.SendAsync(HttpMethod.Get, "/api/v1/sites/operators", viewer))
        {
            using var body = await SiteHttpHost.JsonAsync(listed);
            var rows = body.RootElement.GetProperty("operators").EnumerateArray().ToList();
            Assert.Equal(["configured", "granted"], rows.Select(row => row.GetProperty("source").GetString()));
            Assert.Equal(SiteScenario.Viewer, rows[0].GetProperty("principalId").GetGuid());
            Assert.Equal(SiteScenario.Editor, rows[1].GetProperty("principalId").GetGuid());
            Assert.Equal(SiteScenario.Viewer, rows[1].GetProperty("grantedBy").GetGuid());
        }

        // The granted approver can now read the queue (and so approve).
        using (var queue = await host.SendAsync(HttpMethod.Get, "/api/v1/sites/approvals", editor))
        {
            Assert.Equal(HttpStatusCode.OK, queue.StatusCode);
        }

        using (var configured = await host.SendAsync(HttpMethod.Delete, $"/api/v1/sites/operators/{SiteScenario.Viewer}", viewer))
        {
            Assert.Equal(HttpStatusCode.Conflict, configured.StatusCode);
            Assert.Equal("sites.operator_configured", await SiteHttpHost.ProblemCodeAsync(configured));
        }

        for (var attempt = 0; attempt < 2; attempt++)
        {
            using var revoked = await host.SendAsync(HttpMethod.Delete, path, viewer);
            Assert.Equal(HttpStatusCode.NoContent, revoked.StatusCode);
        }

        using (var after = await host.SendAsync(HttpMethod.Get, "/api/v1/sites/approvals", editor))
        {
            Assert.Equal(HttpStatusCode.Forbidden, after.StatusCode);
        }

        Assert.Equal(
            ["site.operator_granted", "site.operator_revoked"],
            await QueryAsync($"SELECT action FROM audit_event WHERE subject_id = '{SiteScenario.Editor}' ORDER BY occurred_at"));
    }

    [Fact]
    public async Task Only_a_principal_of_the_callers_tenant_can_be_granted()
    {
        await using var host = SiteHttpHost.Create(fixture, Configured);
        var viewer = await host.TokenAsync(SiteScenario.ViewerContext);

        foreach (var unknown in new[] { TestTenants.BetaPrincipal, Guid.NewGuid() })
        {
            using var response = await host.SendAsync(HttpMethod.Put, $"/api/v1/sites/operators/{unknown}", viewer);
            Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
            Assert.Equal("identity.principal_not_found", await SiteHttpHost.ProblemCodeAsync(response));
        }

        Assert.Equal(["0"], await QueryAsync("SELECT count(*)::text FROM site_operator"));
    }

    [Fact]
    public async Task A_granted_approver_approves_a_first_publish_but_is_not_an_instance_operator()
    {
        await using var host = SiteHttpHost.Create(fixture, Configured);
        var manager = await host.TokenAsync(SiteScenario.Manager);
        var viewer = await host.TokenAsync(SiteScenario.ViewerContext);
        var editor = await host.TokenAsync(SiteScenario.EditorContext);
        using (var created = await host.SendAsync(HttpMethod.Post, "/api/v1/sites", manager, new { rootItemId = ItemId.From(M0SchemaSeed.Alpha.ItemId).Value, slug = "granted", layout = "docs" }))
        {
            Assert.Equal(HttpStatusCode.Created, created.StatusCode);
            using var site = await SiteHttpHost.JsonAsync(created);
            var siteId = site.RootElement.GetProperty("id").GetGuid();
            using var requested = await host.SendAsync(HttpMethod.Post, $"/api/v1/sites/{siteId}/approval", manager, new { acknowledgeDisclosure = true });
            Assert.Equal(HttpStatusCode.OK, requested.StatusCode);

            using var granted = await host.SendAsync(HttpMethod.Put, $"/api/v1/sites/operators/{SiteScenario.Editor}", viewer);
            Assert.Equal(HttpStatusCode.NoContent, granted.StatusCode);

            using var approved = await host.SendAsync(HttpMethod.Post, $"/api/v1/sites/{siteId}/approval/approve", editor);
            Assert.Equal(HttpStatusCode.Accepted, approved.StatusCode);
            Assert.Equal([SiteScenario.Editor.ToString()], await QueryAsync($"SELECT actor_id::text FROM audit_event WHERE subject_id = '{siteId}' AND action = 'site.publish_approved'"));
        }

        using var me = await host.SendAsync(HttpMethod.Get, "/api/v1/me", editor);
        using var features = await SiteHttpHost.JsonAsync(me);
        var flags = features.RootElement.GetProperty("features");
        Assert.True(flags.GetProperty("siteApprover").GetBoolean());
        Assert.False(flags.GetProperty("operator").GetBoolean());
    }

    [Fact]
    public async Task Site_operator_rows_are_invisible_and_unwritable_across_tenants()
    {
        await Sql($"""
            INSERT INTO site_operator (tenant_id, principal_id, granted_by, granted_at)
            VALUES ('{TestTenants.Beta}', '{TestTenants.BetaPrincipal}', '{TestTenants.BetaPrincipal}', now()),
                   ('{TestTenants.Alpha}', '{TestTenants.AlphaPrincipal}', '{TestTenants.AlphaPrincipal}', now())
            """);
        var connection = await fixture.OpenApplicationConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            var transaction = await connection.BeginTransactionAsync(Cancellation);
            await using (transaction.ConfigureAwait(false))
            {
                await RawSql.ExecuteAsync(connection, transaction, $"SELECT set_config('nix.tenant_id', '{TestTenants.Alpha}', true)");
                Assert.Equal(1, await RawSql.CountAsync(connection, transaction, "SELECT count(*) FROM site_operator"));
                var planted = await Assert.ThrowsAsync<PostgresException>(() => RawSql.ExecuteAsync(
                    connection,
                    transaction,
                    $"INSERT INTO site_operator VALUES ('{TestTenants.Beta}', '{TestTenants.BetaPrincipal}', '{TestTenants.BetaPrincipal}', now())"));
                Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, planted.SqlState);
            }
        }
    }

    [Fact]
    public async Task An_administrator_manages_administrators_but_the_last_one_stays()
    {
        await using var host = SiteHttpHost.Create(fixture, Configured);
        var admin = await host.TokenAsync(SiteScenario.Manager);
        var editor = await host.TokenAsync(SiteScenario.EditorContext);
        var self = TestTenants.AlphaPrincipal;

        using (var notAdmin = await host.SendAsync(HttpMethod.Put, $"/api/v1/tenant/admins/{SiteScenario.Editor}", editor))
        {
            Assert.Equal(HttpStatusCode.Forbidden, notAdmin.StatusCode);
            Assert.Equal("roles.administrator_required", await SiteHttpHost.ProblemCodeAsync(notAdmin));
        }

        using (var hidden = await host.SendAsync(HttpMethod.Get, "/api/v1/tenant/roles", editor))
        {
            using var page = await SiteHttpHost.JsonAsync(hidden);
            Assert.Empty(page.RootElement.GetProperty("items").EnumerateArray());
        }

        using (var other = await host.SendAsync(HttpMethod.Put, $"/api/v1/tenant/admins/{TestTenants.BetaPrincipal}", admin))
        {
            Assert.Equal(HttpStatusCode.NotFound, other.StatusCode);
        }

        using (var last = await host.SendAsync(HttpMethod.Delete, $"/api/v1/tenant/admins/{self}", admin))
        {
            Assert.Equal(HttpStatusCode.Conflict, last.StatusCode);
            Assert.Equal("roles.last_administrator", await SiteHttpHost.ProblemCodeAsync(last));
        }

        for (var attempt = 0; attempt < 2; attempt++)
        {
            using var granted = await host.SendAsync(HttpMethod.Put, $"/api/v1/tenant/admins/{SiteScenario.Editor}", admin);
            Assert.Equal(HttpStatusCode.NoContent, granted.StatusCode);
        }

        using (var listed = await host.SendAsync(HttpMethod.Get, "/api/v1/tenant/roles", editor))
        {
            using var page = await SiteHttpHost.JsonAsync(listed);
            Assert.Equal(
                new[] { self, SiteScenario.Editor }.Order(),
                page.RootElement.GetProperty("items").EnumerateArray().Select(item => item.GetProperty("subjectId").GetGuid()).Order());
        }

        // Now there are two, so the original administrator may step down; the new one is the last.
        using (var stepDown = await host.SendAsync(HttpMethod.Delete, $"/api/v1/tenant/admins/{self}", admin))
        {
            Assert.Equal(HttpStatusCode.NoContent, stepDown.StatusCode);
        }

        using (var lastAgain = await host.SendAsync(HttpMethod.Delete, $"/api/v1/tenant/admins/{SiteScenario.Editor}", editor))
        {
            Assert.Equal(HttpStatusCode.Conflict, lastAgain.StatusCode);
        }

        Assert.Equal(
            ["tenant.admin_granted", "tenant.admin_revoked"],
            await QueryAsync("SELECT action FROM audit_event WHERE action LIKE 'tenant.admin%' ORDER BY occurred_at"));
    }

    private async Task Sql(string statement)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, statement);
        }
    }

    private async Task<List<string>> QueryAsync(string sql)
    {
        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            return [.. await RawSql.TextListAsync(connection, sql)];
        }
    }
}
