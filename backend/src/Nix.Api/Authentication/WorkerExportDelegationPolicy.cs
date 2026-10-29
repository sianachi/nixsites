using Microsoft.EntityFrameworkCore;
using Nix.Abstractions.Workers;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Persistence;

namespace Nix.Authentication;

/// <summary>Limits a live export delegation to Collaboration's read-only metadata surface.</summary>
public static class WorkerExportDelegationPolicy
{
    /// <summary>
    /// Whether a running job of this kind may hold a delegation at all: an export, and a site
    /// build, which reads each page's body from the collaboration service at a pinned position
    /// under a token of exactly the same shape (ADR-0063). Every other job kind gets none.
    /// </summary>
    /// <param name="jobKind">The kind of the job whose lease the token names.</param>
    /// <returns>Whether a delegation is honoured.</returns>
    public static bool Delegates(string jobKind)
    {
        ArgumentNullException.ThrowIfNull(jobKind);
        return jobKind.StartsWith("export.", StringComparison.Ordinal)
            || string.Equals(jobKind, "site.build", StringComparison.Ordinal);
    }

    /// <summary>
    /// Rejects every route that Collaboration does not need before any principal or database work
    /// is attempted. Item ancestry is deliberately checked later, after RLS has been established.
    /// </summary>
    public static bool Allows(
        HttpRequest request,
        ValidatedWorkerExecutionToken token,
        WorkerExecutionAuthorization? execution)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(token);
        if (!TryReadTarget(request, out var target))
        {
            return false;
        }
        if (execution is not null
            && (execution.TenantId != token.TenantId.Value
                || execution.WorkspaceId != token.WorkspaceId
                || execution.ActorId != token.PrincipalId.Value))
        {
            return false;
        }

        return token.Scope is "item" or "subtree"
            && token.WorkspaceId != Guid.Empty
            && target.ItemId != Guid.Empty
            && (target.WorkspaceId is null || target.WorkspaceId == token.WorkspaceId)
            && (token.Scope == "subtree" || target.ItemId == token.ItemId)
            && (!target.RootOnly || target.ItemId == token.ItemId);
    }

    /// <summary>
    /// Proves that the requested item is the signed root, or one of its descendants for a subtree
    /// export. This runs inside the request transaction so the query shares its SET LOCAL tenant
    /// and principal context rather than creating a second authorization path.
    /// </summary>
    public static async ValueTask<bool> AuthorizesTargetAsync(
        HttpRequest request,
        ValidatedWorkerExecutionToken token,
        WorkerExecutionAuthorization execution,
        NixDbContext database,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(database);
        if (!Allows(request, token, execution)
            || !TryReadTarget(request, out var target))
        {
            return false;
        }

        var rootId = ItemId.From(token.ItemId);
        var targetId = ItemId.From(target.ItemId);
        var tenantId = token.TenantId;
        var workspaceId = WorkspaceId.From(token.WorkspaceId);
        return await (
            from edge in database.ItemClosure.AsNoTracking()
            join item in database.Items.AsNoTracking()
                on edge.DescendantId equals item.Id
            where edge.TenantId == tenantId
                && item.TenantId == tenantId
                && edge.AncestorId == rootId
                && edge.DescendantId == targetId
                && edge.WorkspaceId == workspaceId
                && item.WorkspaceId == workspaceId
            select edge)
            .TagWith("WorkerExportDelegationPolicy.AuthorizesTargetAsync")
            .AnyAsync(cancellationToken)
            .ConfigureAwait(false);
    }

    private static bool TryReadTarget(HttpRequest request, out DelegatedReadTarget target)
    {
        target = default;
        if (!HttpMethods.IsGet(request.Method) && !HttpMethods.IsHead(request.Method))
        {
            return false;
        }

        var segments = request.Path.Value?
            .Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (segments is null)
        {
            return false;
        }

        if (segments.Length == 4
            && Segment(segments[0], "internal")
            && Segment(segments[1], "authz")
            && Segment(segments[2], "items")
            && Guid.TryParse(segments[3], out var authorizationItem))
        {
            target = new DelegatedReadTarget(authorizationItem, WorkspaceId: null, RootOnly: true);
            return true;
        }

        if (segments.Length is 4 or 5
            && Segment(segments[0], "api")
            && Segment(segments[1], "v1")
            && Segment(segments[2], "items")
            && Guid.TryParse(segments[3], out var itemId)
            && (segments.Length == 4
                || Segment(segments[4], "schema")
                || Segment(segments[4], "views")
                || Segment(segments[4], "comments")))
        {
            target = new DelegatedReadTarget(itemId, WorkspaceId: null, RootOnly: false);
            return true;
        }

        if (segments.Length == 5
            && Segment(segments[0], "api")
            && Segment(segments[1], "v1")
            && Segment(segments[2], "workspaces")
            && Guid.TryParse(segments[3], out var workspaceId)
            && Segment(segments[4], "items")
            && Guid.TryParse(request.Query["parentId"].ToString(), out var parentId))
        {
            target = new DelegatedReadTarget(parentId, workspaceId, RootOnly: false);
            return workspaceId != Guid.Empty && parentId != Guid.Empty;
        }

        return false;
    }

    private static bool Segment(string actual, string expected) =>
        string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase);

    private readonly record struct DelegatedReadTarget(Guid ItemId, Guid? WorkspaceId, bool RootOnly);
}
