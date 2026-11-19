using System.Diagnostics.CodeAnalysis;
using System.Text.Json;
using System.Text.Json.Nodes;
using Nix.Abstractions;
using Nix.Abstractions.Connections;
using Nix.Abstractions.Linear;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Features.Connections;
using Nix.Features.Properties;
using Nix.Features.Records;
using Nix.Messaging;

namespace Nix.Features.Linear;

[SuppressMessage("Performance", "CA1812", Justification = "Created by ASP.NET Core dependency injection.")]
internal sealed class LinearLinks(
    ILinearStore store, IConnectorStore connections, ConnectorActions connector, IItemTree tree,
    IPermissionResolver permissions, IItemLocks locks, ISchemaResolver schemas,
    NixDispatcher dispatcher, IConfiguration configuration, TimeProvider clock,
    IIsolatedUnitOfWork isolated, INixSessionContextAccessor session, RecordKeys recordKeys) :
    IQueryHandler<ReadLinearLink, Result<LinearLinkResponse>>,
    ICommandHandler<CreateLinearLink, LinearLinkResponse>,
    ICommandHandler<RefreshLinearLink, LinearLinkResponse>,
    ICommandHandler<ApplyLinearLinkStatus, LinearLinkResponse>,
    ICommandHandler<DeleteLinearLink, bool>
{
    private const string StatusProperty = "status";
    private const string ReadIssueAction = "linear.read_issue";

    public async ValueTask<Result<LinearLinkResponse>> HandleAsync(ReadLinearLink query, CancellationToken token)
    {
        var item = await FindTaskAsync(query.ItemId, token).ConfigureAwait(false);
        return item is null ? Result.Failure<LinearLinkResponse>(LinearErrors.Missing())
            : await DescribeAsync(item, await store.FindLinkAsync(item.WorkspaceId, item.Id, token).ConfigureAwait(false), token).ConfigureAwait(false);
    }

    public async ValueTask<Result<LinearLinkResponse>> HandleAsync(CreateLinearLink command, CancellationToken token)
    {
        if (NormalizeIssue(command.Issue) is not { } issue)
        {
            return Result.Failure<LinearLinkResponse>(LinearErrors.InvalidIssue());
        }
        var item = await FindTaskAsync(command.ItemId, token).ConfigureAwait(false);
        if (item is null || await connections.GetAsync(item.WorkspaceId, command.ConnectionId, false, token).ConfigureAwait(false)
            is not { ProtectedTokens: not null } grant || !IsLinearReadGrant(grant))
        {
            return Result.Failure<LinearLinkResponse>(LinearErrors.Missing());
        }
        if (await store.FindLinkAsync(item.WorkspaceId, item.Id, token).ConfigureAwait(false) is not null)
        {
            return Result.Failure<LinearLinkResponse>(LinkChanged());
        }
        var lookup = await ReadIssueAsync(item, grant, issue, token).ConfigureAwait(false);
        if (lookup.IsFailure)
        {
            return Result.Failure<LinearLinkResponse>(lookup.Error);
        }
        var remote = lookup.Value;
        var current = await FindCurrentTaskAsync(item.Id, token).ConfigureAwait(false);
        if (current is null || current.WorkspaceId != item.WorkspaceId)
        {
            return Result.Failure<LinearLinkResponse>(LinearErrors.Missing());
        }
        var local = ReadLocalStatus(current);
        if (local is { Length: > 1024 })
        {
            return Result.Failure<LinearLinkResponse>(new NixError("linear.invalid_status", "Shorten the Nix status to link this issue."));
        }
        var link = new LinearItemLink(current.Id, current.WorkspaceId, grant.Id, grant.Revision,
            Guid.CreateVersion7(), remote.Id, remote.Identifier, new Uri(remote.Url, UriKind.Absolute), remote.StatusId, remote.Status,
            remote.UpdatedAt, clock.GetUtcNow(), remote.StatusId, local);
        return await store.CreateLinkAsync(link, token).ConfigureAwait(false)
            ? await DescribeAsync(current, link, token).ConfigureAwait(false)
            : Result.Failure<LinearLinkResponse>(LinkChanged());
    }

    public async ValueTask<Result<LinearLinkResponse>> HandleAsync(RefreshLinearLink command, CancellationToken token)
    {
        var item = await FindTaskAsync(command.ItemId, token).ConfigureAwait(false);
        if (item is null || await store.FindLinkAsync(item.WorkspaceId, item.Id, token).ConfigureAwait(false) is not { } link
            || await connections.GetAsync(item.WorkspaceId, link.ConnectionId, false, token).ConfigureAwait(false)
                is not { ProtectedTokens: not null } grant || grant.Revision != link.ConnectionRevision || !IsLinearReadGrant(grant))
        {
            return Result.Failure<LinearLinkResponse>(LinearErrors.Missing());
        }
        var lookup = await ReadIssueAsync(item, grant, link.IssueId.ToString("D"), token).ConfigureAwait(false);
        if (lookup.IsFailure)
        {
            return Result.Failure<LinearLinkResponse>(lookup.Error);
        }
        var remote = lookup.Value;
        var current = await FindCurrentTaskAsync(item.Id, token).ConfigureAwait(false);
        if (current is null || current.WorkspaceId != item.WorkspaceId || remote.UpdatedAt < link.RemoteUpdatedAt)
        {
            return Result.Failure<LinearLinkResponse>(LinkChanged());
        }
        var updated = link with
        {
            Revision = Guid.CreateVersion7(),
            Identifier = remote.Identifier,
            Url = new Uri(remote.Url, UriKind.Absolute),
            StatusId = remote.StatusId,
            Status = remote.Status,
            RemoteUpdatedAt = remote.UpdatedAt,
            CheckedAt = clock.GetUtcNow(),
        };
        return await store.UpdateLinkAsync(updated, link.Revision, token).ConfigureAwait(false)
            ? await DescribeAsync(current, updated, token).ConfigureAwait(false)
            : Result.Failure<LinearLinkResponse>(LinkChanged());
    }

    public async ValueTask<Result<LinearLinkResponse>> HandleAsync(ApplyLinearLinkStatus command, CancellationToken token)
    {
        var item = await FindTaskAsync(command.ItemId, token).ConfigureAwait(false);
        if (item is null)
        {
            return Result.Failure<LinearLinkResponse>(LinearErrors.Missing());
        }
        // Match the ordinary property writer's collection-before-item lock order.
        if (item.ParentId is { } parent)
        {
            await recordKeys.EnterScopeAsync(parent, token).ConfigureAwait(false);
        }
        if (!await store.LockLinkItemAsync(item.WorkspaceId, item.Id, command.Revision, token).ConfigureAwait(false)
            || await FindTaskAsync(item.Id, token).ConfigureAwait(false) is not { } current
            || current.WorkspaceId != item.WorkspaceId || current.ParentId != item.ParentId
            || await store.FindLinkAsync(current.WorkspaceId, current.Id, token).ConfigureAwait(false) is not { } link)
        {
            return Result.Failure<LinearLinkResponse>(LinkChanged());
        }
        var local = ReadLocalStatus(current);
        if (!string.Equals(command.LocalStatus, local, StringComparison.Ordinal)
            || !await CanApplyAsync(current, link, local, token).ConfigureAwait(false))
        {
            return Result.Failure<LinearLinkResponse>(LinkChanged());
        }

        // The link and item rows are held until this reviewed property write and its baseline commit together.
        var changes = new JsonObject { [StatusProperty] = link.Status }.ToJsonString();
        var applied = await dispatcher.SendAsync<SetItemProperties, Item>(
            new(current.Id, changes) { Strict = true }, token).ConfigureAwait(false);
        if (applied.IsFailure)
        {
            return Result.Failure<LinearLinkResponse>(applied.Error);
        }
        var updated = link with { Revision = Guid.CreateVersion7(), BaselineStatusId = link.StatusId, BaselineLocalStatus = link.Status };
        return await store.UpdateLinkAsync(updated, link.Revision, token).ConfigureAwait(false)
            ? await DescribeAsync(applied.Value, updated, token).ConfigureAwait(false)
            : Result.Failure<LinearLinkResponse>(LinkChanged());
    }

    public async ValueTask<Result<bool>> HandleAsync(DeleteLinearLink command, CancellationToken token)
    {
        var item = await FindTaskAsync(command.ItemId, token).ConfigureAwait(false);
        return item is not null && await store.DeleteLinkAsync(item.WorkspaceId, item.Id, command.Revision, token).ConfigureAwait(false)
            ? Result.Success(true) : Result.Failure<bool>(LinkChanged());
    }

    private async Task<Result<LinearLinkResponse>> DescribeAsync(Item item, LinearItemLink? link, CancellationToken token)
    {
        var grants = (await connections.ListAsync(item.WorkspaceId, token).ConfigureAwait(false))
            .Where(IsLinearReadGrant).ToArray();
        LinearLinkedIssue? issue = null;
        if (link is not null)
        {
            var connected = grants.Any(grant => grant.Id == link.ConnectionId && grant.Revision == link.ConnectionRevision);
            var local = ReadLocalStatus(item);
            issue = new LinearLinkedIssue(link.Revision, connected, connected ? link.Identifier : null,
                connected ? link.Url.AbsoluteUri : null, connected ? link.Status : null,
                connected ? link.CheckedAt : null, local, connected ? ChangeName(link.Compare(local)) : null,
                connected && await CanApplyAsync(item, link, local, token).ConfigureAwait(false));
        }
        return Result.Success(new LinearLinkResponse(issue, [.. grants.Select(grant => new LinearLinkConnection(grant.Id, grant.ResourceId))]));
    }

    private async Task<bool> CanApplyAsync(Item item, LinearItemLink link, string? local, CancellationToken token)
    {
        var same = string.Equals(local, link.Status, StringComparison.Ordinal);
        var change = link.Compare(local);
        if (same ? change == LinearStatusChange.None : change is LinearStatusChange.Local or LinearStatusChange.Conflict)
        {
            return false;
        }
        var field = (await schemas.ResolveForItemAsync(item.Id, token).ConfigureAwait(false)).Find(StatusProperty);
        return field?.Type == PropertyType.Text || field?.Type == PropertyType.Select && field.Allows(link.Status);
    }

    private async Task<Result<LinearRemoteIssue>> ReadIssueAsync(Item item, ConnectorGrant grant, string issue, CancellationToken token)
    {
        var args = JsonSerializer.SerializeToElement(new RequestLinearIssueRequest(issue), LinearJsonContext.Default.RequestLinearIssueRequest);
        var preview = await connector.PreviewAsync(item.WorkspaceId, grant.Id, ReadIssueAction, args, token).ConfigureAwait(false);
        if (preview.IsFailure || preview.Value.Kind != "read" || preview.Value.ConnectionRevision != grant.Revision)
        {
            return Result.Failure<LinearRemoteIssue>(preview.IsFailure ? preview.Error : LinkChanged());
        }
        var read = await connector.ExecuteAsync(item.WorkspaceId, Guid.CreateVersion7(), preview.Value, token).ConfigureAwait(false);
        if (read.IsFailure)
        {
            return Result.Failure<LinearRemoteIssue>(read.Error);
        }
        try
        {
            var result = read.Value.Deserialize(LinearJsonContext.Default.LinearRemoteIssue);
            return result is not null && result.Id != Guid.Empty && result.StatusId != Guid.Empty
                && result.UpdatedAt != DateTimeOffset.MinValue
                && Guid.TryParse(grant.ResourceId, out var team) && result.TeamId == team
                && result.Status is { Length: > 0 and <= 120 } && !result.Status.Any(char.IsControl)
                && IsRemoteIssue(result, issue)
                ? Result.Success(result) : Result.Failure<LinearRemoteIssue>(LinearErrors.Unavailable());
        }
        catch (JsonException)
        {
            return Result.Failure<LinearRemoteIssue>(LinearErrors.Unavailable());
        }
    }

    private async ValueTask<Item?> FindTaskAsync(ItemId id, CancellationToken token)
    {
        var item = await tree.FindAsync(id, token).ConfigureAwait(false);
        return item is not null && ConnectorEndpoints.Enabled(configuration, item.WorkspaceId)
            && await permissions.CanManageWorkspaceAsync(item.WorkspaceId, token).ConfigureAwait(false)
            && (await locks.LockedAmongAsync([id], token).ConfigureAwait(false)).Count == 0
            && await locks.MayReadBodyAsync(id, token).ConfigureAwait(false) ? item : null;
    }

    private Task<Item?> FindCurrentTaskAsync(ItemId id, CancellationToken token)
    {
        var caller = session.Current ?? throw new InvalidOperationException("A tenant unit of work is required.");
        return isolated.RunAsync(caller, async (services, ct) =>
        {
            // The provider round trip may outlast a cached permission in the original request.
            var current = await services.GetRequiredService<LinearLinks>().FindTaskAsync(id, ct).ConfigureAwait(false);
            return new IsolatedOutcome<Item?>(current, Commit: false);
        }, token);
    }

    private static string? ReadLocalStatus(Item item)
    {
        if (item.Properties is null)
        {
            return null;
        }
        using var properties = JsonDocument.Parse(item.Properties);
        return properties.RootElement.ValueKind == JsonValueKind.Object
            && properties.RootElement.TryGetProperty(StatusProperty, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() : null;
    }

    private static bool IsLinearReadGrant(ConnectorGrant grant) =>
        grant.Provider == "linear" && grant.ResourceKind == "team" && grant.Actions.Contains(ReadIssueAction, StringComparer.Ordinal);

    private static string ChangeName(LinearStatusChange change) => change switch
    {
        LinearStatusChange.Remote => "remote",
        LinearStatusChange.Local => "local",
        LinearStatusChange.Conflict => "conflict",
        _ => "none",
    };

    private static bool IsRemoteIssue(LinearRemoteIssue remote, string requested) =>
        remote.Identifier is { Length: > 0 and <= 64 } && remote.Url is { Length: > 0 and <= 2048 }
        && string.Equals(NormalizeIssue(remote.Url), remote.Identifier, StringComparison.OrdinalIgnoreCase)
        && (string.Equals(remote.Identifier, requested, StringComparison.OrdinalIgnoreCase)
            || Guid.TryParse(requested, out var id) && id == remote.Id);

    private static string? NormalizeIssue(string? value)
    {
        if (value?.Trim() is not { Length: > 0 and <= 2048 } issue)
        {
            return null;
        }
        if (LinearRequests.IsIssueIdentifier(issue))
        {
            return issue.ToUpperInvariant();
        }
        if (!Uri.TryCreate(issue, UriKind.Absolute, out var url) || url.Scheme != Uri.UriSchemeHttps
            || url.IdnHost != "linear.app" || !url.IsDefaultPort || url.UserInfo.Length != 0
            || url.Query.Length != 0 || url.Fragment.Length != 0)
        {
            return null;
        }
        var path = url.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        var index = Array.IndexOf(path, "issue") + 1;
        return index > 0 && index < path.Length && LinearRequests.IsIssueIdentifier(path[index])
            ? path[index].ToUpperInvariant() : null;
    }

    private static NixError LinkChanged() => new("linear.conflict", "The link or status changed. Refresh the issue and review the latest values.");
}
