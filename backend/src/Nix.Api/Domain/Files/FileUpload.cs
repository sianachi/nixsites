using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Files;

/// <summary>A durable, idempotent capability upload awaiting validated publication.</summary>
public sealed class FileUpload
{
    public required FileUploadId Id { get; init; }
    public required TenantId TenantId { get; init; }
    public required WorkspaceId WorkspaceId { get; init; }
    public ItemId? ParentId { get; init; }
    public ItemId? TargetItemId { get; init; }
    public required PrincipalId ActorId { get; init; }
    public required string IdempotencyKey { get; init; }
    public required string Purpose { get; init; }
    public required string FileName { get; init; }
    public required string DeclaredMediaType { get; init; }
    public required long DeclaredByteLength { get; init; }
    public required string ObjectKey { get; init; }
    public required string Status { get; set; }
    public string? FailureCode { get; set; }
    public ItemId? PublishedItemId { get; set; }
    public required DateTimeOffset ExpiresAt { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public required DateTimeOffset UpdatedAt { get; set; }

    /// <summary>The note an export upload was produced from, or null.</summary>
    public ItemId? SourceItemId { get; set; }

    /// <summary>The revision of <see cref="SourceItemId"/> the export captured.</summary>
    public long? SourceSeq { get; set; }

    /// <summary>The file version this upload published, set when publication completes.</summary>
    public FileVersionId? PublishedVersionId { get; set; }
}
