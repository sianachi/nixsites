using System.ComponentModel.DataAnnotations;
using System.Globalization;
using System.Text;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Contracts;
using Nix.Domain.Identity;
using Nix.Domain.Primitives;
using Nix.Domain.Tenancy;
using Nix.Http;
using Nix.Messaging;
using Nix.Persistence.Workspaces;

namespace Nix.Features.Workspaces;

internal sealed record WorkspaceMemberResponse(
    string SubjectType,
    Guid SubjectId,
    string SubjectDisplayName,
    string? Email,
    string Role,
    DateTimeOffset GrantedAt,
    bool CanChangeRole,
    bool CanRemove,
    IReadOnlyList<string> AssignableRoles);

internal sealed record WorkspaceInvitationResponse(
    Guid Id,
    string EmailNormalized,
    Guid? TargetPrincipalId,
    string Role,
    string Status,
    Guid InvitedByPrincipalId,
    DateTimeOffset InvitedAt,
    DateTimeOffset? AcceptedAt,
    Guid? AcceptedByPrincipalId,
    DateTimeOffset? RevokedAt);

internal sealed record CreateWorkspaceInvitationRequest(
    Guid PrincipalId,
    [property: AllowedValues("owner", "editor", "viewer")] string Role);
internal sealed record WorkspaceInviteeResponse(
    Guid PrincipalId, string DisplayName, string? Email, bool CanInvite, string? CannotInviteReason);
internal sealed record ChangeWorkspaceMemberRoleRequest(
    [property: AllowedValues("owner", "editor", "viewer")] string Role);
internal sealed record RecoverWorkspaceRequest(Guid NewOwnerPrincipalId);

internal static class WorkspaceAdministrationRules
{
    internal static bool TryAssignableRole(string? value, out string role)
    {
        role = value?.Trim() switch
        {
            "owner" => "owner",
            "editor" => "editor",
            "viewer" => "viewer",
            _ => string.Empty,
        };
        return role.Length > 0;
    }
}

internal static class WorkspaceAdministrationErrors
{
    internal static NixError InvalidRole() => new("workspaces.invalid_role", "The role is not recognized.");
    internal static NixError InvalidInvitation() =>
        new("workspaces.invalid_invitation", "An eligible principal and a recognized role are required.");
    internal static NixError InvalidCursor() =>
        new("paging.invalid_cursor", "The cursor is malformed or exceeds 512 characters.");
    internal static NixError InvitationNotPending() => new(
        "workspaces.invitation_not_pending",
        "Only a pending invitation can be revoked.");
    internal static NixError InvitationConflict() => new(
        "workspaces.invitation_conflict",
        "The pending invitation role or protected ownership state conflicts with this request.");
    internal static NixError ProtectedOwner() => new(
        "workspaces.owner_protected",
        "The protected personal owner or last active human owner cannot be changed or removed.");
    internal static NixError RecoveryRefused() => new(
        "workspaces.recovery_refused",
        "Recovery requires an offboarded protected owner and an active human replacement.");
    internal static NixError RecoveryForbidden() => new(
        "workspaces.recovery_forbidden",
        "Only a tenant administrator can recover an accessible workspace.");
    internal static NixError ArchiveRefused() => new(
        "workspaces.archive_refused",
        "Only an owner or tenant administrator can archive an active workspace.");
    internal static NixError RestoreRefused() => new(
        "workspaces.restore_refused",
        "Only an owner or tenant administrator can restore an archived workspace.");
    internal static NixError SitesStillPublished() => new(
        "workspaces.sites_published",
        "A site in this workspace is still published or its files are still being deleted. Unpublish its sites first.");
    internal static NixError PurgeRefused() => new(
        "workspaces.purge_refused",
        "Only an owner or tenant administrator can permanently delete an archived workspace.");
}

internal static class WorkspaceAdministrationMapping
{
    internal static WorkspaceMemberResponse Member(WorkspaceMemberSnapshot row) => new(
        row.SubjectType, row.SubjectId, row.DisplayName, row.Email, row.Role, row.GrantedAt,
        row.CanChangeRole, row.CanRemove, row.AssignableRoles);
    internal static WorkspaceInvitationResponse Invitation(WorkspaceInvitationSnapshot row) => new(
        row.InvitationId, row.EmailNormalized, row.TargetPrincipalId?.Value,
        row.Role, row.Status, row.InvitedByPrincipalId.Value,
        row.InvitedAt, row.AcceptedAt, row.AcceptedByPrincipalId?.Value, row.RevokedAt);
    internal static WorkspaceInviteeResponse Invitee(WorkspaceInviteeSnapshot row) => new(
        row.PrincipalId.Value, row.DisplayName, row.Email, row.CanInvite, row.CannotInviteReason);

