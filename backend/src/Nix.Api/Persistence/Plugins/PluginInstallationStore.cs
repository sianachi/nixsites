using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Plugins;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.Plugins;

/// <summary>Tenant-scoped catalog operations for immutable components and workspace installations.</summary>
public sealed class PluginInstallationStore(
    NixDbContext context,
    INixSessionContextAccessor session,
    TimeProvider clock)
{
    private NixSessionContext Session => session.Current
        ?? throw new InvalidOperationException("Plugin catalog operations require a tenant-scoped unit of work.");

    /// <summary>Pins a publisher key and installs one exact component version, idempotently.</summary>
    public async ValueTask<PluginRegistrationResult> RegisterAsync(
        WorkspaceId workspaceId,
        PluginComponentRegistration registration,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(registration);
        var scoped = Session;
        var now = clock.GetUtcNow();
        var publisher = await context.PluginPublishers
            .SingleOrDefaultAsync(
                value => value.Id == registration.PublisherId,
                cancellationToken)
            .ConfigureAwait(false);
        if (publisher is not null
            && !publisher.Ed25519PublicKey.AsSpan().SequenceEqual(registration.PublicKey.Span))
        {
            return new PluginRegistrationResult(PluginRegistrationOutcome.PublisherKeyConflict, null);
        }

        if (publisher is null)
        {
            context.PluginPublishers.Add(new PluginPublisher
            {
                TenantId = scoped.TenantId,
                Id = registration.PublisherId,
                Ed25519PublicKey = registration.PublicKey.ToArray(),
                PinnedBy = scoped.PrincipalId,
                PinnedAt = now,
            });
        }

        var component = await context.PluginComponents.SingleOrDefaultAsync(
            value => value.Id == registration.Id && value.Version == registration.Version,
            cancellationToken).ConfigureAwait(false);
        if (component is not null && !SameComponent(component, registration))
        {
            return new PluginRegistrationResult(PluginRegistrationOutcome.ComponentConflict, null);
        }

        if (component is null)
        {
            context.PluginComponents.Add(new PluginComponent
            {
                TenantId = scoped.TenantId,
                PublisherId = registration.PublisherId,
                Id = registration.Id,
                Version = registration.Version,
                ObjectKey = registration.ObjectKey,
                Sha256 = registration.Sha256,
                ByteLength = registration.ByteLength,
                Ed25519Signature = registration.Signature.ToArray(),
                RegisteredBy = scoped.PrincipalId,
                RegisteredAt = now,
            });
        }

        var existing = await context.PluginInstallations.SingleOrDefaultAsync(
            value => value.WorkspaceId == workspaceId && value.ComponentId == registration.Id,
            cancellationToken).ConfigureAwait(false);
        if (existing is not null)
        {
            if (!string.Equals(existing.ComponentVersion, registration.Version, StringComparison.Ordinal))
            {
                return new PluginRegistrationResult(PluginRegistrationOutcome.InstallationConflict, null);
            }

            return new PluginRegistrationResult(
                PluginRegistrationOutcome.Existing,
                await SnapshotAsync(existing, cancellationToken).ConfigureAwait(false));
        }

        var installationCount = await context.PluginInstallations
            .CountAsync(value => value.WorkspaceId == workspaceId, cancellationToken)
            .ConfigureAwait(false);
        if (installationCount >= PluginRuntimePolicy.MaximumInstallationsPerWorkspace)
        {
            return new PluginRegistrationResult(PluginRegistrationOutcome.WorkspaceLimit, null);
        }

        var installation = new PluginInstallation
        {
            Id = PluginInstallationId.Create(),
            TenantId = scoped.TenantId,
            WorkspaceId = workspaceId,
            ComponentId = registration.Id,
            ComponentVersion = registration.Version,
            Enabled = false,
            InstalledBy = scoped.PrincipalId,
            InstalledAt = now,
            UpdatedAt = now,
        };
        context.PluginInstallations.Add(installation);
        await context.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return new PluginRegistrationResult(
            PluginRegistrationOutcome.Created,
            await SnapshotAsync(installation, cancellationToken).ConfigureAwait(false));
    }

    /// <summary>Lists installations in one workspace with their explicit grants.</summary>
    public async ValueTask<IReadOnlyList<PluginInstallationSnapshot>> ListAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken)
    {
        var installations = await context.PluginInstallations
            .Where(value => value.WorkspaceId == workspaceId)
            .OrderBy(value => value.ComponentId)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        if (installations.Count == 0)
        {
            return [];
        }

        // Three reads for the whole list, not three per installation.
        var componentIds = installations.Select(value => value.ComponentId).Distinct().ToArray();
        var components = await context.PluginComponents
            .Where(value => componentIds.Contains(value.Id))
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        var publisherIds = components.Select(value => value.PublisherId).Distinct().ToArray();
        var publishers = await context.PluginPublishers
            .Where(value => publisherIds.Contains(value.Id))
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        var installationIds = installations.Select(value => value.Id).ToArray();
        var grants = (await context.PluginCapabilityGrants
            .Where(value => installationIds.Contains(value.InstallationId))
            .OrderBy(value => value.Capability)
            .Select(value => new { value.InstallationId, value.Capability })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false))
            .ToLookup(value => value.InstallationId, value => value.Capability);
        return installations
            .Select(installation =>
            {
                var component = components.Single(value =>
                    value.Id == installation.ComponentId && value.Version == installation.ComponentVersion);
                return ToSnapshot(
                    installation,
                    component,
                    publishers.Single(value => value.Id == component.PublisherId),
                    grants[installation.Id].ToArray());
            })
            .ToList();
    }

    /// <summary>Enables or disables one exact workspace installation.</summary>
    public async ValueTask<PluginInstallationSnapshot?> SetEnabledAsync(
        WorkspaceId workspaceId,
        PluginInstallationId installationId,
        bool enabled,
        CancellationToken cancellationToken)
    {
        var changed = await context.PluginInstallations
            .Where(value => value.Id == installationId && value.WorkspaceId == workspaceId)
            .ExecuteUpdateAsync(
                setters => setters
                    .SetProperty(value => value.Enabled, enabled)
                    .SetProperty(value => value.UpdatedAt, clock.GetUtcNow()),
                cancellationToken)
            .ConfigureAwait(false);
        if (changed == 0)
        {
            return null;
        }

        var installation = await context.PluginInstallations.SingleAsync(
            value => value.Id == installationId && value.WorkspaceId == workspaceId,
            cancellationToken).ConfigureAwait(false);
        return await SnapshotAsync(installation, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Replaces the complete closed grant set for one installation.</summary>
    public async ValueTask<PluginInstallationSnapshot?> ReplaceGrantsAsync(
        WorkspaceId workspaceId,
        PluginInstallationId installationId,
        IReadOnlySet<string> capabilities,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(capabilities);
        if (capabilities.Any(value => !string.Equals(
                value,
                PluginRuntimePolicy.ReadItemMetadataCapability,
                StringComparison.Ordinal)))
        {
            throw new ArgumentException("The grant set contains an unsupported capability.", nameof(capabilities));
        }

        var installation = await context.PluginInstallations.SingleOrDefaultAsync(
            value => value.Id == installationId && value.WorkspaceId == workspaceId,
            cancellationToken).ConfigureAwait(false);
        if (installation is null)
        {
            return null;
        }

        await context.PluginCapabilityGrants
            .Where(value => value.InstallationId == installationId)
            .ExecuteDeleteAsync(cancellationToken)
            .ConfigureAwait(false);
        var scoped = Session;
        var now = clock.GetUtcNow();
        foreach (var capability in capabilities.Order(StringComparer.Ordinal))
        {
            context.PluginCapabilityGrants.Add(new PluginCapabilityGrant
            {
                TenantId = scoped.TenantId,
                InstallationId = installationId,
                Capability = capability,
                GrantedBy = scoped.PrincipalId,
                GrantedAt = now,
            });
        }
        await context.PluginInstallations
            .Where(value => value.Id == installationId && value.WorkspaceId == workspaceId)
            .ExecuteUpdateAsync(
                setters => setters.SetProperty(value => value.UpdatedAt, now),
                cancellationToken)
            .ConfigureAwait(false);
        await context.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        var refreshed = await context.PluginInstallations.SingleAsync(
            value => value.Id == installationId && value.WorkspaceId == workspaceId,
            cancellationToken).ConfigureAwait(false);
        return await SnapshotAsync(refreshed, cancellationToken).ConfigureAwait(false);
    }

    private async ValueTask<PluginInstallationSnapshot> SnapshotAsync(
        PluginInstallation installation,
        CancellationToken cancellationToken)
    {
        var component = await context.PluginComponents.SingleAsync(
            value => value.Id == installation.ComponentId
                && value.Version == installation.ComponentVersion,
            cancellationToken).ConfigureAwait(false);
        var publisher = await context.PluginPublishers.SingleAsync(
            value => value.Id == component.PublisherId,
            cancellationToken).ConfigureAwait(false);
        var grants = await context.PluginCapabilityGrants
            .Where(value => value.InstallationId == installation.Id)
            .OrderBy(value => value.Capability)
            .Select(value => value.Capability)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        return ToSnapshot(installation, component, publisher, grants);
    }

    private static PluginInstallationSnapshot ToSnapshot(
        PluginInstallation installation,
        PluginComponent component,
        PluginPublisher publisher,
        string[] grants) =>
        new(
            installation.Id,
            installation.WorkspaceId,
            component.PublisherId,
            component.Id,
            component.Version,
            component.ObjectKey,
            component.Sha256,
            component.ByteLength,
            publisher.Ed25519PublicKey.ToArray(),
            component.Ed25519Signature.ToArray(),
            installation.Enabled,
            grants,
            installation.InstalledAt,
            installation.UpdatedAt);

    private static bool SameComponent(
        PluginComponent component,
        PluginComponentRegistration registration) =>
        string.Equals(component.PublisherId, registration.PublisherId, StringComparison.Ordinal)
        && string.Equals(component.ObjectKey, registration.ObjectKey, StringComparison.Ordinal)
        && string.Equals(component.Sha256, registration.Sha256, StringComparison.Ordinal)
        && component.ByteLength == registration.ByteLength
        && component.Ed25519Signature.AsSpan().SequenceEqual(registration.Signature.Span);
}

/// <summary>Validated immutable metadata required to register one component version.</summary>
public sealed record PluginComponentRegistration(
    string PublisherId,
    string Id,
    string Version,
    string ObjectKey,
    string Sha256,
    long ByteLength,
    ReadOnlyMemory<byte> PublicKey,
    ReadOnlyMemory<byte> Signature);

/// <summary>Stable outcomes of an idempotent plugin registration attempt.</summary>
public enum PluginRegistrationOutcome
{
    Created,
    Existing,
    PublisherKeyConflict,
    ComponentConflict,
    InstallationConflict,
    WorkspaceLimit,
}

/// <summary>Registration outcome and the installation when one exists.</summary>
public sealed record PluginRegistrationResult(
    PluginRegistrationOutcome Outcome,
    PluginInstallationSnapshot? Installation);

/// <summary>One workspace installation and the immutable component it executes.</summary>
public sealed record PluginInstallationSnapshot(
    PluginInstallationId Id,
    WorkspaceId WorkspaceId,
    string PublisherId,
    string ComponentId,
    string Version,
    string ObjectKey,
    string Sha256,
    long ByteLength,
    ReadOnlyMemory<byte> PublicKey,
    ReadOnlyMemory<byte> Signature,
    bool Enabled,
    IReadOnlyList<string> Capabilities,
    DateTimeOffset InstalledAt,
    DateTimeOffset UpdatedAt);
