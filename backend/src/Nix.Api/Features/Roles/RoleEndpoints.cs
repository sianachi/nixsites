using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Contracts;
using Nix.Domain.Primitives;
using Nix.Errors;
using Nix.Http;
using Nix.Messaging;

namespace Nix.Features.Roles;

/// <summary>
/// Route registration for tenant administrators, the one tenant-wide role that can be managed:
/// read, grant and revoke for principals. Group grants and workspace membership are not here.
/// </summary>
internal static class RoleEndpoints
{
    /// <summary>
    /// Registers the role routes on <paramref name="endpoints"/>.
    /// </summary>
    internal static IEndpointRouteBuilder MapRoleEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);

        var tenant = endpoints.MapGroup("/api/v1/tenant")
            .WithTags("Roles");

        tenant.MapGet("/roles", ListTenantRoles)
            .WithName("ListTenantRoles")
            .WithSummary("Tenant-wide role holders")
            .WithDescription(
                "Returns the principals holding the tenant admin role. Visible to tenant administrators; other "
                + "callers receive an empty page rather than a refusal, because whether the "
                + "endpoint refuses is itself information about the caller's standing. One page holds them all.")
            .Produces<CursorPage<RoleGrantResponse>>(StatusCodes.Status200OK);
        tenant.MapPut("/admins/{principalId:guid}", GrantAdmin)
            .WithName("GrantTenantAdmin")
            .WithSummary("Make a person a tenant administrator")
            .WithDescription("Idempotent; audited. The person must belong to the caller's organization. Needs a tenant administrator.")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        tenant.MapDelete("/admins/{principalId:guid}", RevokeAdmin)
            .WithName("RevokeTenantAdmin")
            .WithSummary("Remove a person's tenant administrator role")
            .WithDescription("Idempotent; audited. Refused (409 roles.last_administrator) when it would leave no administrator. Needs a tenant administrator.")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        tenant.MapGet("/settings", GetSettings)
            .WithName("GetTenantSettings")
            .WithSummary("The organization's MCP and public link switches")
            .WithDescription(
                "Whether administrators allow remote MCP and public links (the stored switches), and whether "
                + "the deployment offers each at all. Needs a tenant administrator and an interactive session.")
            .Produces<TenantSettingsResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status403Forbidden);
        tenant.MapPut("/settings", PutSettings)
            .WithName("UpdateTenantSettings")
            .WithSummary("Turn remote MCP or public links on or off for the organization")
            .WithDescription(
                "An omitted field is unchanged. Audited. Turning public links off stops live links serving without "
                + "revoking them; turning MCP off makes the remote MCP endpoint refuse this organization's tokens. "
                + "Needs a tenant administrator and an interactive session.")
            .Produces<TenantSettingsResponse>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);

        return endpoints;
    }

    private static async Task<IResult> GetSettings(HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Settings(context, await dispatcher.QueryAsync<GetTenantSettings, Result<TenantSettingsResponse>>(new(), context.RequestAborted).ConfigureAwait(false));

    private static async Task<IResult> PutSettings(
        UpdateTenantSettingsRequest request,
        HttpContext context,
        [FromServices] NixDispatcher dispatcher) =>
        Settings(context, await dispatcher.SendAsync<UpdateTenantSettings, TenantSettingsResponse>(new(request), context.RequestAborted).ConfigureAwait(false));

    private static IResult Settings(HttpContext context, Result<TenantSettingsResponse> result) =>
        result.IsSuccess
            ? TypedResults.Ok(result.Value)
            : TypedResults.Problem(ApiProblem.Create(
                context,
                StatusCodes.Status403Forbidden,
                result.Error.Code,
                "Request refused",
                result.Error.Message));

    private static async Task<Ok<CursorPage<RoleGrantResponse>>> ListTenantRoles(
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher,
        string? cursor = null,
        int limit = CursorPaging.DefaultLimit)
    {
        var admins = await dispatcher.QueryAsync<ListTenantAdmins, IReadOnlyList<Abstractions.AccessGrantRow>>(new(), httpContext.RequestAborted).ConfigureAwait(false);
        return TypedResults.Ok(new CursorPage<RoleGrantResponse>(
            [.. admins.Select(row => new RoleGrantResponse("principal", row.PrincipalId, row.DisplayName, "admin", row.GrantedAt))],
            null));
    }

    private static Task<IResult> GrantAdmin(Guid principalId, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Send<GrantTenantAdmin>(new(principalId), context, dispatcher);

    private static Task<IResult> RevokeAdmin(Guid principalId, HttpContext context, [FromServices] NixDispatcher dispatcher) =>
        Send<RevokeTenantAdmin>(new(principalId), context, dispatcher);

    private static async Task<IResult> Send<TCommand>(TCommand command, HttpContext context, NixDispatcher dispatcher)
        where TCommand : ICommand<Guid>
    {
        var result = await dispatcher.SendAsync<TCommand, Guid>(command, context.RequestAborted).ConfigureAwait(false);
        return result.IsSuccess
            ? TypedResults.NoContent()
            : TypedResults.Problem(ApiProblem.Create(
                context,
                result.Error.Code switch
                {
                    TenantAdminErrors.AdministratorRequiredCode => StatusCodes.Status403Forbidden,
                    TenantAdminErrors.PrincipalNotFoundCode => StatusCodes.Status404NotFound,
                    _ => StatusCodes.Status409Conflict,
                },
                result.Error.Code,
                "Request refused",
                result.Error.Message));
    }
}