    internal static bool TryInviteeCursor(string? value, out PrincipalId? id)
    {
        id = null;
        if (string.IsNullOrWhiteSpace(value))
        {
            return true;
        }
        if (value.Length > WorkspaceCursor.MaximumEncodedLength)
        {
            return false;
        }
        try
        {
            var text = Encoding.UTF8.GetString(Convert.FromBase64String(value));
            if (!Guid.TryParse(text, out var parsed))
            {
                return false;
            }
            id = PrincipalId.From(parsed);
            return true;
        }
        catch (FormatException)
        {
            return false;
        }
    }

    internal static string NextInvitee(PrincipalId id) => Convert.ToBase64String(
        Encoding.UTF8.GetBytes(id.Value.ToString("D", CultureInfo.InvariantCulture)));

    internal static bool TryInvitationCursor(
        string? value,
        out DateTimeOffset? at,
        out Guid? id)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            at = null;
            id = null;
            return true;
        }
        if (value.Length > WorkspaceCursor.MaximumEncodedLength)
        {
            at = null;
            id = null;
            return false;
        }
        try
        {
            var text = Encoding.UTF8.GetString(Convert.FromBase64String(value));
            var separator = text.IndexOf(':', StringComparison.Ordinal);
            if (separator <= 0
                || !long.TryParse(text.AsSpan(0, separator), CultureInfo.InvariantCulture, out var ticks)
                || !Guid.TryParse(text.AsSpan(separator + 1), out var parsedId))
            {
                at = null;
                id = null;
                return false;
            }
            at = new DateTimeOffset(ticks, TimeSpan.Zero);
            id = parsedId;
            return true;
        }
        catch (ArgumentOutOfRangeException)
        {
            at = null;
            id = null;
            return false;
        }
        catch (FormatException)
        {
            at = null;
            id = null;
            return false;
        }
    }

    internal static bool TryMemberCursor(
        string? value,
        out DateTimeOffset? at,
        out string? subjectType,
        out Guid? id)
    {
        at = null;
        subjectType = null;
        id = null;
        if (string.IsNullOrWhiteSpace(value))
        {
            return true;
        }
        if (value.Length > WorkspaceCursor.MaximumEncodedLength)
        {
            return false;
        }
        try
        {
            var parts = Encoding.UTF8.GetString(Convert.FromBase64String(value)).Split(':');
            if (parts.Length != 3
                || !long.TryParse(parts[0], CultureInfo.InvariantCulture, out var ticks)
                || (parts[1] != "principal" && parts[1] != "group")
                || !Guid.TryParse(parts[2], out var parsedId))
            {
                return false;
            }
            at = new DateTimeOffset(ticks, TimeSpan.Zero);
            subjectType = parts[1];
            id = parsedId;
            return true;
        }
        catch (ArgumentOutOfRangeException) { return false; }
        catch (FormatException) { return false; }
    }

    internal static string NextInvitation(DateTimeOffset at, Guid id) => Convert.ToBase64String(
        Encoding.UTF8.GetBytes($"{at.UtcTicks.ToString(CultureInfo.InvariantCulture)}:{id:D}"));

    internal static string NextMember(DateTimeOffset at, string subjectType, Guid id) => Convert.ToBase64String(
        Encoding.UTF8.GetBytes(
            $"{at.UtcTicks.ToString(CultureInfo.InvariantCulture)}:{subjectType}:{id:D}"));
}

