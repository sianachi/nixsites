using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Nix.Abstractions;
using Nix.Domain.Audit;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Views;

namespace Nix.Persistence;

/// <summary>EF-backed storage for revocable public form capabilities.</summary>
public sealed class PublicFormStore(
    NixDbContext database,
    ScopedNixSessionContextAccessor session,
    IFinanceLock topology)
    : IPublicFormStore
{
    private readonly ScopedNixSessionContextAccessor _session = session;
    private readonly IFinanceLock _topology = topology;

    /// <inheritdoc />
    public async ValueTask<IPublicFormTransaction> BeginAsync(
        NixSessionContext context,
        CancellationToken cancellationToken)
    {
        _session.Set(context);
        var transaction = await database.Database.BeginTransactionAsync(cancellationToken)
            .ConfigureAwait(false);
        return new PublicFormTransaction(transaction);
    }

    /// <inheritdoc />
    public async ValueTask<PublicFormLink?> FindAsync(Guid linkId, CancellationToken cancellationToken) =>
        await database.PublicFormLinks.SingleOrDefaultAsync(
            link => link.Id == linkId,
            cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<bool> IsActivePrincipalAsync(
        PrincipalId principalId,
        CancellationToken cancellationToken) =>
        await database.Principals.AnyAsync(
            principal => principal.Id == principalId && principal.Status == PrincipalStatus.Active,
            cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public async ValueTask<bool> LockSubmissionAsync(PublicFormLink link, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(link);
        var context = _session.Current
            ?? throw new InvalidOperationException("Public form submissions require a tenant session.");
        // Match CreateItem's topology-first order before holding the parent against view changes.
        await _topology.AcquireWorkspaceTopologyAsync(link.WorkspaceId, cancellationToken).ConfigureAwait(false);
        var item = await database.Items.FromSqlInterpolated(
                $"SELECT * FROM item WHERE tenant_id = {context.TenantId.Value} AND id = {link.ItemId.Value} AND workspace_id = {link.WorkspaceId.Value} FOR UPDATE")
            .AsNoTracking().SingleOrDefaultAsync(cancellationToken).ConfigureAwait(false);
        return item is { TemplateId: null, LifecycleState: ItemLifecycleState.Active };
    }

    /// <inheritdoc />
    public async ValueTask<PublicFormLink?> FindForUpdateAsync(
        ItemId itemId,
        string viewId,
        CancellationToken cancellationToken) =>
        await database.PublicFormLinks.AsTracking().SingleOrDefaultAsync(
            link => link.ItemId == itemId && link.ViewId == viewId,
            cancellationToken).ConfigureAwait(false);

    /// <inheritdoc />
    public void Add(PublicFormLink link, Principal principal, WorkspaceMember membership)
    {
        database.Principals.Add(principal);
        database.WorkspaceMembers.Add(membership);
        database.PublicFormLinks.Add(link);
    }

    /// <inheritdoc />
    public void AddAudit(AuditEvent auditEvent) => database.AuditEvents.Add(auditEvent);

    /// <inheritdoc />
    public Task SaveAsync(CancellationToken cancellationToken) =>
        database.SaveChangesAsync(cancellationToken);

    private sealed class PublicFormTransaction(IDbContextTransaction transaction) : IPublicFormTransaction
    {
        public Task CommitAsync(CancellationToken cancellationToken) =>
            transaction.CommitAsync(cancellationToken);

        public ValueTask DisposeAsync() => transaction.DisposeAsync();
    }
}
