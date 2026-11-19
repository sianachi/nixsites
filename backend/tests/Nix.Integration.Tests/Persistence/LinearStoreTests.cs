using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Nix.Abstractions;
using Nix.Abstractions.Linear;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Features.Tokens;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

[Collection(PostgresCollectionDefinition.Name)]
public sealed class LinearStoreTests(NixPostgresFixture fixture) : IAsyncLifetime
{
    private static readonly WorkspaceId AlphaWorkspace = WorkspaceId.From(TestTenants.AlphaWorkspace);
    private static readonly PrincipalId AlphaOwner = PrincipalId.From(TestTenants.AlphaPrincipal);
    private static readonly ItemId AlphaItem = ItemId.From(M0SchemaSeed.Alpha.ItemId);
    private static readonly Guid Neighbour = new("1b1b1b1b-2222-4222-8222-1b1b1b1b1b1b");
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        await fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Linked_issue_is_owner_private_and_refresh_and_unlink_compare_the_reviewed_revision()
    {
        await M0SchemaSeed.SeedCurrentSchemaRowsAsync(fixture);
        var seeded = await InSessionAsync(TestTenants.AlphaContext,
            store => store.FindLinkAsync(AlphaWorkspace, AlphaItem, Cancellation));
        Assert.NotNull(seeded);
        Assert.Equal(LinearStatusChange.None, seeded.Compare(null));

        var neighbour = await SeedNeighbourAsync();
        Assert.Null(await InSessionAsync(TestTenants.BetaContext,
            store => store.FindLinkAsync(AlphaWorkspace, AlphaItem, Cancellation)));
        Assert.Null(await InSessionAsync(neighbour,
            store => store.FindLinkAsync(AlphaWorkspace, AlphaItem, Cancellation)));

        var refreshed = seeded with
        {
            Revision = Guid.CreateVersion7(),
            StatusId = Guid.CreateVersion7(),
            Status = "In progress",
            CheckedAt = seeded.CheckedAt.AddMinutes(1),
            RemoteUpdatedAt = seeded.RemoteUpdatedAt.AddMinutes(1),
        };
        Assert.True(await InSessionAsync(TestTenants.AlphaContext,
            store => store.UpdateLinkAsync(refreshed, seeded.Revision, Cancellation)));
        Assert.False(await InSessionAsync(TestTenants.AlphaContext,
            store => store.UpdateLinkAsync(seeded, seeded.Revision, Cancellation)));
        var current = await InSessionAsync(TestTenants.AlphaContext,
            store => store.FindLinkAsync(AlphaWorkspace, AlphaItem, Cancellation));
        Assert.NotNull(current);
        Assert.Equal(refreshed.CheckedAt, current.CheckedAt);
        Assert.Equal("In progress", current.Status);
        Assert.Equal(LinearStatusChange.Remote, current.Compare(null));
        Assert.Equal(LinearStatusChange.Conflict, current.Compare("Blocked"));
        Assert.Equal(LinearStatusChange.Local, seeded.Compare("Blocked"));
        Assert.False(await InSessionAsync(TestTenants.AlphaContext,
            store => store.DeleteLinkAsync(AlphaWorkspace, AlphaItem, seeded.Revision, Cancellation)));
        Assert.False(await InSessionAsync(neighbour,
            store => store.DeleteLinkAsync(AlphaWorkspace, AlphaItem, current.Revision, Cancellation)));
        Assert.True(await InSessionAsync(TestTenants.AlphaContext,
            store => store.DeleteLinkAsync(AlphaWorkspace, AlphaItem, current.Revision, Cancellation)));
    }

