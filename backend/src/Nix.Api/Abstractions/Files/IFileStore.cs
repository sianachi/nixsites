using Nix.Domain.Files;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions.Files;

public sealed record BeginFileUpload(
    WorkspaceId WorkspaceId,
    ItemId? ParentId,
    ItemId? TargetItemId,
    string FileName,
    string DeclaredMediaType,
    long DeclaredByteLength,
    string IdempotencyKey,
    string Purpose = FileUploadPurposes.File);

public static class FileUploadPurposes
{
    public const string File = "file";
    public const string DocumentImport = "document_import";
    public const string TemplateImport = "template_import";
}

public sealed record CompleteFileUpload(
    FileUploadId UploadId,
    string DetectedMediaType,
    long ByteLength,
    string Sha256,
    bool Previewable,
    int? PixelWidth,
    int? PixelHeight,
    int? ThumbnailWidth = null,
    int? ThumbnailHeight = null,
    int? ThumbnailBytes = null);

public sealed record FileUploadRecord(Guid Id, Guid WorkspaceId, string Purpose, string Status, string ObjectKey, DateTimeOffset ExpiresAt, Guid? ItemId, string? FailureCode);
public sealed record FileUploadInspectionRecord(Guid Id, Guid WorkspaceId, string Purpose, string Status, string ObjectKey, string FileName, string DeclaredMediaType, long DeclaredByteLength, DateTimeOffset ExpiresAt, Guid? ItemId);
public sealed record FileVersionRecord(Guid Id, int Version, string FileName, string MediaType, long ByteLength, string Sha256, bool Previewable, int? PixelWidth, int? PixelHeight, DateTimeOffset CreatedAt, bool Current, FileThumbnailRecord? Thumbnail = null, string? State = null, Guid? StateChangedBy = null, DateTimeOffset? StateChangedAt = null, Guid? SourceItemId = null, long? SourceSeq = null);
/// <summary>The pixel size of a stored thumbnail; a version without one carries null instead.</summary>
public sealed record FileThumbnailRecord(int Width, int Height);
/// <summary>What the thumbnail capability is signed from: the version's own key plus the thumbnail's facts.</summary>
public sealed record FileThumbnailDownloadRecord(string VersionObjectKey, int Width, int Height, int ByteLength);
/// <summary>Exact immutable source metadata used to authorize a streamed archive or template copy.</summary>
public sealed record FileVersionSourceRecord(Guid Id, int Version, string ObjectKey, string FileName, string MediaType, long ByteLength, string Sha256, bool Previewable, int? PixelWidth, int? PixelHeight, bool Current);
public sealed record FileRecord(Guid ItemId, Guid WorkspaceId, FileVersionRecord Current, IReadOnlyList<FileVersionRecord> Versions, Guid? ShownVersionId = null);
public sealed record FileDownloadRecord(string ObjectKey, string FileName, string MediaType, long ByteLength, string Sha256, bool Previewable);

public interface IFileStore
{
    public ValueTask<FileUploadRecord?> BeginAsync(BeginFileUpload request, CancellationToken cancellationToken);
    public ValueTask<FileUploadRecord?> QueueInspectionAsync(FileUploadId id, CancellationToken cancellationToken);
    public ValueTask<FileUploadInspectionRecord?> GetInspectionAsync(FileUploadId id, CancellationToken cancellationToken);
    public ValueTask<FileRecord?> CompleteAsync(CompleteFileUpload request, CancellationToken cancellationToken);
    public ValueTask<bool> RejectAsync(FileUploadId id, string failureCode, CancellationToken cancellationToken);
    public ValueTask<FileUploadRecord?> GetUploadAsync(FileUploadId id, CancellationToken cancellationToken);
    public ValueTask<bool> CancelAsync(FileUploadId id, CancellationToken cancellationToken);
    public ValueTask<FileRecord?> GetAsync(ItemId itemId, CancellationToken cancellationToken);
    public ValueTask<IReadOnlyList<FileVersionSourceRecord>?> AuthorizeVersionHistoryAsync(ItemId itemId, CancellationToken cancellationToken);
    public ValueTask<FileDownloadRecord?> AuthorizeDownloadAsync(ItemId itemId, FileVersionId? versionId, CancellationToken cancellationToken);

    /// <summary>
    /// Authorizes a read of a file version's thumbnail by exactly the rule <see cref="AuthorizeDownloadAsync"/>
    /// applies to its bytes, including a lock withholding it.
    /// </summary>
    /// <returns>Null when the file is not visible or readable, or when the version has no thumbnail.</returns>
    public ValueTask<FileThumbnailDownloadRecord?> AuthorizeThumbnailAsync(ItemId itemId, FileVersionId? versionId, CancellationToken cancellationToken);

    /// <summary>
    /// Carries an item rename onto its file body: the current version's stored file name follows
    /// the new title, by <see cref="Nix.Domain.Files.FileNaming.RenamedFileName"/>'s rule.
    /// </summary>
    /// <param name="itemId">The renamed item. A no-op when it has no file body.</param>
    /// <param name="title">The item's new title.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <remarks>
    /// A store method rather than the handler reaching into <c>NixDbContext</c> itself: the file
    /// store is the one place the file domain's storage shape is allowed to leak into, and every
    /// other write to a file version already goes through it.
    /// </remarks>
    public ValueTask RenameCurrentVersionAsync(ItemId itemId, string title, CancellationToken cancellationToken);
}
