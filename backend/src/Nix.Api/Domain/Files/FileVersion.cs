using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Files;

/// <summary>One immutable version of a file body.</summary>
public sealed class FileVersion
{
    public required FileVersionId Id { get; init; }
    public required TenantId TenantId { get; init; }
    public required WorkspaceId WorkspaceId { get; init; }
    public required ItemId ItemId { get; init; }
    public required int Version { get; init; }
    public required string ObjectKey { get; init; }
    public required string FileName { get; init; }
    public required string MediaType { get; init; }
    public required long ByteLength { get; init; }
    public required string Sha256 { get; init; }
    /// <summary>Whether direct-to-object-store publication has been verified for this version.</summary>
    public bool ObjectReady { get; set; } = true;
    public int? PixelWidth { get; init; }
    public int? PixelHeight { get; init; }
    /// <summary>
    /// Pixel width of the stored thumbnail, or null when this version has none. The three
    /// thumbnail columns are all null or all set; the thumbnail object's key is derived from
    /// <see cref="ObjectKey"/> by <c>ObjectStorageKeys.FileThumbnail</c>, never stored.
    /// </summary>
    public int? ThumbnailWidth { get; init; }
    public int? ThumbnailHeight { get; init; }
    public int? ThumbnailBytes { get; init; }
    public required bool Previewable { get; init; }
    public required PrincipalId CreatedBy { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>Lifecycle state: <c>draft</c> (default), <c>in_review</c>, <c>approved</c> or <c>revoked</c>.</summary>
    public string State { get; set; } = "draft";

    /// <summary>Who last changed <see cref="State"/>, or null while it has never changed.</summary>
    public PrincipalId? StateChangedBy { get; set; }

    /// <summary>When <see cref="State"/> last changed, or null while it has never changed.</summary>
    public DateTimeOffset? StateChangedAt { get; set; }

    /// <summary>The note this version was exported from, or null for an ordinary upload.</summary>
    public ItemId? SourceItemId { get; set; }

    /// <summary>The revision of <see cref="SourceItemId"/> this version was exported from.</summary>
    public long? SourceSeq { get; set; }
}
