using Nix.Abstractions;
using Nix.Abstractions.Connections;
using Nix.Domain.Tenancy;
using Nix.Integration.Tests.Harness;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresCollectionDefinition.Name)]
public sealed class ConnectorStoreTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static readonly WorkspaceId Workspace = WorkspaceId.From(TestTenants.AlphaWorkspace);
    private static readonly Guid OtherOwner = new("1b1b1b1b-3333-4333-8333-1b1b1b1b1b1b");
    private static readonly Guid OtherWorkspace = new("1a1a1a1a-3333-4333-8333-1a1a1a1a1a1a");
    private const string Resource = "https://mcp.test/mcp#lookup";
    private const string InitialTokens = "protected initial tokens";
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Only_the_owner_in_the_selected_workspace_can_access_a_grant()
    {
        await SeedOtherScopesAsync();
        var grant = await ConnectAsync();
        NixSessionContext[] otherScopes =
        [
            TestTenants.BetaContext,
            TestTenants.ContextFor(TestTenants.Alpha, Workspace.Value, OtherOwner),
            TestTenants.ContextFor(TestTenants.Alpha, OtherWorkspace, TestTenants.AlphaPrincipal),
        ];

        foreach (var context in otherScopes)
        {
            await using var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
            var store = work.Resolve<IConnectorStore>();
            Assert.DoesNotContain(await store.ListAsync(Workspace, Cancellation), row => row.Id == grant.Id);
            Assert.Null(await store.GetAsync(Workspace, grant.Id, lockForUpdate: true, Cancellation));
            Assert.False(await store.DisconnectAsync(Workspace, grant.Id, Cancellation));
            await work.CommitAsync(Cancellation);
        }

        var listed = Assert.Single(await InSessionAsync(store => store.ListAsync(Workspace, Cancellation)),
            row => row.Id == grant.Id);
        Assert.Equal(Workspace, listed.WorkspaceId);
        Assert.Equal("mcp", listed.Provider);
        Assert.Equal("tool", listed.ResourceKind);
        Assert.Equal(Resource, listed.ResourceId);
        Assert.Equal(["remote.invoke"], listed.Actions);
        Assert.Null(listed.ProtectedTokens);
        Assert.Equal(InitialTokens, grant.ProtectedTokens);
    }

    [Fact]
    public async Task Saving_the_same_resource_again_replaces_its_credentials_under_a_new_revision()
    {
        var original = await ConnectAsync();
        Assert.True(await InSessionAsync(store => store.SaveScopedAsync(
            Workspace, "mcp", "tool", Resource, ["remote.invoke"], "protected renewed tokens", Cancellation)));
        var renewed = await InSessionAsync(store => store.GetAsync(Workspace, original.Id, lockForUpdate: true, Cancellation));
        Assert.NotNull(renewed);
        Assert.NotEqual(original.Revision, renewed.Revision);
        Assert.Equal("protected renewed tokens", renewed.ProtectedTokens);
    }

    [Fact]
    public async Task Disconnect_clears_credentials_and_hides_the_grant()
    {
        var granted = await ConnectAsync();

        Assert.True(await InSessionAsync(store => store.DisconnectAsync(Workspace, granted.Id, Cancellation)));
        Assert.False(await InSessionAsync(store => store.DisconnectAsync(Workspace, granted.Id, Cancellation)));

        var revoked = await InSessionAsync(
            store => store.GetAsync(Workspace, granted.Id, lockForUpdate: false, Cancellation));
        Assert.NotNull(revoked);
        Assert.NotEqual(granted.Revision, revoked.Revision);
        Assert.Empty(revoked.Actions);
        Assert.Null(revoked.ProtectedTokens);
        Assert.DoesNotContain(await InSessionAsync(store => store.ListAsync(Workspace, Cancellation)),
            row => row.Id == granted.Id);
    }

    private async Task SeedOtherScopesAsync()
    {
        await using var connection = await fixture.OpenMigratorConnectionAsync();
        await RawSql.ExecuteAsync(connection, transaction: null, $"""
            INSERT INTO principal
                (principal_id, tenant_id, external_subject, kind, display_name, email, status)
            VALUES ('{OtherOwner:D}', '{TestTenants.Alpha:D}', 'connector-neighbour', 'user', 'Neighbour',
                    'connector-neighbour@example.test', 'active');

            INSERT INTO workspace
                (workspace_id, tenant_id, name, version_retention_days, coalesce_window_min,
                 storage_quota_bytes, created_at)
            VALUES ('{OtherWorkspace:D}', '{TestTenants.Alpha:D}', 'Other workspace', 30, 10, 1073741824, now());

            INSERT INTO workspace_member
                (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            VALUES ('{Workspace.Value:D}', 'principal', '{OtherOwner:D}', '{TestTenants.Alpha:D}',
                    'owner', '{TestTenants.AlphaPrincipal:D}', now()),
                   ('{OtherWorkspace:D}', 'principal', '{TestTenants.AlphaPrincipal:D}', '{TestTenants.Alpha:D}',
                    'owner', '{TestTenants.AlphaPrincipal:D}', now());
            """);
    }

    private async Task<ConnectorGrant> ConnectAsync()
    {
        Assert.True(await InSessionAsync(store => store.SaveScopedAsync(
            Workspace, "mcp", "tool", Resource, ["remote.invoke"], InitialTokens, Cancellation)));
        var listed = Assert.Single(await InSessionAsync(store => store.ListAsync(Workspace, Cancellation)),
            row => row.ResourceId == Resource);
        var grant = await InSessionAsync(store => store.GetAsync(Workspace, listed.Id, lockForUpdate: false, Cancellation));
        Assert.NotNull(grant);
        return grant;
    }

    private async Task<T> InSessionAsync<T>(Func<IConnectorStore, Task<T>> action, NixSessionContext? context = null)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(context ?? TestTenants.AlphaContext, Cancellation);
        var result = await action(work.Resolve<IConnectorStore>());
        await work.CommitAsync(Cancellation);
        return result;
    }
}
