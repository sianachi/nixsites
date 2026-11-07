using System.Text.Json.Serialization;
using Nix.Abstractions.Files;
using Nix.Features.Operations;

namespace Nix.Features.Files;

public sealed record BeginFileUploadRequest(Guid WorkspaceId, Guid? ParentId, Guid? TargetItemId, string FileName, string MediaType, long ByteLength, string IdempotencyKey);
public sealed record CompleteFileUploadRequest(string DetectedMediaType, long ByteLength, string Sha256, bool Previewable, int? PixelWidth, int? PixelHeight, int? ThumbnailWidth = null, int? ThumbnailHeight = null, int? ThumbnailBytes = null);
public sealed record FileUploadCapabilityResponse(Guid Id, string Status, Uri? UploadUrl, DateTimeOffset? CapabilityExpiresAt, DateTimeOffset ExpiresAt, Guid? ItemId, string? FailureCode);
public sealed record FileUploadStatusResponse(Guid Id, string Status, DateTimeOffset ExpiresAt, Guid? ItemId, string? FailureCode, Guid? PublishedVersionId = null);
public sealed record FileDownloadCapabilityResponse(Uri Url, DateTimeOffset ExpiresAt, string FileName, string MediaType, long ByteLength, string Sha256, bool Inline, bool Unscanned, bool NoSniff, Guid? VersionId = null, string? StoredMediaType = null, bool? Revoked = null);
/// <summary>A short-lived read capability for the JPEG thumbnail of a file version.</summary>
public sealed record FileThumbnailCapabilityResponse(Uri Url, DateTimeOffset ExpiresAt, int Width, int Height, int ByteLength, Guid? VersionId = null);
public sealed record WorkerThumbnailUploadRequest(long ByteLength);
public sealed record WorkerThumbnailUploadResponse(Uri UploadUrl, DateTimeOffset ExpiresAt);
public sealed record WorkerFileInspectionResponse(
    Guid UploadId,
    Guid WorkspaceId,
    string Status,
    string FileName,
    string DeclaredMediaType,
    long DeclaredByteLength,
    DateTimeOffset ExpiresAt,
    Uri SourceUrl,
    Uri SourceDeleteUrl,
    Uri DestinationUrl,
    Uri DestinationUploadUrl,
    Uri DestinationDeleteUrl,
    DateTimeOffset CapabilityExpiresAt,
    Guid? ItemId);
public sealed record RejectFileUploadRequest(string Code);
public sealed record FileInspectPayload(Guid UploadId);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(BeginFileUploadRequest))]
[JsonSerializable(typeof(CompleteFileUploadRequest))]
[JsonSerializable(typeof(FileRecord))]
[JsonSerializable(typeof(FileVersionRecord))]
[JsonSerializable(typeof(IReadOnlyList<FileVersionRecord>))]
[JsonSerializable(typeof(FileUploadCapabilityResponse))]
[JsonSerializable(typeof(FileUploadStatusResponse))]
[JsonSerializable(typeof(FileDownloadCapabilityResponse))]
[JsonSerializable(typeof(FileThumbnailCapabilityResponse))]
[JsonSerializable(typeof(WorkerThumbnailUploadRequest))]
[JsonSerializable(typeof(WorkerThumbnailUploadResponse))]
[JsonSerializable(typeof(WorkerFileInspectionResponse))]
[JsonSerializable(typeof(RejectFileUploadRequest))]
[JsonSerializable(typeof(FileInspectPayload))]
[JsonSerializable(typeof(SetFileVersionStateRequest))]
[JsonSerializable(typeof(OperationResponse))]
internal sealed partial class FilesJsonContext : JsonSerializerContext;
