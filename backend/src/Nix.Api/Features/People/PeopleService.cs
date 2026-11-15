using Nix.Abstractions;
using Nix.Authentication;
using Nix.Domain.Identity;
using Nix.Features.LocalAuth;
using Nix.Features.Roles;
using Nix.Persistence.Identity;

namespace Nix.Features.People;

/// <summary>Why a People action did not happen. The endpoint maps each to one status and code.</summary>
public enum PeopleRefusal
{
    /// <summary>Nothing was refused.</summary>
    None,

    /// <summary>The caller is not a tenant administrator.</summary>
    NotAdministrator,

    /// <summary>No such local person in the caller's organization.</summary>
    NotFound,

    /// <summary>The email is not usable as a sign-in name.</summary>
    EmailInvalid,

    /// <summary>The name is empty or too long.</summary>
    NameInvalid,

    /// <summary>The email is already used by a local account.</summary>
    EmailTaken,

    /// <summary>An administrator tried to disable themselves.</summary>
    SelfDisable,

    /// <summary>Disabling would leave no active administrator.</summary>
    LastAdministrator,

    /// <summary>An administrator asked for a reset link for themselves.</summary>
    SelfReset,
}

/// <summary>The guards on disabling a person, kept pure so they can be tested without a database.</summary>
public static class PeopleRules
{
    /// <summary>The longest display name accepted for a new person.</summary>
    public const int MaximumNameLength = 200;

    /// <summary>Whether <paramref name="actor"/> may disable <paramref name="target"/>.</summary>
    /// <param name="actor">The administrator acting.</param>
    /// <param name="target">The person to disable.</param>
    /// <param name="anotherAdministratorRemains">Whether an active administrator other than the target stays.</param>
    public static PeopleRefusal CheckDisable(Guid actor, Guid target, bool anotherAdministratorRemains) =>
        actor == target ? PeopleRefusal.SelfDisable
        : anotherAdministratorRemains ? PeopleRefusal.None
        : PeopleRefusal.LastAdministrator;
}

