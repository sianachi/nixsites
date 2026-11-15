namespace Nix.Features.People;

/// <summary>The People page's two database operations, both tenant-scoped inside the SQL function.</summary>
public interface IPeopleStore
{
    /// <summary>Every local account of the tenant, oldest first.</summary>
    public ValueTask<IReadOnlyList<PersonResponse>> ListAsync(Guid tenantId, CancellationToken cancellationToken);

    /// <summary>Disables or re-enables a local person; disabling also revokes their browser sessions. False when no such person.</summary>
    public ValueTask<bool> SetDisabledAsync(Guid tenantId, Guid principalId, bool disabled, CancellationToken cancellationToken);
}
