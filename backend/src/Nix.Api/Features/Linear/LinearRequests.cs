using System.Diagnostics.CodeAnalysis;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Nix.Abstractions;
using Nix.Abstractions.Linear;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Features.PetRuns;
using Nix.Messaging;

namespace Nix.Features.Linear;

[SuppressMessage("Performance", "CA1812", Justification = "Created by ASP.NET Core dependency injection.")]
internal sealed partial class LinearRequests(
    ILinearStore store,
    INixSessionContextAccessor session,
    IVisibleItems visible,
    IPermissionResolver permissions,
    IItemLocks locks,
    IPersonalAccessTokens tokens,
    LinearOAuth oauth,
    LinearWorkerClient worker,
    IIsolatedUnitOfWork isolated,
    NixDispatcher dispatcher,
    TimeProvider clock,
    IConfiguration configuration) :
    IQueryHandler<ListLinearRequests, Result<LinearRequestsResponse>>,
    IQueryHandler<GetLinearIssueRequest, Result<LinearRequestResponse>>,
    ICommandHandler<RequestLinearIssue, LinearRequestResponse>,
    ICommandHandler<HandToPetCommand, LinearRequestResponse>,
    ICommandHandler<DecideLinearIssueRequestCommand, LinearRequestResponse>
{
    private static readonly TimeSpan RequestLifetime = TimeSpan.FromMinutes(15);
    private NixSessionContext Session => session.Current ?? throw new InvalidOperationException("The Linear request requires a unit of work.");

    public async ValueTask<Result<LinearRequestsResponse>> HandleAsync(ListLinearRequests query, CancellationToken token)
    {
        var item = await ReadTaskAsync(query.ItemId, token).ConfigureAwait(false);
        if (item is null || !await permissions.CanManageWorkspaceAsync(item.WorkspaceId, token).ConfigureAwait(false))
        {
            return Result.Failure<LinearRequestsResponse>(LinearErrors.Missing());
        }

        var connection = await store.FindConnectionAsync(item.WorkspaceId, token).ConfigureAwait(false);
        var requests = await store.ListRequestsAsync(query.ItemId, query.TokenId, token).ConfigureAwait(false);
        var labels = await LabelsAsync(token).ConfigureAwait(false);
        return Result.Success(new LinearRequestsResponse(
            [.. requests.Select(row => ToResponse(row, connection, query.TokenId, labels))],
            query.TokenId is null && connection?.ProtectedOAuthState is not null
                && CanUsePetTask(item) && CanLeaveComment(item)));
    }

    public async ValueTask<Result<LinearRequestResponse>> HandleAsync(GetLinearIssueRequest query, CancellationToken token)
    {
        var item = await ReadTaskAsync(query.ItemId, token).ConfigureAwait(false);
        if (item is null || !await permissions.CanManageWorkspaceAsync(item.WorkspaceId, token).ConfigureAwait(false))
        {
            return Result.Failure<LinearRequestResponse>(LinearErrors.Missing());
        }

        var request = await store.FindRequestAsync(query.ItemId, query.RequestId, query.TokenId, token).ConfigureAwait(false);
        if (request is null)
        {
            return Result.Failure<LinearRequestResponse>(LinearErrors.Missing());
        }

        var connection = await store.FindConnectionAsync(item.WorkspaceId, token).ConfigureAwait(false);
        return Result.Success(ToResponse(request, connection, query.TokenId, await LabelsAsync(token).ConfigureAwait(false)));
    }

    public ValueTask<Result<LinearRequestResponse>> HandleAsync(RequestLinearIssue command, CancellationToken token) =>
        QueueAsync(command.ItemId, command.IssueId, command.TokenId, petId: null, token);

    public ValueTask<Result<LinearRequestResponse>> HandleAsync(HandToPetCommand command, CancellationToken token) =>
        QueueAsync(command.ItemId, command.IssueId, tokenId: null, command.PetId, token);

    private async ValueTask<Result<LinearRequestResponse>> QueueAsync(
        ItemId itemId, string issueId, Guid? tokenId, Guid? petId, CancellationToken token)
    {
        var issue = issueId?.Trim();
        if (issue is null || !IsIssueIdentifier(issue))
        {
            return Result.Failure<LinearRequestResponse>(LinearErrors.InvalidIssue());
        }

        var item = await ReadTaskAsync(itemId, token).ConfigureAwait(false);
        if (item is null || !await permissions.CanManageWorkspaceAsync(item.WorkspaceId, token).ConfigureAwait(false))
        {
            return Result.Failure<LinearRequestResponse>(LinearErrors.Missing());
        }

        var connection = await store.FindConnectionAsync(item.WorkspaceId, token).ConfigureAwait(false);
        if (connection?.ProtectedOAuthState is null || connection.OwnerId != Session.PrincipalId)
        {
            return Result.Failure<LinearRequestResponse>(LinearErrors.Unavailable());
        }

        string? petName = null;
        if (petId is { } selectedPetId)
        {
            if (!CanUsePetTask(item))
            {
                return Result.Failure<LinearRequestResponse>(LinearErrors.Missing());
            }
            if (!CanLeaveComment(item))
            {
                return Result.Failure<LinearRequestResponse>(LinearErrors.CommentsRequired());
            }

            if (await FindEnabledPetAsync(selectedPetId, token).ConfigureAwait(false) is not { } pet)
            {
                return Result.Failure<LinearRequestResponse>(LinearErrors.InvalidPet());
            }

            petName = pet.Name.Trim();
        }

        var now = clock.GetUtcNow();
        var request = new LinearTaskRequest(
            Guid.NewGuid(), item.Id, connection.Id, connection.Revision, Session.PrincipalId, tokenId,
            issue.ToUpperInvariant(), LinearRequestStatus.Pending, now, now.Add(RequestLifetime), null, null, PetId: petId, PetName: petName);

        if (!await store.CreateRequestAsync(request, token).ConfigureAwait(false))
        {
            return Result.Failure<LinearRequestResponse>(LinearErrors.Ended());
        }

        return Result.Success(ToResponse(request, connection, tokenId, await LabelsAsync(token).ConfigureAwait(false)));
    }

    public async ValueTask<Result<LinearRequestResponse>> HandleAsync(DecideLinearIssueRequestCommand command, CancellationToken token)
    {
        var caller = Session;
        var claimed = await isolated.RunAsync(caller, async (services, ct) =>
        {
            var handler = services.GetRequiredService<LinearRequests>();
            var result = await handler.ClaimAsync(command, ct).ConfigureAwait(false);
            return new IsolatedOutcome<Result<LinearTaskRequest>>(result, Commit: result.IsSuccess);
        }, token).ConfigureAwait(false);
        if (claimed.IsFailure)
        {
            return Result.Failure<LinearRequestResponse>(claimed.Error);
        }

        if (claimed.Value.Status == LinearRequestStatus.Running)
        {
            // The decision commits before touching Linear. A closed browser cannot cancel the
            // receipt. A stopped Core leaves an unknown outcome without a second dispatch.
            var lookup = await isolated.RunAsync(caller, async (services, ct) =>
            {
                var result = await services.GetRequiredService<LinearRequests>()
                    .ExecuteAsync(claimed.Value, command.Callback, ct).ConfigureAwait(false);
                return new IsolatedOutcome<PetLookup?>(result, Commit: true);
            }, CancellationToken.None).ConfigureAwait(false);

            if (lookup is { } completed)
            {
                await RunPetHandoffAsync(caller, claimed.Value, completed).ConfigureAwait(false);
            }
        }

        return await isolated.RunAsync(caller, async (services, ct) =>
        {
            var query = new GetLinearIssueRequest(command.ItemId, command.RequestId, null);
            var receipt = await services.GetRequiredService<LinearRequests>().HandleAsync(query, ct).ConfigureAwait(false);
            return new IsolatedOutcome<Result<LinearRequestResponse>>(receipt, Commit: false);
        }, token).ConfigureAwait(false);
    }

    private async Task<Result<LinearTaskRequest>> ClaimAsync(DecideLinearIssueRequestCommand command, CancellationToken token)
    {
        var item = await ReadTaskAsync(command.ItemId, token).ConfigureAwait(false);
        if (item is null || !await permissions.CanManageWorkspaceAsync(item.WorkspaceId, token).ConfigureAwait(false))
        {
            return Result.Failure<LinearTaskRequest>(LinearErrors.Missing());
        }

        var request = await store.FindRequestAsync(command.ItemId, command.RequestId, null, token).ConfigureAwait(false);
        if (request is null || request.RequesterId != Session.PrincipalId
            || command.Approve && request.PetId.HasValue && !CanUsePetTask(item))
        {
            return Result.Failure<LinearTaskRequest>(LinearErrors.Missing());
        }

        if (command.Approve && !await RequesterIsCurrentAsync(request, token).ConfigureAwait(false))
        {
            return Result.Failure<LinearTaskRequest>(LinearErrors.Ended());
        }

        var decided = await store.DecideAsync(
            command.ItemId, command.RequestId, command.Approve, clock.GetUtcNow(), token).ConfigureAwait(false);
        return decided is null ? Result.Failure<LinearTaskRequest>(LinearErrors.Ended()) : Result.Success(decided);
    }

    private async Task<PetLookup?> ExecuteAsync(LinearTaskRequest request, Uri callback, CancellationToken token)
    {
        // Serialize refresh under the current connection row. Disconnect and replacement cannot
        // advance its revision while a bounded dispatch and its refresh receipt are in flight.
        var connection = await store.LockConnectionAsync(request.ConnectionId, token).ConfigureAwait(false);
        if (request.ExpiresAt <= clock.GetUtcNow() || connection is null || !Matches(request, connection)
            || !await CanUseRequestAsync(request, connection.WorkspaceId, token).ConfigureAwait(false))
        {
            await FinishAsync(request, LinearRequestStatus.Failed, null, token).ConfigureAwait(false);
            return null;
        }

        JsonElement state;
        try
        {
            state = oauth.ReadCredential(connection.ProtectedOAuthState!);
        }
        catch (Exception error) when (error is CryptographicException or JsonException)
        {
            await FinishAsync(request, LinearRequestStatus.Failed, null, token).ConfigureAwait(false);
            return null;
        }

        var reply = await worker.ExecuteAsync(
            new("read", state, callback.AbsoluteUri, IssueId: request.IssueId), token).ConfigureAwait(false);
        if (reply is { OAuthState.ValueKind: JsonValueKind.Object })
        {
            await store.SaveOAuthAsync(connection.Id, connection.Revision, oauth.ProtectCredential(reply.OAuthState), token)
                .ConfigureAwait(false);
        }

        if (reply is { Failure: null, Sent: true, Issue: { } issue } && IsSafeIssue(issue))
        {
            // Workspace roles are cached for a request scope. Read current access afresh
            // before saving anything returned by Linear.
            var canPublish = await isolated.RunAsync(Session, async (services, ct) =>
            {
                var allowed = await services.GetRequiredService<LinearRequests>()
                    .CanUseRequestAsync(request, connection.WorkspaceId, ct).ConfigureAwait(false);
                return new IsolatedOutcome<bool>(allowed, Commit: false);
            }, token).ConfigureAwait(false);
            if (canPublish)
            {
                if (request.PetId.HasValue)
                {
                    return new PetLookup(connection.WorkspaceId, issue);
                }

                await FinishAsync(request, LinearRequestStatus.Succeeded, issue, token).ConfigureAwait(false);
                return null;
            }
        }

        await FinishAsync(request,
            reply?.Sent == false ? LinearRequestStatus.Failed : LinearRequestStatus.Unknown, null, token).ConfigureAwait(false);
        return null;
    }

    private async Task<bool> FinishAsync(LinearTaskRequest request, string status, LinearIssueResponse? result, CancellationToken token, Guid? commentId = null)
    {
        var serialized = result is null ? null : JsonSerializer.Serialize(result, LinearJsonContext.Default.LinearIssueResponse);
        return await store.FinishAsync(request.Id, status, serialized, token, commentId).ConfigureAwait(false);
    }

    private async Task<bool> CanUseRequestAsync(LinearTaskRequest request, WorkspaceId workspaceId, CancellationToken token)
    {
        var item = await ReadTaskAsync(request.ItemId, token).ConfigureAwait(false);
        return item is not null && item.WorkspaceId == workspaceId
            && (!request.PetId.HasValue || CanUsePetTask(item))
            && await permissions.CanManageWorkspaceAsync(workspaceId, token).ConfigureAwait(false)
            && await RequesterIsCurrentAsync(request, token).ConfigureAwait(false);
    }

    private bool CanUsePetTask(Item item) => !ItemSettings.Read(item.Settings).WithholdFromPets
        && !PetRunService.IsPaused(configuration, item.WorkspaceId);

    private async ValueTask<Item?> ReadTaskAsync(ItemId id, CancellationToken token)
    {
        var lookup = await visible.FindAsync(id, ItemAccess.Read, token, lockedDetail: "locked").ConfigureAwait(false);
        if (lookup.IsFailure || (await locks.LockedAmongAsync([id], token).ConfigureAwait(false)).Count != 0)
        {
            return null;
        }

        return lookup.Value;
    }

    private async Task<bool> RequesterIsCurrentAsync(LinearTaskRequest request, CancellationToken token)
    {
        if (request.RequesterId != Session.PrincipalId)
        {
            return false;
        }

        if (request.RequesterTokenId is not { } id)
        {
            return true;
        }

        var sender = await tokens.FindSessionStateAsync(PersonalAccessTokenId.From(id), token).ConfigureAwait(false);
        return sender is { RevokedAt: null } && sender.PrincipalId == Session.PrincipalId
            && sender.ExpiresAt > clock.GetUtcNow()
            && AccessTokenScopePolicy.Satisfies(sender.Scopes, AccessTokenScopePolicy.Requirement.Write);
    }

    private async ValueTask<Dictionary<Guid, string>> LabelsAsync(CancellationToken token) =>
        (await tokens.ListOwnAsync(token).ConfigureAwait(false)).ToDictionary(item => item.Id.Value, item => item.Name);

    private LinearRequestResponse ToResponse(
        LinearTaskRequest row, LinearConnection? connection, Guid? callerToken, Dictionary<Guid, string> labels)
    {
        var now = clock.GetUtcNow();
        var current = Matches(row, connection);
        var status = row.Status;
        if (status == LinearRequestStatus.Pending && (!current || row.ExpiresAt <= now))
        {
            status = LinearRequestStatus.Expired;
        }
        else if (status == LinearRequestStatus.Running && !current)
        {
            status = LinearRequestStatus.Unknown;
        }

        var name = row.PetName ?? (row.RequesterTokenId is { } id ? labels.GetValueOrDefault(id, "Agent") : "You");
        var result = status == LinearRequestStatus.Succeeded && current && row.ResultJson is { } json
            ? JsonSerializer.Deserialize(json, LinearJsonContext.Default.LinearIssueResponse)
            : null;
        return new(row.Id, row.ItemId.Value, row.IssueId, status, name, row.CreatedAt, row.ExpiresAt,
            callerToken is null && status == LinearRequestStatus.Pending, result, row.PetId, row.CommentId);
    }

    private static bool Matches(LinearTaskRequest request, LinearConnection? connection) =>
        connection is { ProtectedOAuthState: not null }
        && connection.Id == request.ConnectionId
        && connection.Revision == request.ConnectionRevision
        && connection.OwnerId == request.RequesterId;

    private static bool IsSafeIssue(LinearIssueResponse issue) =>
        issue.Id is { } id && IsIssueIdentifier(id) && issue.Title is { Length: > 0 and <= 512 }
        && issue.Status is { Length: > 0 and <= 120 } && issue.Url is { Length: > 0 and <= 2048 }
        && Uri.TryCreate(issue.Url, UriKind.Absolute, out var url)
        && url.Scheme == Uri.UriSchemeHttps && url.IdnHost == "linear.app"
        && url.IsDefaultPort && url.UserInfo.Length == 0 && url.Query.Length == 0 && url.Fragment.Length == 0;

    internal static bool IsIssueIdentifier(string value) =>
        value.Length is > 0 and <= 64 && (IssueIdentifier().IsMatch(value) || Guid.TryParseExact(value, "D", out _));

    [GeneratedRegex(@"\A[A-Z][A-Z0-9_-]{0,30}-[1-9][0-9]{0,11}\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex IssueIdentifier();
}