internal static class WorkspaceAdministrationEndpoints
{
    internal static async Task<Results<Ok<CursorPage<WorkspaceInviteeResponse>>, ProblemHttpResult>> ListInvitees(
        Guid workspaceId, HttpContext context, [FromServices] NixDispatcher dispatcher,
        string? cursor = null, int limit = CursorPaging.DefaultLimit, string? query = null)
    {
        var search = query?.Trim();
        if (search?.Length > 128)
        {
            return TypedResults.Problem(WorkspaceEndpoints.Problem(context,
                new NixError("workspaces.invitee_search_invalid", "Search must be 128 characters or fewer.")));
        }
        if (limit is < 1 or > CursorPaging.MaximumLimit
            || !WorkspaceAdministrationMapping.TryInviteeCursor(cursor, out var afterId))
        {
            return TypedResults.Problem(WorkspaceEndpoints.Problem(
                context, WorkspaceAdministrationErrors.InvalidCursor()));
        }
        var take = limit;
        var rows = await dispatcher.QueryAsync<ListWorkspaceInvitees, IReadOnlyList<WorkspaceInviteeSnapshot>>(
            new ListWorkspaceInvitees(WorkspaceId.From(workspaceId), afterId, take + 1, string.IsNullOrEmpty(search) ? null : search),
            context.RequestAborted).ConfigureAwait(false);
        var responses = new WorkspaceInviteeResponse[Math.Min(take, rows.Count)];
        for (var index = 0; index < responses.Length; index++)
        {
            responses[index] = WorkspaceAdministrationMapping.Invitee(rows[index]);
        }
        var next = rows.Count > take
            ? WorkspaceAdministrationMapping.NextInvitee(rows[take - 1].PrincipalId)
            : null;
        return TypedResults.Ok(new CursorPage<WorkspaceInviteeResponse>(responses, next));
    }

    internal static async Task<Results<Ok<CursorPage<WorkspaceMemberResponse>>, ProblemHttpResult>> ListMembers(
        Guid workspaceId, HttpContext context, [FromServices] NixDispatcher dispatcher,
        string? cursor = null, int limit = CursorPaging.DefaultLimit)
    {
        if (limit is < 1 or > CursorPaging.MaximumLimit
            || !WorkspaceAdministrationMapping.TryMemberCursor(
                cursor, out var after, out var afterSubjectType, out var afterId))
        {
            return TypedResults.Problem(WorkspaceEndpoints.Problem(
                context, WorkspaceAdministrationErrors.InvalidCursor()));
        }
        var take = limit;
        var rows = await dispatcher.QueryAsync<ListWorkspaceMembers, IReadOnlyList<WorkspaceMemberSnapshot>>(
            new ListWorkspaceMembers(
                WorkspaceId.From(workspaceId), after, afterSubjectType, afterId, take + 1),
            context.RequestAborted)
            .ConfigureAwait(false);
        var responses = new WorkspaceMemberResponse[Math.Min(take, rows.Count)];
        for (var index = 0; index < responses.Length; index++)
        {
            responses[index] = WorkspaceAdministrationMapping.Member(rows[index]);
        }

        var next = rows.Count > take
            ? WorkspaceAdministrationMapping.NextMember(
                rows[take - 1].GrantedAt, rows[take - 1].SubjectType, rows[take - 1].SubjectId)
            : null;
        return TypedResults.Ok(new CursorPage<WorkspaceMemberResponse>(responses, next));
    }

    internal static async Task<Results<Ok<CursorPage<WorkspaceInvitationResponse>>, ProblemHttpResult>> ListInvitations(
        Guid workspaceId, HttpContext context, [FromServices] NixDispatcher dispatcher,
        string? cursor = null, int limit = CursorPaging.DefaultLimit)
    {
        if (limit is < 1 or > CursorPaging.MaximumLimit
            || !WorkspaceAdministrationMapping.TryInvitationCursor(cursor, out var after, out var afterId))
        {
            return TypedResults.Problem(WorkspaceEndpoints.Problem(
                context, WorkspaceAdministrationErrors.InvalidCursor()));
        }
        var take = limit;
        var rows = await dispatcher.QueryAsync<ListWorkspaceInvitations, IReadOnlyList<WorkspaceInvitationSnapshot>>(
            new ListWorkspaceInvitations(WorkspaceId.From(workspaceId), after, afterId, take + 1),
            context.RequestAborted).ConfigureAwait(false);
        var responses = new WorkspaceInvitationResponse[Math.Min(take, rows.Count)];
        for (var index = 0; index < responses.Length; index++)
        {
            responses[index] = WorkspaceAdministrationMapping.Invitation(rows[index]);
        }

        var next = rows.Count > take
            ? WorkspaceAdministrationMapping.NextInvitation(
                rows[take - 1].InvitedAt, rows[take - 1].InvitationId)
            : null;
        return TypedResults.Ok(new CursorPage<WorkspaceInvitationResponse>(responses, next));
    }