    [Fact]
    public async Task OAuth_state_is_consumed_once_and_disconnect_fences_older_callbacks_and_refreshes()
    {
        var now = DateTimeOffset.UtcNow;
        var neighbourContext = await SeedNeighbourAsync();
        var stateHash = HashState("first");
        Assert.True(await InSessionAsync(
            TestTenants.AlphaContext,
            store => store.BeginOAuthAsync(AlphaWorkspace, stateHash, "protected verifier", now.AddMinutes(5), Cancellation)));

        Assert.Null(await InSessionAsync(
            TestTenants.BetaContext,
            store => store.ConsumeOAuthAsync(stateHash, now, Cancellation)));
        Assert.Null(await InSessionAsync(
            neighbourContext,
            store => store.ConsumeOAuthAsync(stateHash, now, Cancellation)));

        var attempt = await InSessionAsync(
            TestTenants.AlphaContext,
            store => store.ConsumeOAuthAsync(stateHash, now, Cancellation));
        Assert.NotNull(attempt);
        Assert.Equal("protected verifier", attempt.ProtectedOAuthState);

        Assert.Null(await InSessionAsync(
            TestTenants.AlphaContext,
            store => store.ConsumeOAuthAsync(stateHash, now, Cancellation)));

        Assert.True(await InSessionAsync(
            TestTenants.AlphaContext,
            store => store.CompleteOAuthAsync(attempt, "first protected credentials", Cancellation)));

        var connection = await InSessionAsync(
            TestTenants.AlphaContext,
            store => store.FindConnectionAsync(AlphaWorkspace, Cancellation));
        Assert.NotNull(connection);
        Assert.Equal(AlphaOwner, connection.OwnerId);
        Assert.Equal("first protected credentials", connection.ProtectedOAuthState);
        Assert.Null(await InSessionAsync(
            TestTenants.BetaContext,
            store => store.FindConnectionAsync(AlphaWorkspace, Cancellation)));
        Assert.Null(await InSessionAsync(
            neighbourContext,
            store => store.FindConnectionAsync(AlphaWorkspace, Cancellation)));

        var expiredStateHash = HashState("expired");
        Assert.True(await InSessionAsync(
            TestTenants.AlphaContext,
            store => store.BeginOAuthAsync(AlphaWorkspace, expiredStateHash, "expired verifier", now.AddMinutes(5), Cancellation)));
        Assert.Null(await InSessionAsync(
            TestTenants.AlphaContext,
            store => store.ConsumeOAuthAsync(expiredStateHash, now.AddMinutes(6), Cancellation)));

        Assert.True(await InSessionAsync(
            TestTenants.AlphaContext,
            store => store.DisconnectAsync(AlphaWorkspace, Cancellation)));

        var renewed = await ConnectAsync(now);
        Assert.Equal("protected credentials", renewed.ProtectedOAuthState);

        Assert.False(await InSessionAsync(
            TestTenants.AlphaContext,
            store => store.CompleteOAuthAsync(attempt, "stale callback credentials", Cancellation)));
        Assert.False(await InSessionAsync(
            TestTenants.AlphaContext,
            store => store.SaveOAuthAsync(connection.Id, connection.Revision, "stale refresh credentials", Cancellation)));

        var current = await InSessionAsync(
            TestTenants.AlphaContext,
            store => store.FindConnectionAsync(AlphaWorkspace, Cancellation));
        Assert.Equal("protected credentials", current?.ProtectedOAuthState);
    }

    [Fact]
    public async Task Only_the_requesting_token_sees_its_lookup_and_only_one_approval_can_publish_a_result()
    {
        var now = DateTimeOffset.UtcNow;
        var connection = await ConnectAsync(now);
        var requesterToken = await MintAsync("claude");
        var otherToken = await MintAsync("codex");
        var request = new LinearTaskRequest(
            Guid.NewGuid(),
            AlphaItem,
            connection.Id,
            connection.Revision,
            AlphaOwner,
            requesterToken,
            "ENG-123",
            "pending",
            now,
            now.AddMinutes(5),
            null,
            null);
        Assert.True(await InSessionAsync(
            TestTenants.AlphaContext,
            store => store.CreateRequestAsync(request, Cancellation)));

        Assert.Null(await InSessionAsync(
            TestTenants.AlphaContext,
            store => store.FindRequestAsync(AlphaItem, request.Id, otherToken, Cancellation)));
        Assert.Empty(await InSessionAsync(
            TestTenants.AlphaContext,
            store => store.ListRequestsAsync(AlphaItem, otherToken, Cancellation)));
        Assert.Null(await InSessionAsync(
            TestTenants.BetaContext,
            store => store.DecideAsync(AlphaItem, request.Id, true, now, Cancellation)));

        var decisions = await Task.WhenAll(
            InSessionAsync(
                TestTenants.AlphaContext,
                store => store.DecideAsync(AlphaItem, request.Id, true, now, Cancellation)),
            InSessionAsync(
                TestTenants.AlphaContext,
                store => store.DecideAsync(AlphaItem, request.Id, true, now, Cancellation)));
        var approved = Assert.Single(decisions.OfType<LinearTaskRequest>());
        Assert.Equal("running", approved.Status);
        Assert.Equal(AlphaOwner, approved.ApproverId);

        Assert.True(await InSessionAsync(
            TestTenants.AlphaContext,
            store => store.FinishAsync(request.Id, "succeeded", """{"id":"ENG-123","title":"Fixture issue","status":"Open","url":"https://linear.app/fixture/issue/ENG-123"}""", Cancellation)));
        Assert.False(await InSessionAsync(
            TestTenants.AlphaContext,
            store => store.FinishAsync(request.Id, "succeeded", """{"id":"ENG-999","title":"Other issue","status":"Open","url":"https://linear.app/fixture/issue/ENG-999"}""", Cancellation)));

        var result = await InSessionAsync(
            TestTenants.AlphaContext,
            store => store.FindRequestAsync(AlphaItem, request.Id, requesterToken, Cancellation));
        Assert.NotNull(result);
        Assert.Equal("succeeded", result.Status);
        Assert.NotNull(result.ResultJson);
        using var payload = JsonDocument.Parse(result.ResultJson);
        Assert.Equal("ENG-123", payload.RootElement.GetProperty("id").GetString());

        Assert.Null(await InSessionAsync(
            TestTenants.AlphaContext,
            store => store.FindRequestAsync(AlphaItem, request.Id, otherToken, Cancellation)));

        var secondRequest = request with { Id = Guid.NewGuid(), RequesterTokenId = otherToken };
        Assert.True(await InSessionAsync(
            TestTenants.AlphaContext,
            store => store.CreateRequestAsync(secondRequest, Cancellation)));
        Assert.Null(await InSessionAsync(
            TestTenants.AlphaContext,
            store => store.DecideAsync(AlphaItem, secondRequest.Id, true, now.AddMinutes(6), Cancellation)));

        await using (var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation))
        {
            var revoked = await work.Resolve<NixDispatcher>().SendAsync<RevokeAccessToken, bool>(
                new RevokeAccessToken(PersonalAccessTokenId.From(otherToken)),
                Cancellation);
            Assert.True(revoked.IsSuccess && revoked.Value);
            await work.CommitAsync(Cancellation);
        }

