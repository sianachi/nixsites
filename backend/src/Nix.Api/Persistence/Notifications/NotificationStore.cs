using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Nix.Abstractions;
using Nix.Abstractions.Notifications;
using Nix.Abstractions.Workers;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Notifications;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.Notifications;

/// <summary>
/// Reads and updates a principal's own inbox, and creates notifications on a recipient's behalf.
/// </summary>
/// <remarks>
/// <see cref="INotificationWriter.CreateAsync"/> takes its tenant from the current session, the
/// same as <see cref="PrincipalPreferencesStore"/> and every other principal-scoped store; the
/// caller supplies which principal the notification is for, and row-level security's <c>WITH
/// CHECK</c> refuses the insert if that principal does not match the session that opened it -
/// fail-closed, the same guarantee <c>Rls_refuses_a_forged_owner_on_insert</c> proves for
/// pet_preferences.
/// </remarks>
public sealed class NotificationStore(
    NixDbContext db,
    INixSessionContextAccessor session,
    IPushSubscriptionStore pushSubscriptions,
    IWorkerJobStore workerJobs,
    IConfiguration configuration) : INotificationStore, INotificationWriter
{
    private const string VapidPublicKeyConfigurationKey = "Nix:Push:VapidPublicKey";
    /// <inheritdoc />
    public async Task<NotificationPage> ListAsync(TenantId tenantId, PrincipalId principalId, long? afterSeq, bool unreadOnly, int limit, CancellationToken cancellationToken)
    {
        var query = db.Set<Notification>().AsNoTracking()
            .Where(row => row.TenantId == tenantId && row.PrincipalId == principalId);
        if (unreadOnly)
        {
            query = query.Where(row => row.ReadAt == null);
        }

        if (afterSeq is { } cursor)
        {
            query = query.Where(row => row.Seq < cursor);
        }

        // One row past the page tells whether another page exists, so the last page never hands
        // out a cursor that leads to an empty one.
        var fetched = await query.OrderByDescending(row => row.Seq).Take(limit + 1).ToListAsync(cancellationToken).ConfigureAwait(false);
        var items = fetched.Count > limit ? fetched.GetRange(0, limit) : fetched;
        var (unread, revision) = await SummaryAsync(tenantId, principalId, cancellationToken).ConfigureAwait(false);
        var nextCursor = fetched.Count > limit ? items[^1].Seq.ToString(System.Globalization.CultureInfo.InvariantCulture) : null;
        return new NotificationPage(items, nextCursor, unread, revision);
    }

    /// <inheritdoc />
    public async Task<(int Unread, long Revision)> SummaryAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken)
    {
        // One statement, so the unread count and the revision come from the same snapshot. The
        // count is served by the partial index on unread rows; the revision is one primary-key probe.
        var summary = await db.Database.SqlQuery<InboxSummary>($"""
            SELECT
                (SELECT count(*)::int FROM notification
                  WHERE tenant_id = {tenantId.Value} AND principal_id = {principalId.Value} AND read_at IS NULL) AS "Unread",
                COALESCE((SELECT revision FROM notification_inbox
                  WHERE tenant_id = {tenantId.Value} AND principal_id = {principalId.Value}), 0) AS "Revision"
            """).SingleAsync(cancellationToken).ConfigureAwait(false);
        return (summary.Unread, summary.Revision);
    }

    /// <inheritdoc />
    public async Task<Notification?> GetAsync(TenantId tenantId, PrincipalId principalId, Guid notificationId, CancellationToken cancellationToken) =>
        await db.Set<Notification>().AsNoTracking()
            .SingleOrDefaultAsync(row => row.TenantId == tenantId && row.PrincipalId == principalId && row.Id == notificationId, cancellationToken)
            .ConfigureAwait(false);

    /// <inheritdoc />
    public async Task<bool> MarkReadAsync(TenantId tenantId, PrincipalId principalId, Guid notificationId, CancellationToken cancellationToken)
    {
        var updated = await db.Set<Notification>()
            .Where(row => row.TenantId == tenantId && row.PrincipalId == principalId && row.Id == notificationId && row.ReadAt == null)
            .ExecuteUpdateAsync(setters => setters.SetProperty(row => row.ReadAt, DateTimeOffset.UtcNow), cancellationToken)
            .ConfigureAwait(false);
        if (updated == 1)
        {
            await BumpRevisionAsync(tenantId, principalId, cancellationToken).ConfigureAwait(false);
            return true;
        }

        return await db.Set<Notification>().AsNoTracking()
            .AnyAsync(row => row.TenantId == tenantId && row.PrincipalId == principalId && row.Id == notificationId, cancellationToken)
            .ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async Task MarkAllReadAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken)
    {
        var updated = await db.Set<Notification>()
            .Where(row => row.TenantId == tenantId && row.PrincipalId == principalId && row.ReadAt == null)
            .ExecuteUpdateAsync(setters => setters.SetProperty(row => row.ReadAt, DateTimeOffset.UtcNow), cancellationToken)
            .ConfigureAwait(false);
        if (updated > 0)
        {
            await BumpRevisionAsync(tenantId, principalId, cancellationToken).ConfigureAwait(false);
        }
    }

    /// <inheritdoc />
    public async Task<NotificationWriteResult> CreateAsync(
        PrincipalId principal,
        NotificationKind kind,
        string title,
        string body,
        ItemId? itemId,
        WorkspaceId? workspaceId,
        string dedupeKey,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(dedupeKey);
        var context = session.Current ?? throw new InvalidOperationException("A session is required.");
        if (context.PrincipalId != principal)
        {
            // Row-level security would refuse this insert anyway; saying so here gives the caller
            // a clear programming error instead of an opaque policy violation from the database.
            throw new InvalidOperationException("A notification is written from a session scoped to its recipient.");
        }

        var id = Guid.CreateVersion7();
        var createdAt = DateTimeOffset.UtcNow;
        var kindText = NotificationKindStorage.ToText(kind);
        Guid? itemIdValue = itemId.HasValue ? itemId.Value.Value : null;
        Guid? workspaceIdValue = workspaceId.HasValue ? workspaceId.Value.Value : null;

        // ON CONFLICT DO NOTHING makes this idempotent per (tenant, principal, dedupe key): a
        // redelivered trigger or a retried worker call lands on the row that already exists
        // instead of a second one, and the affected-row count says which happened.
        var inserted = await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO notification (tenant_id, id, principal_id, kind, title, body, item_id, workspace_id, created_at, dedupe_key)
            VALUES ({context.TenantId.Value}, {id}, {principal.Value}, {kindText}, {title}, {body},
                {itemIdValue}, {workspaceIdValue},
                {createdAt}, {dedupeKey})
            ON CONFLICT (tenant_id, principal_id, dedupe_key) DO NOTHING
            """, cancellationToken).ConfigureAwait(false);
        if (inserted == 1)
        {
            await BumpRevisionAsync(context.TenantId, principal, cancellationToken).ConfigureAwait(false);
            await EnqueuePushAsync(context.TenantId, principal, id, workspaceId, cancellationToken).ConfigureAwait(false);
        }

        var row = await db.Set<Notification>().AsNoTracking()
            .SingleAsync(row => row.TenantId == context.TenantId && row.PrincipalId == principal && row.DedupeKey == dedupeKey, cancellationToken)
            .ConfigureAwait(false);
        return new NotificationWriteResult(row, inserted == 1);
    }

    /// <inheritdoc />
    public async Task<bool> ClaimPushAsync(TenantId tenantId, PrincipalId principalId, Guid notificationId, CancellationToken cancellationToken) =>
        await db.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE notification
               SET push_attempted_at = clock_timestamp()
             WHERE tenant_id = {tenantId.Value} AND principal_id = {principalId.Value} AND id = {notificationId}
               AND push_attempted_at IS NULL
            """, cancellationToken).ConfigureAwait(false) == 1;

    // A push is enqueued only for a newly created notification (never a deduplicated one), only
    // when the recipient has a device to push to, and only when push is configured at all - an
    // unconfigured Nix:Push:VapidPublicKey means the inbox still works and push stays unavailable
    // (ADR-0051 section 5 and its consequences). The job rides the same transaction as the
    // notification insert above: both commit together, or neither does.
    private async Task EnqueuePushAsync(
        TenantId tenantId,
        PrincipalId principal,
        Guid notificationId,
        WorkspaceId? workspaceId,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(configuration[VapidPublicKeyConfigurationKey]))
        {
            return;
        }

        var devices = await pushSubscriptions.ListAsync(tenantId, principal, cancellationToken).ConfigureAwait(false);
        if (devices.Count == 0)
        {
            return;
        }

        var payload = JsonSerializer.Serialize(
            new NotifyPushJobPayload(notificationId),
            NotifyPushJobJsonContext.Default.NotifyPushJobPayload);
        await workerJobs.CreateAsync(
            tenantId,
            principal,
            workspaceId,
            "notify.push",
            $"notify:{notificationId:D}",
            payload,
            cancellationToken).ConfigureAwait(false);
    }

    // Every change to an inbox bumps its counter in the same transaction; the row lock orders the
    // bumps by commit, which is what lets a watcher trust "revision greater than what I saw".
    private Task<int> BumpRevisionAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken) =>
        db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO notification_inbox (tenant_id, principal_id, revision)
            VALUES ({tenantId.Value}, {principalId.Value}, 1)
            ON CONFLICT (tenant_id, principal_id) DO UPDATE SET revision = notification_inbox.revision + 1
            """, cancellationToken);

    [System.Diagnostics.CodeAnalysis.SuppressMessage("Performance", "CA1812:Avoid uninstantiated internal classes", Justification = "EF Core materialises SqlQuery rows through reflection.")]
    private sealed record InboxSummary(int Unread, long Revision);
}