/// <summary>
/// What a tenant administrator does on the People page. Every method checks the administrator role itself,
/// so an endpoint cannot forget to.
/// </summary>
public sealed class PeopleService(
    IPeopleStore store,
    IPermissionResolver permissions,
    IAccessGrantStore grants,
    INixSessionContextAccessor session,
    ILocalAccounts accounts,
    LocalAccountProvisioner provisioner,
    LocalLinkIssuer links,
    TimeProvider clock)
{
    /// <summary>The organization's local accounts.</summary>
    public async ValueTask<(IReadOnlyList<PersonResponse>? People, PeopleRefusal Refusal)> ListAsync(CancellationToken cancellationToken)
    {
        if (!await permissions.IsTenantAdministratorAsync(cancellationToken).ConfigureAwait(false))
        {
            return (null, PeopleRefusal.NotAdministrator);
        }

        return (await store.ListAsync(Context().TenantId.Value, cancellationToken).ConfigureAwait(false), PeopleRefusal.None);
    }

    /// <summary>Creates the person and a setup link.</summary>
    public async ValueTask<(AddPersonResponse? Added, PeopleRefusal Refusal)> AddAsync(
        string? email, string? name, CancellationToken cancellationToken)
    {
        if (!await permissions.IsTenantAdministratorAsync(cancellationToken).ConfigureAwait(false))
        {
            return (null, PeopleRefusal.NotAdministrator);
        }

        if (!LocalAccountEmail.TryNormalize(email, out var normalized))
        {
            return (null, PeopleRefusal.EmailInvalid);
        }

        var trimmed = name?.Trim();
        if (string.IsNullOrEmpty(trimmed) || trimmed.Length > PeopleRules.MaximumNameLength)
        {
            return (null, PeopleRefusal.NameInvalid);
        }

        var context = Context();
        var created = await provisioner.CreateAsync(context.TenantId, normalized, trimmed, passwordHash: null, cancellationToken).ConfigureAwait(false);
        if (created.Outcome != LocalProvisionOutcome.Created || created.Principal is null)
        {
            return (null, PeopleRefusal.EmailTaken);
        }

        var link = await links.IssueAsync(created.Principal.Id, LocalLinkPurpose.Setup, context.PrincipalId, cancellationToken).ConfigureAwait(false);
        if (link is null)
        {
            return (null, PeopleRefusal.NotFound);
        }

        await AuditAsync("tenant.person_added", created.Principal.Id.Value, cancellationToken).ConfigureAwait(false);
        var person = (await store.ListAsync(context.TenantId.Value, cancellationToken).ConfigureAwait(false))
            .First(p => p.Id == created.Principal.Id.Value);
        return (new AddPersonResponse(person, new PersonLinkResponse(new Uri(link.Url), link.ExpiresAt)), PeopleRefusal.None);
    }

    /// <summary>Issues a one-hour reset link; any earlier unused link of that person stops working.</summary>
    public async ValueTask<(PersonLinkResponse? Link, PeopleRefusal Refusal)> ResetLinkAsync(Guid personId, CancellationToken cancellationToken)
    {
        if (!await permissions.IsTenantAdministratorAsync(cancellationToken).ConfigureAwait(false))
        {
            return (null, PeopleRefusal.NotAdministrator);
        }

        var context = Context();
        // A link for yourself would swap your own credentials without the re-check Settings > Security makes.
        if (personId == context.PrincipalId.Value)
        {
            return (null, PeopleRefusal.SelfReset);
        }

        if (!await InTenantAsync(context, personId, cancellationToken).ConfigureAwait(false))
        {
            return (null, PeopleRefusal.NotFound);
        }

        var link = await links.IssueAsync(PrincipalId.From(personId), LocalLinkPurpose.Reset, context.PrincipalId, cancellationToken).ConfigureAwait(false);
        if (link is null)
        {
            return (null, PeopleRefusal.NotFound);
        }

        await AuditAsync("tenant.person_reset_link_issued", personId, cancellationToken).ConfigureAwait(false);
        return (new PersonLinkResponse(new Uri(link.Url), link.ExpiresAt), PeopleRefusal.None);
    }

    /// <summary>Disables (revoking their sessions) or re-enables a person.</summary>
    public async ValueTask<PeopleRefusal> SetDisabledAsync(Guid personId, bool disabled, CancellationToken cancellationToken)
    {
        if (!await permissions.IsTenantAdministratorAsync(cancellationToken).ConfigureAwait(false))
        {
            return PeopleRefusal.NotAdministrator;
        }

        var context = Context();
        if (!await InTenantAsync(context, personId, cancellationToken).ConfigureAwait(false))
        {
            return PeopleRefusal.NotFound;
        }

        if (disabled)
        {
            // The check also locks the tenant's admin grants until this request's transaction ends.
            var refusal = PeopleRules.CheckDisable(
                context.PrincipalId.Value,
                personId,
                await grants.AnyOtherTenantAdminAsync(PrincipalId.From(personId), cancellationToken).ConfigureAwait(false));
            if (refusal != PeopleRefusal.None)
            {
                return refusal;
            }
        }

        if (!await store.SetDisabledAsync(context.TenantId.Value, personId, disabled, cancellationToken).ConfigureAwait(false))
        {
            return PeopleRefusal.NotFound;
        }

        await AuditAsync(disabled ? "tenant.person_disabled" : "tenant.person_enabled", personId, cancellationToken).ConfigureAwait(false);
        return PeopleRefusal.None;
    }

    // A person of another tenant is as invisible as one that does not exist.
    private async ValueTask<bool> InTenantAsync(NixSessionContext context, Guid personId, CancellationToken cancellationToken) =>
        await accounts.FindByPrincipalAsync(PrincipalId.From(personId), cancellationToken).ConfigureAwait(false) is { } account
        && account.TenantId == context.TenantId;

    private async ValueTask AuditAsync(string action, Guid subject, CancellationToken cancellationToken)
    {
        var context = Context();
        grants.AddAudit(AccessAudit.Event(context.TenantId, context.PrincipalId, action, subject, clock.GetUtcNow()));
        await grants.SaveAsync(cancellationToken).ConfigureAwait(false);
    }

    private NixSessionContext Context() =>
        session.Current ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
}
