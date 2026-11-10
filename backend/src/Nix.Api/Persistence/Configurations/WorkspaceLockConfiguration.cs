using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Locks;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.Configurations;

/// <summary>Maps <see cref="WorkspaceLock"/> to <c>workspace_lock</c>.</summary>
internal sealed class WorkspaceLockConfiguration : IEntityTypeConfiguration<WorkspaceLock>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<WorkspaceLock> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.WorkspaceLock);
        builder.HasKey(row => row.WorkspaceId);
        builder.HasAlternateKey(row => new { row.TenantId, row.WorkspaceId });

        builder.Property(row => row.WorkspaceId).HasColumnName("workspace_id");
        builder.Property(row => row.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(row => row.PasswordHash).HasColumnName("password_hash").IsRequired();
        builder.Property(row => row.LockedBy).HasColumnName("locked_by");
        builder.Property(row => row.LockedAt).HasColumnName("locked_at");

        builder.HasOne<Workspace>()
            .WithMany()
            .HasForeignKey(row => new { row.TenantId, row.WorkspaceId })
            .HasPrincipalKey(workspace => new { workspace.TenantId, workspace.Id })
            .OnDelete(DeleteBehavior.Cascade);
    }
}

/// <summary>Maps <see cref="WorkspaceUnlock"/> to <c>workspace_unlock</c>.</summary>
internal sealed class WorkspaceUnlockConfiguration : IEntityTypeConfiguration<WorkspaceUnlock>
{
    /// <inheritdoc />
    public void Configure(EntityTypeBuilder<WorkspaceUnlock> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.ToTable(NixTables.WorkspaceUnlock);
        builder.HasKey(row => new { row.WorkspaceId, row.CredentialId });

        builder.Property(row => row.WorkspaceId).HasColumnName("workspace_id");
        builder.Property(row => row.CredentialId).HasColumnName("credential_id");
        builder.Property(row => row.TenantId).HasColumnName(NixTables.TenantIdColumn);
        builder.Property(row => row.PrincipalId).HasColumnName("principal_id");
        builder.Property(row => row.ExpiresAt).HasColumnName("expires_at");

        // Hangs off the lock so removing the lock deletes its grants; a password change deletes
        // them in the same transaction (WorkspaceLockStore).
        builder.HasOne<WorkspaceLock>()
            .WithMany()
            .HasForeignKey(row => new { row.TenantId, row.WorkspaceId })
            .HasPrincipalKey(row => new { row.TenantId, row.WorkspaceId })
            .OnDelete(DeleteBehavior.Cascade);
    }
}
