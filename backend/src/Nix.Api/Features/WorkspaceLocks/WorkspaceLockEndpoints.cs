using System.Diagnostics;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Errors;
using Nix.Features.Workspaces;
using Nix.Http;
using Nix.Messaging;

namespace Nix.Features.WorkspaceLocks;

/// <summary>
/// Route registration for workspace passwords: the lock management, unlock, relock and join routes.
/// </summary>
/// <remarks>
/// A password withholds the workspace from its members until they present it; it does not encrypt
/// anything. The routes that check a password carry the tighter lock-password rate limit.
/// </remarks>
internal static class WorkspaceLockEndpoints
{
    /// <summary>Registers the workspace password routes on <paramref name="endpoints"/>.</summary>
    internal static IEndpointRouteBuilder MapWorkspaceLockEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var group = endpoints.MapGroup("/api/v1/workspaces/{workspaceId:guid}").WithTags("Workspace passwords");

        group.MapPut("/password", SetWorkspacePasswordEndpoint.Handle)
            .WithName("SetWorkspacePassword")
            .WithSummary("Close a workspace behind a password, or change the password")
            .WithDescription(
                "Owner only. Sets the one password members must present to open the workspace and "
                + "anybody in the tenant may present, with the join link, to join it. When the "
                + "workspace already has a password this changes it, which also needs "
                + "'currentPassword' and ends every other session's unlock. There is no recovery "
                + "path for a forgotten password. A password withholds the workspace from members "
                + "who have not unlocked it; it does not encrypt what is stored.")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .RequireRateLimiting(RateLimitRefusal.LockPasswordPolicyName);

        group.MapPost("/password/remove", RemoveWorkspacePasswordEndpoint.Handle)
            .WithName("RemoveWorkspacePassword")
            .WithSummary("Remove a workspace's password")
            .WithDescription(
                "Owner only, and needs the password. A POST with a body rather than a DELETE, "
                + "because the password must not travel in a URL.")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .RequireRateLimiting(RateLimitRefusal.LockPasswordPolicyName);

        group.MapPost("/unlock", UnlockWorkspaceEndpoint.Handle)
            .WithName("UnlockWorkspace")
            .WithSummary("Open a password-protected workspace to this session for a while")
            .WithDescription(
                "Members only; anybody else gets 'workspaces.not_found'. Checks the password and "
                + "opens the workspace to the calling browser session or access token for fifteen "
                + "minutes. Other sessions, including the caller's own elsewhere, stay locked.")
            .Produces<WorkspaceUnlockResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .RequireRateLimiting(RateLimitRefusal.LockPasswordPolicyName);

        group.MapDelete("/unlock", RelockWorkspaceEndpoint.Handle)
            .WithName("RelockWorkspace")
            .WithSummary("Close a password-protected workspace to this session again")
            .WithDescription("Ends the calling session's unlock. Idempotent. Members only.")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        group.MapPost("/join", JoinWorkspaceEndpoint.Handle)
            .WithName("JoinWorkspace")
            .WithSummary("Join a workspace with its password")
            .WithDescription(
                "Adds the signed-in person to the workspace as a viewer, when the workspace has a "
                + "password, is active and is open to new members, and unlocks it for this session. "
                + "Every failure for somebody who is not yet a member - no such workspace, no "
                + "password, closed to new members, wrong password - returns the same "
                + "'workspaces.join_refused' response, so the route cannot be used to find "
                + "workspaces.")
            .Produces<WorkspaceUnlockResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .RequireRateLimiting(RateLimitRefusal.LockPasswordPolicyName);

        return endpoints;
    }

    /// <summary>Maps a failure to problem details: the code decides the status.</summary>
    internal static ProblemDetails Problem(HttpContext httpContext, NixError error)
    {
        var status = error.Code switch
        {
            WorkspaceLockErrors.PasswordInvalidCode => StatusCodes.Status400BadRequest,
            WorkspaceLockErrors.WrongPasswordCode
                or WorkspaceLockErrors.CredentialCannotUnlockCode
                or WorkspaceLockErrors.JoinRefusedCode => StatusCodes.Status403Forbidden,
            WorkspaceLockErrors.PasswordExistsCode or WorkspaceLockErrors.PasswordNotSetCode =>
                StatusCodes.Status409Conflict,
            WorkspaceLockErrors.TooManyAttemptsCode => StatusCodes.Status429TooManyRequests,
            WorkspaceLockErrors.BusyCode => StatusCodes.Status503ServiceUnavailable,
            WorkspaceEndpoints.NotFoundCode => StatusCodes.Status404NotFound,
            _ => throw new UnreachableException($"Workspace lock error code '{error.Code}' has no status."),
        };

        return ApiProblem.Create(httpContext, status, error.Code, "Request refused", error.Message);
    }
}

