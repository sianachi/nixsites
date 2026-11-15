using Microsoft.AspNetCore.Mvc;
using Nix.Authentication;
using Nix.Errors;
using Nix.Features.LocalAuth;
using Nix.Http;

namespace Nix.Features.People;

/// <summary>The People page for tenant administrators: list, add, reset link, disable, enable. Local mode only.</summary>
internal static class PeopleEndpoints
{
    internal static IEndpointRouteBuilder MapPeopleEndpoints(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);
        var people = endpoints.MapGroup("/api/v1/tenant/people").WithTags("People").RequireAuthMode(AuthMode.Local);
        people.MapGet(string.Empty, List).WithName("ListPeople")
            .WithSummary("The organization's local accounts. Needs a tenant administrator and a browser session.");
        people.MapPost(string.Empty, Add).WithName("AddPerson")
            .WithSummary("Adds a person and returns a one-hour setup link")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        people.MapPost("/{id:guid}/reset-link", ResetLink).WithName("IssuePersonResetLink")
            .WithSummary("Issues a one-hour reset link for another person; needs the administrator's current password")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        people.MapPost("/{id:guid}/disable", Disable).WithName("DisablePerson")
            .WithSummary("Blocks sign-in and signs the person out everywhere")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        people.MapPost("/{id:guid}/enable", Enable).WithName("EnablePerson")
            .WithSummary("Lets a disabled person sign in again")
            .RequireRateLimiting(RateLimitRefusal.WritesPolicyName);
        return endpoints;
    }

    private static async Task<IResult> List(HttpContext context, [FromServices] LocalSecurityGuard guard, [FromServices] PeopleService service)
    {
        if (await guard.ResolveAsync(context).ConfigureAwait(false) is { Refusal: { } refusal })
        {
            return refusal;
        }

        var (people, problem) = await service.ListAsync(context.RequestAborted).ConfigureAwait(false);
        return people is null ? Problem(context, problem) : TypedResults.Ok(new PeopleListResponse(people));
    }

    private static async Task<IResult> Add(
        [FromBody] AddPersonRequest? request, HttpContext context, [FromServices] LocalSecurityGuard guard, [FromServices] PeopleService service)
    {
        if (await guard.ResolveAsync(context).ConfigureAwait(false) is { Refusal: { } refusal })
        {
            return refusal;
        }

        var (added, problem) = await service.AddAsync(request?.Email, request?.Name, context.RequestAborted).ConfigureAwait(false);
        return added is null ? Problem(context, problem) : TypedResults.Ok(added);
    }

    private static async Task<IResult> ResetLink(
        Guid id,
        [FromBody] ResetLinkRequest? request,
        HttpContext context,
        [FromServices] LocalSecurityGuard guard,
        [FromServices] LocalReauth reauth,
        [FromServices] Nix.Abstractions.IPermissionResolver permissions,
        [FromServices] PeopleService service)
    {
        var (account, refusal) = await guard.ResolveAsync(context).ConfigureAwait(false);
        if (refusal is not null)
        {
            return refusal;
        }

        if (!await permissions.IsTenantAdministratorAsync(context.RequestAborted).ConfigureAwait(false))
        {
            return Problem(context, PeopleRefusal.NotAdministrator);
        }

        // A reset link takes over another person's sign-in, so a borrowed or stolen session is not enough.
        if (await reauth.CheckAsync(account!, request?.CurrentPassword, context.RequestAborted).ConfigureAwait(false) is { IsOk: false } failed)
        {
            return LocalReauth.Refuse(context, failed);
        }

        var (link, problem) = await service.ResetLinkAsync(id, context.RequestAborted).ConfigureAwait(false);
        return link is null ? Problem(context, problem) : TypedResults.Ok(link);
    }

    private static Task<IResult> Disable(Guid id, HttpContext context, [FromServices] LocalSecurityGuard guard, [FromServices] PeopleService service) =>
        SetDisabled(id, true, context, guard, service);

    private static Task<IResult> Enable(Guid id, HttpContext context, [FromServices] LocalSecurityGuard guard, [FromServices] PeopleService service) =>
        SetDisabled(id, false, context, guard, service);

    private static async Task<IResult> SetDisabled(Guid id, bool disabled, HttpContext context, LocalSecurityGuard guard, PeopleService service)
    {
        if (await guard.ResolveAsync(context).ConfigureAwait(false) is { Refusal: { } refusal })
        {
            return refusal;
        }

        var problem = await service.SetDisabledAsync(id, disabled, context.RequestAborted).ConfigureAwait(false);
        return problem == PeopleRefusal.None ? TypedResults.NoContent() : Problem(context, problem);
    }

    private static Microsoft.AspNetCore.Http.HttpResults.ProblemHttpResult Problem(HttpContext context, PeopleRefusal refusal)
    {
        var (status, code, detail) = refusal switch
        {
            PeopleRefusal.NotAdministrator => (StatusCodes.Status403Forbidden, "roles.administrator_required", "Only a tenant administrator can manage people."),
            PeopleRefusal.NotFound => (StatusCodes.Status404NotFound, "people.not_found", "No such person in this organization."),
            PeopleRefusal.EmailInvalid => (StatusCodes.Status422UnprocessableEntity, "people.email_invalid", "Enter a valid email address."),
            PeopleRefusal.NameInvalid => (StatusCodes.Status422UnprocessableEntity, "people.name_invalid", "Enter a name of 1 to 200 characters."),
            // Install-wide uniqueness: say nothing about whose account holds the address.
            PeopleRefusal.EmailTaken => (StatusCodes.Status409Conflict, "people.email_taken", "That email address cannot be used."),
            PeopleRefusal.SelfDisable => (StatusCodes.Status409Conflict, "people.cannot_disable_self", "You cannot disable your own account."),
            PeopleRefusal.SelfReset => (StatusCodes.Status409Conflict, "people.cannot_reset_self", "Change your own sign-in under Settings > Security."),
            PeopleRefusal.LastAdministrator => (StatusCodes.Status409Conflict, "roles.last_administrator", "That would leave no active administrator."),
            _ => throw new ArgumentOutOfRangeException(nameof(refusal), refusal, null),
        };
        return TypedResults.Problem(ApiProblem.Create(context, status, code, "Request refused", detail));
    }
}
