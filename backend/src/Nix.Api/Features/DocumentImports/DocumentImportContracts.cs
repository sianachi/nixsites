using System.Text.Json;
using System.Text.Json.Serialization;
using Nix.Abstractions.Importing;
using Nix.Features.Operations;

namespace Nix.Features.DocumentImports;

public sealed record BeginDocumentImportRequest(
    Guid WorkspaceId,
    Guid? ParentId,
    string Format,
    string Title,
    string FileName,
    string MediaType,
    long ByteLength,
    string IdempotencyKey);

public sealed record DocumentImportUploadResponse(
    Guid Id,
    string Status,
    Uri? UploadUrl,
    DateTimeOffset? CapabilityExpiresAt,
    DateTimeOffset ExpiresAt);

public sealed record DocumentImportResponse(
    Guid Id,
    Guid WorkspaceId,
    Guid UploadId,
    Guid? ParentId,
    string Format,
    string Title,
    string Status,
    Guid? PreviewOperationId,
    Guid? CommitOperationId,
    int? ItemCount,
    int? AssetCount,
    JsonElement? Loss,
    JsonElement? Omissions,
    Guid? RootItemId,
    string? FailureCode,
    DateTimeOffset ExpiresAt,
    DateTimeOffset? CompletedAt);

public sealed record DocumentImportPreviewCapabilityResponse(
    Uri Url,
    DateTimeOffset ExpiresAt,
    string Sha256,
    long ByteLength);

public sealed record DocumentImportJobPayload(Guid ImportId);

public sealed record WorkerDocumentImportPreviewResponse(
    Guid ImportId,
    string Format,
    string Title,
    string FileName,
    string DeclaredMediaType,
    long DeclaredByteLength,
    Uri SourceUrl,
    Uri SourceDeleteUrl,
    Uri PlanUploadUrl,
    Uri PlanDeleteUrl,
    DateTimeOffset CapabilityExpiresAt);

public sealed record WorkerDocumentImportCommitResponse(
    Guid ImportId,
    string Format,
    string Title,
    string FileName,
    string DeclaredMediaType,
    long DeclaredByteLength,
    string PlanSha256,
    long PlanByteLength,
    string SourceSha256,
    Uri SourceUrl,
    Uri SourceDeleteUrl,
    Uri PlanUrl,
    Uri PlanDeleteUrl,
    DateTimeOffset CapabilityExpiresAt);

public sealed record CompleteDocumentImportPreviewRequest(
    string PlanSha256,
    long PlanByteLength,
    string SourceSha256,
    int ItemCount,
    int AssetCount,
    IReadOnlyList<string> Loss,
    IReadOnlyList<string> Omissions);

public sealed record StageDocumentImportRequest(
    string PlanSha256,
    string SourceSha256,
    IReadOnlyList<StageDocumentImportItemRequest> Items,
    IReadOnlyList<StageDocumentImportFileVersionRequest>? FileVersions = null);

public sealed record StageDocumentImportFileVersionRequest(
    string SourceItemId,
    int Version,
    string FileName,
    string MediaType,
    long ByteLength,
    string Sha256,
    bool Previewable,
    int? PixelWidth,
    int? PixelHeight);

public sealed record StageDocumentImportItemRequest(
    string SourceId,
    string? ParentSourceId,
    int Order,
    string Title,
    string ItemType,
    JsonElement? Properties,
    JsonElement? Schema,
    JsonElement? Views,
    string FinalLifecycleState,
    bool BodyRequired,
    StageDocumentImportFileRequest? File,
    IReadOnlyList<ImportCommentThread>? Comments = null);

public sealed record StageDocumentImportFileRequest(
    string SourceKind,
    string? AssetPath,
    string FileName,
    string MediaType,
    long ByteLength,
    string Sha256,
    bool Previewable,
    int? PixelWidth,
    int? PixelHeight);

public sealed record DocumentImportStageResponse(
    Guid ImportId,
    Guid RootItemId,
    IReadOnlyList<DocumentImportStageItemResponse> Items,
    IReadOnlyList<DocumentImportStageFileVersionResponse>? FileTransfers = null);

