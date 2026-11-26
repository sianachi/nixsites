using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Nix.Domain.Identity;
using Nix.Domain.Pets;
using Nix.Persistence.Conversion;

namespace Nix.Persistence.Configurations;

internal sealed class PetProviderCredentialConfiguration : IEntityTypeConfiguration<PetProviderCredential>
{
    public void Configure(EntityTypeBuilder<PetProviderCredential> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable(NixTables.PetProviderCredential, table => table.HasCheckConstraint(
            "pet_provider_credential_bounded",
            "provider IN ('anthropic', 'openrouter') AND octet_length(protected_key) <= 4096 AND char_length(key_hint) <= 8"));
        builder.HasKey(row => new { row.TenantId, row.PrincipalId, row.Provider });
        builder.Property(row => row.TenantId).HasColumnName("tenant_id");
        builder.Property(row => row.PrincipalId).HasColumnName("principal_id");
        builder.Property(row => row.Provider).HasColumnName("provider").HasMaxLength(20).IsRequired();
        builder.Property(row => row.ProtectedKey)
            .HasColumnName("protected_key")
            .HasColumnType("bytea")
            .HasConversion(new BinaryPayloadConverter(), BinaryPayloadConverter.Comparer)
            .IsRequired();
        builder.Property(row => row.KeyHint).HasColumnName("key_hint").HasMaxLength(8).IsRequired();
        builder.Property(row => row.SavedAt).HasColumnName("saved_at");
        builder.HasOne<Principal>().WithMany()
            .HasForeignKey(row => new { row.TenantId, row.PrincipalId })
            .HasPrincipalKey(row => new { row.TenantId, row.Id })
            .OnDelete(DeleteBehavior.Cascade);
    }
}
