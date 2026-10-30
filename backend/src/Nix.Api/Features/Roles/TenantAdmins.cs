using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Primitives;
using Nix.Messaging;

namespace Nix.Features.Roles;

/// <summary>Stable error codes of tenant administrator changes.</summary>
public static class TenantAdminErrors
{
    /// <summary>The caller is not a tenant administrator.</summary>
    public const string AdministratorRequiredCode = "roles.administrator_required";

    /// <summary>No such principal in the caller's tenant.</summary>
    public const string PrincipalNotFoundCode = "identity.principal_not_found";

    /// <summary>The change would leave the tenant without an administrator.</summary>
    public const string LastAdministratorCode = "roles.last_administrator";
}

/// <summary>The principals holding the tenant admin role; empty unless the caller is an administrator.</summary>
public sealed record ListTenantAdmins : IQuery<IReadOnlyList<AccessGrantRow>>;

/// <summary>Makes a principal of the caller's tenant a tenant administrator; idempotent.</summary>
/// <param name="PrincipalId">Who to grant.</param>
public sealed record GrantTenantAdmin(Guid PrincipalId) : ICommand<Guid>;

/// <summary>Removes a principal's direct admin role; idempotent. Refused for the last administrator.</summary>
/// <param name="PrincipalId">Who to revoke.</param>
public sealed record RevokeTenantAdmin(Guid PrincipalId) : ICommand<Guid>;

/// <summary>Lists, grants and revokes tenant administrators. Group grants are not managed here.</summary>
public sealed class TenantAdminHandlers(
    IAccessGrantStore grants,
    IPrincipalDirectory principals,
    IPermissionResolver permissions,
    INixSessionContextAccessor session,
    TimeProvider clock) :
    IQueryHandler<ListTenantAdmins, IReadOnlyList<AccessGrantRow>>,
    ICommandHandler<GrantTenantAdmin, Guid>,
    ICommandHandler<RevokeTenantAdmin, Guid>
{
    public async ValueTask<IReadOnlyList<AccessGrantRow>> HandleAsync(ListTenantAdmins query, CancellationToken cancellationToken) =>
        await permissions.IsTenantAdministratorAsync(cancellationToken).ConfigureAwait(false)
            ? await grants.ListTenantAdminsAsync(cancellationToken).ConfigureAwait(false)
            : [];

    public async ValueTask<Result<Guid>> HandleAsync(GrantTenantAdmin command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (!await permissions.IsTenantAdministratorAsync(cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<Guid>(Required());
        }

        var target = PrincipalId.From(command.PrincipalId);
        if (await principals.FindAsync(target, cancellationToken).ConfigureAwait(false) is null)
        {
            return Result.Failure<Guid>(new(TenantAdminErrors.PrincipalNotFoundCode, "No such person in this organization."));
        }

        var context = Context();
        var now = clock.GetUtcNow();
        if (await grants.AddTenantAdminAsync(target, context.PrincipalId, now, cancellationToken).ConfigureAwait(false))
        {
            grants.AddAudit(AccessAudit.Event(context.TenantId, context.PrincipalId, "tenant.admin_granted", command.PrincipalId, now));
            await grants.SaveAsync(cancellationToken).ConfigureAwait(false);
        }

        return Result.Success(command.PrincipalId);
    }

    public async ValueTask<Result<Guid>> HandleAsync(RevokeTenantAdmin command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (!await permissions.IsTenantAdministratorAsync(cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<Guid>(Required());
        }

        var target = PrincipalId.From(command.PrincipalId);
        // The check locks the tenant's admin grants; the delete below runs in the same transaction.
        if (!await grants.AnyOtherTenantAdminAsync(target, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<Guid>(new(TenantAdminErrors.LastAdministratorCode, "The last administrator cannot be removed; make someone else an administrator first."));
        }

        var context = Context();
        if (await grants.RemoveTenantAdminAsync(target, cancellationToken).ConfigureAwait(false))
        {
            grants.AddAudit(AccessAudit.Event(context.TenantId, context.PrincipalId, "tenant.admin_revoked", command.PrincipalId, clock.GetUtcNow()));
            await grants.SaveAsync(cancellationToken).ConfigureAwait(false);
        }

        return Result.Success(command.PrincipalId);
    }

    private static NixError Required() =>
        new(TenantAdminErrors.AdministratorRequiredCode, "Only a tenant administrator can change who administers the organization.");

    private NixSessionContext Context() =>
        session.Current ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
}