/// <summary>
/// Turns every workspace route that would show a workspace's members, settings or invitations into
/// not found while the workspace is closed to the caller's credential.
/// </summary>
/// <remarks>
/// Workspace administration reads membership from SQL of its own, not through the permission
/// resolver, so the password lock is applied here once for the whole group. Only the routes a
/// closed workspace has to keep working are exempt: reading its name and lock state, leaving it,
/// and answering an invitation. Archive, restore, purge and recover are not: an owner unlocks
/// first (unlock works on an archived workspace), so a password cannot be bypassed by deleting
/// the workspace it guards.
/// </remarks>
internal static class ClosedWorkspaceFilter
{
    private static readonly HashSet<string> ExemptRoutes = new(StringComparer.Ordinal)
    {
        "ListWorkspaces",
        "GetWorkspace",
        "CreateWorkspace",
        "LeaveWorkspace",
        "AcceptWorkspaceInvitation",
        "DeclineWorkspaceInvitation",
    };

    /// <summary>Refuses the route as not found while the workspace is closed to the caller.</summary>
    internal static async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(next);

        var http = context.HttpContext;
        var name = http.GetEndpoint()?.Metadata.GetMetadata<IEndpointNameMetadata>()?.EndpointName;
        if (http.GetRouteValue("workspaceId") is string text
            && Guid.TryParse(text, out var workspaceId)
            && (name is null || !ExemptRoutes.Contains(name)))
        {
            var locks = http.RequestServices.GetRequiredService<IWorkspaceLocks>();
            var state = await locks.GetStateAsync(WorkspaceId.From(workspaceId), http.RequestAborted).ConfigureAwait(false);
            if (state.Closed)
            {
                return TypedResults.Problem(WorkspaceEndpoints.Problem(http, WorkspaceErrors.NotFound()));
            }
        }

        return await next(context).ConfigureAwait(false);
    }
}

internal static class SetWorkspacePasswordEndpoint
{
    internal static async Task<Results<NoContent, ProblemHttpResult>> Handle(
        Guid workspaceId,
        SetWorkspacePasswordRequest request,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        ArgumentNullException.ThrowIfNull(request);
        var result = await dispatcher
            .SendAsync<SetWorkspacePassword, bool>(
                new SetWorkspacePassword(WorkspaceId.From(workspaceId), request.Password, request.CurrentPassword),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        return result.IsFailure
            ? TypedResults.Problem(WorkspaceLockEndpoints.Problem(httpContext, result.Error))
            : TypedResults.NoContent();
    }
}

internal static class RemoveWorkspacePasswordEndpoint
{
    internal static async Task<Results<NoContent, ProblemHttpResult>> Handle(
        Guid workspaceId,
        WorkspacePasswordRequest request,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        ArgumentNullException.ThrowIfNull(request);
        var result = await dispatcher
            .SendAsync<RemoveWorkspacePassword, bool>(
                new RemoveWorkspacePassword(WorkspaceId.From(workspaceId), request.Password),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        return result.IsFailure
            ? TypedResults.Problem(WorkspaceLockEndpoints.Problem(httpContext, result.Error))
            : TypedResults.NoContent();
    }
}

internal static class UnlockWorkspaceEndpoint
{
    internal static async Task<Results<Ok<WorkspaceUnlockResponse>, ProblemHttpResult>> Handle(
        Guid workspaceId,
        WorkspacePasswordRequest request,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        ArgumentNullException.ThrowIfNull(request);
        var result = await dispatcher
            .SendAsync<UnlockWorkspace, DateTimeOffset>(
                new UnlockWorkspace(WorkspaceId.From(workspaceId), request.Password),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        return result.IsFailure
            ? TypedResults.Problem(WorkspaceLockEndpoints.Problem(httpContext, result.Error))
            : TypedResults.Ok(new WorkspaceUnlockResponse(result.Value));
    }
}

internal static class RelockWorkspaceEndpoint
{
    internal static async Task<Results<NoContent, ProblemHttpResult>> Handle(
        Guid workspaceId,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher
            .SendAsync<RelockWorkspace, bool>(new RelockWorkspace(WorkspaceId.From(workspaceId)), httpContext.RequestAborted)
            .ConfigureAwait(false);

        return result.IsFailure
            ? TypedResults.Problem(WorkspaceLockEndpoints.Problem(httpContext, result.Error))
            : TypedResults.NoContent();
    }
}

internal static class JoinWorkspaceEndpoint
{
    internal static async Task<Results<Ok<WorkspaceUnlockResponse>, ProblemHttpResult>> Handle(
        Guid workspaceId,
        WorkspacePasswordRequest request,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        ArgumentNullException.ThrowIfNull(request);
        var result = await dispatcher
            .SendAsync<JoinWorkspace, DateTimeOffset>(
                new JoinWorkspace(WorkspaceId.From(workspaceId), request.Password),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        return result.IsFailure
            ? TypedResults.Problem(WorkspaceLockEndpoints.Problem(httpContext, result.Error))
            : TypedResults.Ok(new WorkspaceUnlockResponse(result.Value));
    }
}