public sealed record DocumentImportStageFileVersionResponse(
    Guid TransferId,
    string SourceItemId,
    Guid TargetItemId,
    int TargetVersion);

public sealed record DocumentImportFileVersionsAuthorizationResponse(
    Guid ImportId,
    IReadOnlyList<DocumentImportFileVersionCapabilityResponse> Files,
    Guid? NextAfterTransferId,
    bool Complete);

public sealed record DocumentImportFileVersionCapabilityResponse(
    Guid TransferId,
    string SourceItemId,
    Guid TargetItemId,
    int TargetVersion,
    string FileName,
    string MediaType,
    long ByteLength,
    string Sha256,
    Uri? UploadUrl,
    Uri? VerifyUrl,
    bool Ready);

public sealed record CompleteDocumentImportFileVersionsRequest(IReadOnlyList<Guid> TransferIds);
public sealed record CompleteDocumentImportFileVersionsResponse(Guid ImportId, IReadOnlyList<Guid> CompletedTransferIds);

public sealed record DocumentImportStageItemResponse(
    string SourceId,
    Guid TargetItemId,
    string ItemType,
    bool BodyRequired,
    bool ObjectReady);

public sealed record DocumentImportObjectCapabilityResponse(
    string SourceId,
    Uri Url,
    Uri UploadUrl,
    Uri DeleteUrl,
    DateTimeOffset CapabilityExpiresAt);

public sealed record CompleteDocumentImportObjectRequest(string SourceId, long ByteLength, string Sha256);

public sealed record DocumentImportBodyAuthorizationResponse(
    Guid TenantId,
    Guid PrincipalId,
    Guid WorkspaceId,
    Guid ImportId,
    IReadOnlyList<DocumentImportBodyAuthorizationItemResponse> Items,
    bool CanWrite);

public sealed record DocumentImportBodyAuthorizationItemResponse(
    string SourceId,
    Guid TargetItemId,
    string ItemType,
    bool BodyRequired);

public sealed record RejectDocumentImportRequest(string Code);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(BeginDocumentImportRequest))]
[JsonSerializable(typeof(DocumentImportUploadResponse))]
[JsonSerializable(typeof(DocumentImportResponse))]
[JsonSerializable(typeof(DocumentImportPreviewCapabilityResponse))]
[JsonSerializable(typeof(DocumentImportJobPayload))]
[JsonSerializable(typeof(WorkerDocumentImportPreviewResponse))]
[JsonSerializable(typeof(WorkerDocumentImportCommitResponse))]
[JsonSerializable(typeof(CompleteDocumentImportPreviewRequest))]
[JsonSerializable(typeof(StageDocumentImportRequest))]
[JsonSerializable(typeof(StageDocumentImportFileVersionRequest))]
[JsonSerializable(typeof(StageDocumentImportItemRequest))]
[JsonSerializable(typeof(StageDocumentImportFileRequest))]
[JsonSerializable(typeof(DocumentImportStageResponse))]
[JsonSerializable(typeof(DocumentImportStageItemResponse))]
[JsonSerializable(typeof(DocumentImportStageFileVersionResponse))]
[JsonSerializable(typeof(DocumentImportFileVersionsAuthorizationResponse))]
[JsonSerializable(typeof(DocumentImportFileVersionCapabilityResponse))]
[JsonSerializable(typeof(CompleteDocumentImportFileVersionsRequest))]
[JsonSerializable(typeof(CompleteDocumentImportFileVersionsResponse))]
[JsonSerializable(typeof(DocumentImportObjectCapabilityResponse))]
[JsonSerializable(typeof(CompleteDocumentImportObjectRequest))]
[JsonSerializable(typeof(DocumentImportBodyAuthorizationResponse))]
[JsonSerializable(typeof(DocumentImportBodyAuthorizationItemResponse))]
[JsonSerializable(typeof(RejectDocumentImportRequest))]
[JsonSerializable(typeof(IReadOnlyList<string>))]
[JsonSerializable(typeof(OperationResponse))]
internal sealed partial class DocumentImportsJsonContext : JsonSerializerContext;
