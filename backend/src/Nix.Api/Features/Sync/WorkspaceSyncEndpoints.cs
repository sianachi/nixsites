using System.Globalization;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Sync;
using Nix.Domain.Tenancy;
using Nix.Errors;
using Nix.Http;
using Nix.Messaging;

namespace Nix.Features.Sync;

/// <summary>The bounded set of identifiers whose previously-held copies the device must recheck.</summary>
public sealed record ReconcileWorkspaceSyncRequest(IReadOnlyList<Guid> ItemIds);

/// <summary>Snapshot, committed changes and non-disclosing local-copy reconciliation.</summary>
internal static class WorkspaceSyncEndpoints
{
    internal static IEndpointRouteBuilder MapWorkspaceSyncEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);
        var group = endpoints.MapGroup("/api/v1/workspaces/{workspaceId:guid}/sync").WithTags("Sync");
        group.MapGet("/snapshot", Snapshot).WithName("GetWorkspaceSyncSnapshot")
            .WithSummary("Enumerate all authorized metadata with a committed feed boundary")
            .Produces<WorkspaceSyncSnapshot>().ProducesProblem(404).ProducesProblem(422).ProducesProblem(423);
        group.MapGet("/changes", Changes).WithName("GetWorkspaceSyncChanges")
            .WithSummary("Read current authorized metadata for committed change markers")
            .Produces<WorkspaceSyncChanges>().ProducesProblem(404).ProducesProblem(422).ProducesProblem(423);
        group.MapPost("/reconcile", Reconcile).WithName("ReconcileWorkspaceSync")
            .WithSummary("Recheck device-held identifiers without revealing unknown inaccessible identifiers")
            .Produces<WorkspaceSyncReconciliation>().ProducesProblem(422).ProducesProblem(423)
            .WithRequestBodyLimit(24 * 1024)
            .RequireRateLimiting(RateLimitRefusal.QueriesPolicyName);
        return endpoints;
    }

    private static async Task<Results<Ok<WorkspaceSyncSnapshot>, ProblemHttpResult>> Snapshot(
        Guid workspaceId, HttpContext context, [FromServices] NixDispatcher dispatcher,
        string? boundary = null, Guid? cursor = null, int limit = 200)
    {
        if (limit is < 1 or > 500 || (cursor is not null && boundary is null)
            || !TrySequence(boundary, out var parsed))
        {
            return TypedResults.Problem(Invalid(context));
        }
        if (await ClosedAsync(workspaceId, context).ConfigureAwait(false) is { } closed)
        {
            return TypedResults.Problem(closed);
        }
        var page = await dispatcher.QueryAsync<GetWorkspaceSyncSnapshot, WorkspaceSyncSnapshot?>(
            new(WorkspaceId.From(workspaceId), boundary is null ? null : parsed, cursor, limit), context.RequestAborted).ConfigureAwait(false);
        return page is null ? TypedResults.Problem(Missing(context)) : TypedResults.Ok(page);
    }

    private static async Task<Results<Ok<WorkspaceSyncChanges>, ProblemHttpResult>> Changes(
        Guid workspaceId, HttpContext context, [FromServices] NixDispatcher dispatcher,
        string after = "0", int limit = 200)
    {
        if (limit is < 1 or > 500 || !TrySequence(after, out var parsed))
        {
            return TypedResults.Problem(Invalid(context));
        }
        if (await ClosedAsync(workspaceId, context).ConfigureAwait(false) is { } closed)
        {
            return TypedResults.Problem(closed);
        }
        var page = await dispatcher.QueryAsync<GetWorkspaceSyncChanges, WorkspaceSyncChanges?>(
            new(WorkspaceId.From(workspaceId), parsed, limit), context.RequestAborted).ConfigureAwait(false);
        return page is null ? TypedResults.Problem(Missing(context)) : TypedResults.Ok(page);
    }

    private static async Task<Results<Ok<WorkspaceSyncReconciliation>, ProblemHttpResult>> Reconcile(
        Guid workspaceId, ReconcileWorkspaceSyncRequest request, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        if (request.ItemIds is null || request.ItemIds.Count > 500 || request.ItemIds.Contains(Guid.Empty))
        {
            return TypedResults.Problem(Invalid(context));
        }
        if (await ClosedAsync(workspaceId, context).ConfigureAwait(false) is { } closed)
        {
            return TypedResults.Problem(closed);
        }
        return TypedResults.Ok(await dispatcher.QueryAsync<ReconcileWorkspaceSync, WorkspaceSyncReconciliation>(
            new(WorkspaceId.From(workspaceId), request.ItemIds), context.RequestAborted).ConfigureAwait(false));
    }

    private static bool TrySequence(string? value, out long sequence)
    {
        sequence = 0;
        return value is null || (long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out sequence) && sequence >= 0);
    }

    /// <summary>
    /// A member of a workspace closed to this credential by its password gets 423, not the 404 of
    /// a workspace they cannot reach. A device mirror treats 404 as revoked access and wipes the
    /// workspace, unsynced edits included; a password lock closes access without ending it, so the
    /// device must keep what it holds and wait for an unlock. A stranger still gets the 404.
    /// </summary>
    internal static async Task<ProblemDetails?> ClosedAsync(Guid workspaceId, HttpContext context)
    {
        var id = WorkspaceId.From(workspaceId);
        var locks = context.RequestServices.GetRequiredService<IWorkspaceLocks>();
        if (!(await locks.GetStateAsync(id, context.RequestAborted).ConfigureAwait(false)).Closed)
        {
            return null;
        }

        var membership = context.RequestServices.GetRequiredService<IWorkspaceMembershipIgnoringLock>();
        return await membership.RoleIgnoringLockAsync(id, context.RequestAborted).ConfigureAwait(false) is null
            ? null
            : ApiProblem.Create(
                context, 423, "workspaces.locked", "Workspace locked", "This workspace is locked to this credential. Unlock it to continue.");
    }

    private static ProblemDetails Invalid(HttpContext context) => ApiProblem.Create(
        context, 422, "sync.invalid_request", "Invalid synchronization request", "Use a valid nonnegative sequence and at most 500 rows or identifiers.");
    private static ProblemDetails Missing(HttpContext context) => ApiProblem.Create(
        context, 404, "sync.workspace_inaccessible", "Workspace unavailable", "The workspace is not available to this credential.");
}