    internal static async Task<Results<Created<WorkspaceInvitationResponse>, ProblemHttpResult>> Invite(
        Guid workspaceId, CreateWorkspaceInvitationRequest request, HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<InviteWorkspaceMember, WorkspaceInvitationSnapshot>(
            new InviteWorkspaceMember(
                WorkspaceId.From(workspaceId), PrincipalId.From(request.PrincipalId), request.Role),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Created<WorkspaceInvitationResponse>, ProblemHttpResult>>(
            row => TypedResults.Created(
                $"/api/v1/workspaces/{workspaceId:D}/invitations/{row.InvitationId:D}",
                WorkspaceAdministrationMapping.Invitation(row)),
            error => TypedResults.Problem(WorkspaceEndpoints.Problem(context, error)));
    }

    internal static async Task<Results<NoContent, ProblemHttpResult>> AcceptInvitation(
        Guid workspaceId, Guid invitationId, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<AcceptWorkspaceInvitation, bool>(
            new AcceptWorkspaceInvitation(WorkspaceId.From(workspaceId), invitationId),
            context.RequestAborted).ConfigureAwait(false);
        return result.IsSuccess ? TypedResults.NoContent()
            : TypedResults.Problem(WorkspaceEndpoints.Problem(context, result.Error));
    }

    internal static async Task<Results<NoContent, ProblemHttpResult>> DeclineInvitation(
        Guid workspaceId, Guid invitationId, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<DeclineWorkspaceInvitation, bool>(
            new DeclineWorkspaceInvitation(WorkspaceId.From(workspaceId), invitationId),
            context.RequestAborted).ConfigureAwait(false);
        return result.IsSuccess ? TypedResults.NoContent()
            : TypedResults.Problem(WorkspaceEndpoints.Problem(context, result.Error));
    }

    internal static async Task<Results<NoContent, ProblemHttpResult>> RevokeInvitation(
        Guid workspaceId, Guid invitationId, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<RevokeWorkspaceInvitation, bool>(
            new RevokeWorkspaceInvitation(WorkspaceId.From(workspaceId), invitationId),
            context.RequestAborted).ConfigureAwait(false);
        return result.IsSuccess
            ? TypedResults.NoContent()
            : TypedResults.Problem(WorkspaceEndpoints.Problem(context, result.Error));
    }

    internal static async Task<Results<Ok<WorkspaceMemberResponse>, ProblemHttpResult>> ChangeMember(
        Guid workspaceId, Guid principalId, ChangeWorkspaceMemberRoleRequest request, HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<ChangeWorkspaceMemberRole, WorkspaceMemberSnapshot>(
            new ChangeWorkspaceMemberRole(WorkspaceId.From(workspaceId), PrincipalId.From(principalId), request.Role),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<WorkspaceMemberResponse>, ProblemHttpResult>>(
            member => TypedResults.Ok(WorkspaceAdministrationMapping.Member(member)),
            error => TypedResults.Problem(WorkspaceEndpoints.Problem(context, error)));
    }

    internal static async Task<Results<NoContent, ProblemHttpResult>> RemoveMember(
        Guid workspaceId, Guid principalId, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<RemoveWorkspaceMember, bool>(
            new RemoveWorkspaceMember(WorkspaceId.From(workspaceId), PrincipalId.From(principalId)),
            context.RequestAborted).ConfigureAwait(false);
        return result.IsSuccess ? TypedResults.NoContent()
            : TypedResults.Problem(WorkspaceEndpoints.Problem(context, result.Error));
    }

    internal static async Task<Results<NoContent, ProblemHttpResult>> Leave(
        Guid workspaceId, HttpContext context, [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<LeaveWorkspace, bool>(
            new LeaveWorkspace(WorkspaceId.From(workspaceId)), context.RequestAborted).ConfigureAwait(false);
        return result.IsSuccess ? TypedResults.NoContent()
            : TypedResults.Problem(WorkspaceEndpoints.Problem(context, result.Error));
    }

    internal static async Task<Results<Ok<WorkspaceResponse>, ProblemHttpResult>> Recover(
        Guid workspaceId, RecoverWorkspaceRequest request, HttpContext context,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher.SendAsync<RecoverWorkspace, WorkspaceSnapshot>(
            new RecoverWorkspace(WorkspaceId.From(workspaceId), PrincipalId.From(request.NewOwnerPrincipalId)),
            context.RequestAborted).ConfigureAwait(false);
        return result.Match<Results<Ok<WorkspaceResponse>, ProblemHttpResult>>(
            row => TypedResults.Ok(WorkspaceEndpoints.ToResponse(row)),
            error => TypedResults.Problem(WorkspaceEndpoints.Problem(context, error)));
    }
}
