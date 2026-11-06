using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Audit;
using Nix.Domain.Files;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.PublicLinks;
using Nix.Domain.Tenancy;
using Nix.Persistence;

namespace Nix.Features.PublicLinks;

/// <summary>
/// [SEC] Storage and the anonymous resolver for public links. Resolving establishes the link's tenant
/// session and leaves a read transaction open for the rest of the request (it rolls back with the
/// scope), so whatever the handler reads next runs as the link's Viewer service principal under RLS.
/// </summary>
#pragma warning disable CA1812 // Constructed by ASP.NET Core dependency injection.
internal sealed class PublicLinkStore(
    NixDbContext database,
    ScopedNixSessionContextAccessor session,
    IItemTree tree,
    PublicLinkTokenService tokens,
    IConfiguration configuration,
    TimeProvider clock)
    : IPublicLinkResolver, IPublicLinkLifecycle
{
    /// <inheritdoc />
    public async ValueTask<ResolvedPublicLink?> ResolveAsync(string token, CancellationToken cancellationToken)
    {
        if (!PublicLinkSettings.IsEnabled(configuration) || !tokens.TryRead(token, out var payload))
        {
            return null;
        }

        var tenantId = TenantId.From(payload.TenantId);
        session.Set(NixSessionContext.ForTenant(tenantId, PrincipalId.From(payload.PrincipalId)));
        await database.Database.BeginTransactionAsync(cancellationToken).ConfigureAwait(false);

        var link = await database.PublicLinks.AsNoTracking()
            .SingleOrDefaultAsync(candidate => candidate.Id == payload.LinkId, cancellationToken)
            .ConfigureAwait(false);
        if (link is null
            || link.RevokedAt is not null
            || link.TenantId != tenantId
            || link.ServicePrincipalId.Value != payload.PrincipalId
            || !CryptographicOperations.FixedTimeEquals(
                Encoding.UTF8.GetBytes(link.Nonce),
                Encoding.UTF8.GetBytes(payload.Nonce))
            || !await database.Principals.AnyAsync(
                principal => principal.Id == link.ServicePrincipalId && principal.Status == PrincipalStatus.Active,
                cancellationToken).ConfigureAwait(false)
            || !await database.Workspaces.AnyAsync(
                workspace => workspace.Id == link.WorkspaceId
                    && workspace.LifecycleState == WorkspaceLifecycleState.Active,
                cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        // FindAsync is the one visibility rule: active, and no inactive or template ancestor.
        var item = await tree.FindAsync(link.ItemId, cancellationToken).ConfigureAwait(false);
        if (item is null
            || item.WorkspaceId != link.WorkspaceId
            || await IsUnderLockAsync(link.ItemId, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        return new ResolvedPublicLink(
            link.Id,
            tenantId,
            link.WorkspaceId,
            link.ItemId,
            link.FileVersionId?.Value,
            link.ServicePrincipalId.Value);
    }

    /// <inheritdoc />
    public async ValueTask EndForSubtreeAsync(ItemId itemId, CancellationToken cancellationToken)
    {
        var context = session.Current
            ?? throw new InvalidOperationException("Ending public links requires a tenant session.");
        var now = clock.GetUtcNow();
        var links = await database.PublicLinks.AsTracking()
            .Where(link => link.RevokedAt == null
                && database.ItemClosure.Any(edge => edge.AncestorId == itemId && edge.DescendantId == link.ItemId))
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        foreach (var link in links)
        {
            link.RevokedAt = now;
            AddAudit(context, link, "public_link.revoked", now);
        }

        await database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Whether the item, or any ancestor, carries a lock (a lock covers its subtree).</summary>
    public async ValueTask<bool> IsUnderLockAsync(ItemId itemId, CancellationToken cancellationToken) =>
        await database.ItemLocks.AnyAsync(
            candidate => database.ItemClosure.Any(
                edge => edge.DescendantId == itemId && edge.AncestorId == candidate.ItemId),
            cancellationToken).ConfigureAwait(false);

    public async ValueTask<Workspace?> FindWorkspaceAsync(WorkspaceId id, CancellationToken cancellationToken) =>
        await database.Workspaces.AsNoTracking()
            .SingleOrDefaultAsync(workspace => workspace.Id == id, cancellationToken).ConfigureAwait(false);

    public async ValueTask<PublicLink?> FindActiveAsync(ItemId itemId, CancellationToken cancellationToken) =>
        await database.PublicLinks.AsTracking()
            .SingleOrDefaultAsync(link => link.ItemId == itemId && link.RevokedAt == null, cancellationToken)
            .ConfigureAwait(false);

    /// <summary>The service principal of the item's most recent link, when still active, so a replace reuses it.</summary>
    public async ValueTask<PrincipalId?> FindReusablePrincipalAsync(ItemId itemId, CancellationToken cancellationToken)
    {
        var last = await database.PublicLinks.AsNoTracking()
            .Where(link => link.ItemId == itemId)
            .OrderByDescending(link => link.CreatedAt)
            .Select(link => (PrincipalId?)link.ServicePrincipalId)
            .FirstOrDefaultAsync(cancellationToken).ConfigureAwait(false);
        return last is { } principalId
            && await database.Principals.AnyAsync(
                principal => principal.Id == principalId && principal.Status == PrincipalStatus.Active,
                cancellationToken).ConfigureAwait(false)
            ? principalId
            : null;
    }

    /// <summary>The named version of the file, or its latest approved one when none is named.</summary>
    public async ValueTask<FileVersion?> FindVersionAsync(
        ItemId itemId,
        Guid? versionId,
        CancellationToken cancellationToken)
    {
        var versions = database.FileVersions.AsNoTracking()
            .Where(version => version.ItemId == itemId && version.ObjectReady);
        return versionId is { } named
            ? await versions.SingleOrDefaultAsync(version => version.Id == FileVersionId.From(named), cancellationToken)
                .ConfigureAwait(false)
            : await versions.Where(version => version.State == "approved")
                .OrderByDescending(version => version.Version)
                .FirstOrDefaultAsync(cancellationToken).ConfigureAwait(false);
    }

    public void Add(PublicLink link, Principal? principal, WorkspaceMember? membership)
    {
        if (principal is not null)
        {
            database.Principals.Add(principal);
            database.WorkspaceMembers.Add(membership!);
        }

        database.PublicLinks.Add(link);
    }

    public void AddAudit(NixSessionContext context, PublicLink link, string action, DateTimeOffset at) =>
        database.AuditEvents.Add(new AuditEvent
        {
            Id = AuditEventId.Create(),
            TenantId = context.TenantId,
            WorkspaceId = link.WorkspaceId,
            ActorId = context.PrincipalId,
            OnBehalfOf = null,
            Action = action,
            SubjectId = link.Id,
            SubjectType = "public_link",
            Before = null,
            After = null,
            ActorIp = null,
            OccurredAt = at,
        });

    public Task SaveAsync(CancellationToken cancellationToken) => database.SaveChangesAsync(cancellationToken);
}
#pragma warning restore CA1812