        Assert.Null(await InSessionAsync(
            TestTenants.AlphaContext,
            store => store.DecideAsync(AlphaItem, secondRequest.Id, true, now, Cancellation)));

        Assert.True(await InSessionAsync(
            TestTenants.AlphaContext,
            store => store.DisconnectAsync(AlphaWorkspace, Cancellation)));
        var disconnected = await InSessionAsync(
            TestTenants.AlphaContext,
            store => store.FindRequestAsync(AlphaItem, request.Id, requesterToken, Cancellation));
        Assert.NotNull(disconnected);
        Assert.Null(disconnected.ResultJson);
    }

    [Fact]
    public async Task Only_a_browser_pet_lookup_can_record_a_single_comment_receipt()
    {
        var now = DateTimeOffset.UtcNow;
        var context = TestTenants.AlphaContext;
        var connection = await ConnectAsync(now);
        var token = await MintAsync("claude");
        var petId = Guid.NewGuid();
        var commentId = Guid.NewGuid();
        const string petName = "Juniper";
        const string resultJson = """{"id":"ENG-123","title":"Fixture issue","status":"Open","url":"https://linear.app/fixture/issue/ENG-123"}""";
        var request = new LinearTaskRequest(
            Guid.NewGuid(), AlphaItem, connection.Id, connection.Revision, AlphaOwner, null,
            "ENG-123", "pending", now, now.AddMinutes(5), null, null, PetId: petId, PetName: petName);
        var tokenPetRequest = request with { Id = Guid.NewGuid(), RequesterTokenId = token };

        Assert.False(await InSessionAsync(context, store => store.CreateRequestAsync(tokenPetRequest, Cancellation)));
        Assert.Null(await InSessionAsync(
            context, store => store.FindRequestAsync(AlphaItem, tokenPetRequest.Id, null, Cancellation)));

        var ordinaryRequest = tokenPetRequest with { Id = Guid.NewGuid(), PetId = null, PetName = null };
        Assert.True(await InSessionAsync(context, store => store.CreateRequestAsync(ordinaryRequest, Cancellation)));
        var ordinaryApproval = await InSessionAsync(
            context, store => store.DecideAsync(AlphaItem, ordinaryRequest.Id, true, now, Cancellation));
        Assert.NotNull(ordinaryApproval);
        Assert.False(await InSessionAsync(
            context, store => store.FinishAsync(ordinaryRequest.Id, "succeeded", resultJson, Cancellation, commentId)));
        var ordinaryReceipt = await InSessionAsync(
            context, store => store.FindRequestAsync(AlphaItem, ordinaryRequest.Id, token, Cancellation));
        Assert.NotNull(ordinaryReceipt);
        Assert.Equal("running", ordinaryReceipt.Status);
        Assert.Null(ordinaryReceipt.CommentId);

        Assert.True(await InSessionAsync(context, store => store.CreateRequestAsync(request, Cancellation)));
        var pending = await InSessionAsync(context, store => store.FindRequestAsync(AlphaItem, request.Id, null, Cancellation));
        Assert.NotNull(pending);
        Assert.Equal("pending", pending.Status);
        Assert.Equal(petId, pending.PetId);
        Assert.Equal(petName, pending.PetName);
        Assert.Null(pending.CommentId);

        var approved = await InSessionAsync(context, store => store.DecideAsync(AlphaItem, request.Id, true, now, Cancellation));
        Assert.NotNull(approved);
        Assert.Equal("running", approved.Status);
        Assert.Equal(AlphaOwner, approved.ApproverId);
        Assert.Equal(petId, approved.PetId);
        Assert.Equal(petName, approved.PetName);

        Assert.True(await InSessionAsync(
            context, store => store.FinishAsync(request.Id, "succeeded", resultJson, Cancellation, commentId)));
        Assert.False(await InSessionAsync(
            context, store => store.FinishAsync(request.Id, "succeeded", resultJson, Cancellation, Guid.NewGuid())));

        var receipt = await InSessionAsync(context, store => store.FindRequestAsync(AlphaItem, request.Id, null, Cancellation));
        Assert.NotNull(receipt);
        Assert.Equal("succeeded", receipt.Status);
        Assert.Equal(petId, receipt.PetId);
        Assert.Equal(petName, receipt.PetName);
        Assert.Equal(commentId, receipt.CommentId);
        Assert.NotNull(receipt.ResultJson);
        using var payload = JsonDocument.Parse(receipt.ResultJson);
        Assert.Equal("ENG-123", payload.RootElement.GetProperty("id").GetString());
    }

    private async Task<LinearConnection> ConnectAsync(DateTimeOffset now)
    {
        var stateHash = HashState("connect");
        Assert.True(await InSessionAsync(
            TestTenants.AlphaContext,
            store => store.BeginOAuthAsync(AlphaWorkspace, stateHash, "protected verifier", now.AddMinutes(5), Cancellation)));
        var attempt = await InSessionAsync(
            TestTenants.AlphaContext,
            store => store.ConsumeOAuthAsync(stateHash, now, Cancellation));
        Assert.NotNull(attempt);
        Assert.True(await InSessionAsync(
            TestTenants.AlphaContext,
            store => store.CompleteOAuthAsync(attempt, "protected credentials", Cancellation)));
        var connection = await InSessionAsync(
            TestTenants.AlphaContext,
            store => store.FindConnectionAsync(AlphaWorkspace, Cancellation));
        Assert.NotNull(connection);
        return connection;
    }

    private async Task<Guid> MintAsync(string name)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        var result = await work.Resolve<NixDispatcher>().SendAsync<CreateAccessToken, IssuedAccessToken>(
            new CreateAccessToken(name, [AccessTokenScopes.Write], 30),
            Cancellation);
        Assert.True(result.IsSuccess, result.IsFailure ? result.Error.Message : string.Empty);
        await work.CommitAsync(Cancellation);
        return result.Value.Row.Id.Value;
    }

    private async Task<NixSessionContext> SeedNeighbourAsync()
    {
        await using var connection = await fixture.OpenMigratorConnectionAsync();
        await RawSql.ExecuteAsync(connection, transaction: null, $"""
            INSERT INTO principal
                (principal_id, tenant_id, external_subject, kind, display_name, email, status)
            VALUES ('{Neighbour:D}', '{TestTenants.Alpha:D}', 'linear-neighbour', 'user', 'Neighbour',
                    'linear-neighbour@example.test', 'active');

            INSERT INTO workspace_member
                (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            VALUES ('{AlphaWorkspace.Value:D}', 'principal', '{Neighbour:D}', '{TestTenants.Alpha:D}',
                    'editor', '{AlphaOwner.Value:D}', now());
            """);
        return TestTenants.ContextFor(TestTenants.Alpha, AlphaWorkspace.Value, Neighbour);
    }

    private async Task<T> InSessionAsync<T>(NixSessionContext context, Func<ILinearStore, Task<T>> action)
    {
        await using var work = await fixture.Application.BeginUnitOfWorkAsync(context, Cancellation);
        var result = await action(work.Resolve<ILinearStore>());
        await work.CommitAsync(Cancellation);
        return result;
    }

    private static string HashState(string state) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(state)));
}
