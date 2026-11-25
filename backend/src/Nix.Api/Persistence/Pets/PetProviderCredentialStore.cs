using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Pets;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.Pets;

/// <summary>Stores provider keys in the request's RLS transaction; rows are the owner's alone.</summary>
public sealed class PetProviderCredentialStore(NixDbContext db) : IPetProviderCredentialStore
{
    /// <inheritdoc />
    public async ValueTask<PetProviderCredential?> FindAsync(TenantId tenantId, PrincipalId principalId, string provider, CancellationToken cancellationToken) =>
        await db.Set<PetProviderCredential>().AsNoTracking()
            .SingleOrDefaultAsync(row => row.TenantId == tenantId && row.PrincipalId == principalId && row.Provider == provider, cancellationToken)
            .ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<PetProviderCredential>> ListAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken) =>
        await db.Set<PetProviderCredential>().AsNoTracking()
            .Where(row => row.TenantId == tenantId && row.PrincipalId == principalId)
            .OrderBy(row => row.Provider)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

    /// <inheritdoc />
    public async Task SaveAsync(PetProviderCredential credential, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(credential);
        await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO pet_provider_credential (tenant_id, principal_id, provider, protected_key, key_hint, saved_at)
            VALUES ({credential.TenantId.Value}, {credential.PrincipalId.Value}, {credential.Provider}, {credential.ProtectedKey.ToArray()}, {credential.KeyHint}, {credential.SavedAt})
            ON CONFLICT (tenant_id, principal_id, provider) DO UPDATE
            SET protected_key = EXCLUDED.protected_key, key_hint = EXCLUDED.key_hint,
                saved_at = GREATEST(EXCLUDED.saved_at, pet_provider_credential.saved_at + interval '1 microsecond')
            """, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async Task<bool> RemoveAsync(TenantId tenantId, PrincipalId principalId, string provider, CancellationToken cancellationToken) =>
        await db.Set<PetProviderCredential>()
            .Where(row => row.TenantId == tenantId && row.PrincipalId == principalId && row.Provider == provider)
            .ExecuteDeleteAsync(cancellationToken)
            .ConfigureAwait(false) == 1;
}
