using System.Security.Cryptography;
using System.Text;
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
    private static readonly DateTimeOffset Now = new(2026, 11, 18, 10, 0, 0, TimeSpan.Zero);
    private const string Resource = "C123ABC456";
    private const string InitialTokens = "protected initial tokens";
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Only_the_owner_in_the_selected_workspace_can_access_a_grant_or_pending_state()
    {
        await SeedOtherScopesAsync();
        var grant = await ConnectAsync();
        var state = await BeginAsync("private pending state");
        NixSessionContext[] otherScopes =
        [
            TestTenants.BetaContext,
            TestTenants.ContextFor(TestTenants.Alpha, Workspace.Value, OtherOwner),
            TestTenants.ContextFor(TestTenants.Alpha, OtherWorkspace, TestTenants.AlphaPrincipal),
        ];

        foreach (var context in otherScopes)
        {
            await AssertHiddenAsync(context, grant, state);
        }

        var listed = Assert.Single(await InSessionAsync(store => store.ListAsync(Workspace, Cancellation)),
            row => row.Id == grant.Id);
        Assert.Equal(Workspace, listed.WorkspaceId);
        Assert.Equal("slack", listed.Provider);
        Assert.Equal("channel", listed.ResourceKind);
        Assert.Equal(Resource, listed.ResourceId);
        Assert.Equal(["slack.read_thread"], listed.Actions);
        Assert.Null(listed.ProtectedTokens);

        Assert.Equal(InitialTokens, (await InSessionAsync(
            store => store.GetAsync(Workspace, grant.Id, lockForUpdate: false, Cancellation)))?.ProtectedTokens);
        var attempt = await InSessionAsync(store => store.ConsumeOAuthAsync(state, Now, Cancellation));
        Assert.NotNull(attempt);
        foreach (var context in otherScopes)
        {
            Assert.False(await InSessionAsync(store => store.CompleteOAuthAsync(
                attempt, ["slack.reply"], "forbidden callback tokens", Cancellation), context));
        }
        Assert.True(await InSessionAsync(store => store.CompleteOAuthAsync(
            attempt, ["slack.read_thread"], InitialTokens, Cancellation)));
    }

    [Fact]
    public async Task Only_one_callback_can_consume_unexpired_OAuth_state()
    {
        var expired = await BeginAsync("expired state");
        Assert.Null(await InSessionAsync(
            store => store.ConsumeOAuthAsync(expired, Now.AddMinutes(5), Cancellation)));

        const string verifier = "protected active verifier";
        var state = await BeginAsync(verifier);
        var callbacks = await Task.WhenAll(
            InSessionAsync(store => store.ConsumeOAuthAsync(state, Now, Cancellation)),
            InSessionAsync(store => store.ConsumeOAuthAsync(state, Now, Cancellation)));
        var attempt = Assert.Single(callbacks.OfType<ConnectorPending>());
        Assert.Equal(Workspace, attempt.WorkspaceId);
        Assert.Equal("slack", attempt.Provider);
        Assert.Equal(state, attempt.StateHash);
        Assert.Equal(verifier, attempt.ProtectedState);
        Assert.Null(await InSessionAsync(store => store.ConsumeOAuthAsync(state, Now, Cancellation)));
        Assert.True(await InSessionAsync(store => store.CompleteOAuthAsync(
            attempt, ["slack.read_thread"], InitialTokens, Cancellation)));
        Assert.False(await InSessionAsync(store => store.CompleteOAuthAsync(
            attempt, ["slack.reply"], "stale callback tokens", Cancellation)));
    }

    [Fact]
    public async Task Reconnect_supersedes_pending_callbacks_and_fences_old_token_updates()
    {
        var original = await ConnectAsync();
        var replacedState = await BeginAsync("first reconnect");
        var replaced = await InSessionAsync(store => store.ConsumeOAuthAsync(replacedState, Now, Cancellation));
        Assert.NotNull(replaced);
        Assert.Equal(original.Id, replaced.ConnectionId);
        Assert.Equal(original.Revision, replaced.Revision);

        var newestState = await BeginAsync("second reconnect");
        var newest = await InSessionAsync(store => store.ConsumeOAuthAsync(newestState, Now, Cancellation));
        Assert.NotNull(newest);
        Assert.False(await InSessionAsync(store => store.CompleteOAuthAsync(
            replaced, ["slack.reply"], "superseded callback tokens", Cancellation)));
        Assert.Equal(InitialTokens, (await InSessionAsync(
            store => store.GetAsync(Workspace, original.Id, lockForUpdate: false, Cancellation)))?.ProtectedTokens);

        Assert.True(await InSessionAsync(store => store.CompleteOAuthAsync(
            newest, ["slack.reply"], "protected renewed tokens", Cancellation)));
        var renewed = await InSessionAsync(
            store => store.GetAsync(Workspace, original.Id, lockForUpdate: true, Cancellation));
        Assert.NotNull(renewed);
        Assert.NotEqual(original.Revision, renewed.Revision);
        Assert.Equal(["slack.reply"], renewed.Actions);
        Assert.Equal("protected renewed tokens", renewed.ProtectedTokens);
        Assert.False(await InSessionAsync(store => store.SaveTokensAsync(
            original.Id, original.Revision, "stale refresh tokens", Cancellation)));
        Assert.True(await InSessionAsync(store => store.SaveTokensAsync(
            renewed.Id, renewed.Revision, "protected refreshed tokens", Cancellation)));
        Assert.Equal("protected refreshed tokens", (await InSessionAsync(
            store => store.GetAsync(Workspace, renewed.Id, lockForUpdate: false, Cancellation)))?.ProtectedTokens);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Disconnect_clears_credentials_and_prevents_pending_callbacks_or_refreshes_from_restoring_them(
        bool callbackStarted)
    {
        var granted = await ConnectAsync();
        var pending = await BeginAsync("pending reconnect");
        var inFlight = callbackStarted
            ? await InSessionAsync(store => store.ConsumeOAuthAsync(pending, Now, Cancellation))
            : null;
        Assert.Equal(callbackStarted, inFlight is not null);

        Assert.True(await InSessionAsync(store => store.DisconnectAsync(Workspace, granted.Id, Cancellation)));
        Assert.False(await InSessionAsync(store => store.DisconnectAsync(Workspace, granted.Id, Cancellation)));
        Assert.Null(await InSessionAsync(store => store.ConsumeOAuthAsync(pending, Now, Cancellation)));
        if (inFlight is not null)
        {
            Assert.False(await InSessionAsync(store => store.CompleteOAuthAsync(
                inFlight, ["slack.reply"], "stale callback tokens", Cancellation)));
        }
        Assert.False(await InSessionAsync(store => store.SaveTokensAsync(
            granted.Id, granted.Revision, "stale refresh tokens", Cancellation)));

        var revoked = await InSessionAsync(
            store => store.GetAsync(Workspace, granted.Id, lockForUpdate: false, Cancellation));
        Assert.NotNull(revoked);
        Assert.NotEqual(granted.Revision, revoked.Revision);
        Assert.Empty(revoked.Actions);
        Assert.Null(revoked.ProtectedTokens);
        Assert.False(await InSessionAsync(store => store.SaveTokensAsync(
            revoked.Id, revoked.Revision, "unrequested replacement tokens", Cancellation)));
        Assert.DoesNotContain(await InSessionAsync(store => store.ListAsync(Workspace, Cancellation)),
            row => row.Id == granted.Id);
    }

    private async Task AssertHiddenAsync(NixSessionContext context, ConnectorGrant grant, string state)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        var store = work.Resolve<IConnectorStore>();
        Assert.Empty(await store.ListAsync(Workspace, Cancellation));
        Assert.Null(await store.GetAsync(Workspace, grant.Id, lockForUpdate: true, Cancellation));
        Assert.Null(await store.ConsumeOAuthAsync(state, Now, Cancellation));
        Assert.False(await store.SaveTokensAsync(grant.Id, grant.Revision, "forbidden tokens", Cancellation));
        Assert.False(await store.DisconnectAsync(Workspace, grant.Id, Cancellation));
        await work.CommitAsync(Cancellation);
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
        var state = await BeginAsync("initial authorization");
        var attempt = await InSessionAsync(store => store.ConsumeOAuthAsync(state, Now, Cancellation));
        Assert.NotNull(attempt);
        Assert.True(await InSessionAsync(store => store.CompleteOAuthAsync(
            attempt, ["slack.read_thread"], InitialTokens, Cancellation)));
        var grant = await InSessionAsync(
            store => store.GetAsync(Workspace, attempt.ConnectionId, lockForUpdate: false, Cancellation));
        Assert.NotNull(grant);
        return grant;
    }

    private async Task<string> BeginAsync(string protectedVerifier)
    {
        var state = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(protectedVerifier)));
        Assert.True(await InSessionAsync(store => store.BeginOAuthAsync(
            Workspace, "slack", "channel", Resource, state, protectedVerifier, Now.AddMinutes(5), Cancellation)));
        return state;
    }

    private async Task<T> InSessionAsync<T>(Func<IConnectorStore, Task<T>> action, NixSessionContext? context = null)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(context ?? TestTenants.AlphaContext, Cancellation);
        var result = await action(work.Resolve<IConnectorStore>());
        await work.CommitAsync(Cancellation);
        return result;
    }
}
