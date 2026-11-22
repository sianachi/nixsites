using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Notifications;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.Notifications;

/// <summary>Stores registered devices in the request's RLS transaction.</summary>
public sealed class PushSubscriptionStore(NixDbContext db) : IPushSubscriptionStore
{
    /// <inheritdoc />
    public async Task<IReadOnlyList<PushSubscription>> ListAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken) =>
        await db.Set<PushSubscription>().AsNoTracking()
            .Where(row => row.TenantId == tenantId && row.PrincipalId == principalId)
            .OrderByDescending(row => row.CreatedAt)
            .ToListAsync(cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async Task LockAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken) =>
        await new AdvisoryLocks(db).LockPushSubscriptionAsync(tenantId.Value, principalId.Value, cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async Task<PushSubscription> SaveAsync(PushSubscription subscription, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(subscription);

        // Re-registering the same browser (a token refresh, a re-subscribe after
        // pushsubscriptionchange) replaces the existing row for that endpoint rather than growing
        // a duplicate; the unique index on (tenant_id, principal_id, endpoint) is what this relies on.
        await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO push_subscription (tenant_id, id, principal_id, endpoint, p256dh, auth, user_agent, created_at, last_success_at, failures)
            VALUES ({subscription.TenantId.Value}, {subscription.Id}, {subscription.PrincipalId.Value}, {subscription.Endpoint},
                {subscription.P256dh}, {subscription.Auth}, {subscription.UserAgent}, {subscription.CreatedAt}, NULL, 0)
            ON CONFLICT (tenant_id, principal_id, endpoint) DO UPDATE SET
                p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent, failures = 0
            """, cancellationToken).ConfigureAwait(false);

        return await db.Set<PushSubscription>().AsNoTracking()
            .SingleAsync(row => row.TenantId == subscription.TenantId && row.PrincipalId == subscription.PrincipalId && row.Endpoint == subscription.Endpoint, cancellationToken)
            .ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async Task<bool> RemoveAsync(TenantId tenantId, PrincipalId principalId, string endpoint, CancellationToken cancellationToken) =>
        await db.Set<PushSubscription>()
            .Where(row => row.TenantId == tenantId && row.PrincipalId == principalId && row.Endpoint == endpoint)
            .ExecuteDeleteAsync(cancellationToken).ConfigureAwait(false) == 1;

    /// <inheritdoc />
    public async Task<bool> RemoveByIdAsync(TenantId tenantId, PrincipalId principalId, Guid id, CancellationToken cancellationToken) =>
        await db.Set<PushSubscription>()
            .Where(row => row.TenantId == tenantId && row.PrincipalId == principalId && row.Id == id)
            .ExecuteDeleteAsync(cancellationToken).ConfigureAwait(false) == 1;

    /// <inheritdoc />
    public Task RecordDeliveredAsync(TenantId tenantId, PrincipalId principalId, Guid id, CancellationToken cancellationToken) =>
        db.Set<PushSubscription>()
            .Where(row => row.TenantId == tenantId && row.PrincipalId == principalId && row.Id == id)
            .ExecuteUpdateAsync(setters => setters
                .SetProperty(row => row.LastSuccessAt, DateTimeOffset.UtcNow)
                .SetProperty(row => row.Failures, 0), cancellationToken);

    /// <inheritdoc />
    public async Task RecordFailedAsync(TenantId tenantId, PrincipalId principalId, Guid id, CancellationToken cancellationToken)
    {
        // Five consecutive failures removes the device (ADR-0051 section 5); a success anywhere
        // in between already reset the count to zero above, so this only ever counts a streak.
        await db.Set<PushSubscription>()
            .Where(row => row.TenantId == tenantId && row.PrincipalId == principalId && row.Id == id)
            .ExecuteUpdateAsync(setters => setters
                .SetProperty(row => row.Failures, row => row.Failures + 1), cancellationToken)
            .ConfigureAwait(false);
        await db.Set<PushSubscription>()
            .Where(row => row.TenantId == tenantId && row.PrincipalId == principalId && row.Id == id && row.Failures >= 5)
            .ExecuteDeleteAsync(cancellationToken).ConfigureAwait(false);
    }
}
