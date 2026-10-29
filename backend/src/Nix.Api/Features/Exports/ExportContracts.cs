using System.Text.Json.Serialization;

namespace Nix.Features.Exports;

public sealed record ExportFormatResponse(
    string Format,
    string Label,
    string Extension,
    string MediaType,
    bool Lossless,
    IReadOnlyList<string> DeclaredLoss);

public sealed record ExportFormatCatalogResponse(
    IReadOnlyList<ExportFormatResponse> Formats,
    DateTimeOffset ObservedAt);

public sealed record BeginExportRequest(
    Guid ItemId,
    string Format,
    string Scope,
    string IdempotencyKey,
    bool IncludeComments = false);

public sealed record ExportResponse(
    Guid Id,
    Guid ItemId,
    Guid WorkspaceId,
    string Format,
    string Scope,
    string FileName,
    string MediaType,
    string Status,
    int? ItemCount,
    int? OmittedCount,
    long? ByteLength,
    string? Sha256,
    IReadOnlyList<string> Loss,
    IReadOnlyList<string> Omissions,
    string? FailureCode,
    string? FailureDetail,
    bool CancellationRequested,
    bool DownloadReady,
    DateTimeOffset CreatedAt,
    DateTimeOffset? CompletedAt,
    DateTimeOffset? ExpiresAt);

public sealed record ExportDownloadCapabilityResponse(
    Uri Url,
    DateTimeOffset ExpiresAt,
    string FileName,
    string MediaType,
    long ByteLength,
    string Sha256);

public sealed record ExportJobPayload(
    Guid ItemId,
    Guid WorkspaceId,
    string Format,
    string Scope,
    string Title,
    string Extension,
    string MediaType,
    IReadOnlyList<string> DeclaredLoss,
    bool IncludeComments = false);

public sealed record WorkerExportSourceResponse(
    Guid ExportId,
    string Format,
    Uri SourceUrl,
    string BearerToken,
    DateTimeOffset DelegationExpiresAt);

internal sealed record WorkerExportFileHistoryResponse(
    Guid ItemId,
    IReadOnlyList<WorkerExportFileVersionResponse> Versions);

internal sealed record WorkerExportFileVersionResponse(
    int Version,
    bool Current,
    string FileName,
    string MediaType,
    long ByteLength,
    string Sha256,
    bool Previewable,
    int? PixelWidth,
    int? PixelHeight,
    Uri DownloadUrl,
    DateTimeOffset ExpiresAt);

public sealed record WorkerExportDestinationResponse(
    Guid ExportId,
    Guid AttemptId,
    string Format,
    string ObjectKey,
    Uri UploadUrl,
    Uri ReadUrl,
    Uri DeleteUrl,
    DateTimeOffset CapabilityExpiresAt);

public sealed record WorkerExportResult(
    Guid AttemptId,
    string Format,
    string ObjectKey,
    int ItemCount,
    int OmittedCount,
    long ByteLength,
    string Sha256,
    IReadOnlyList<string> Loss,
    IReadOnlyList<string> Omissions);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(BeginExportRequest))]
[JsonSerializable(typeof(ExportFormatCatalogResponse))]
[JsonSerializable(typeof(ExportFormatResponse))]
[JsonSerializable(typeof(ExportResponse))]
[JsonSerializable(typeof(ExportDownloadCapabilityResponse))]
[JsonSerializable(typeof(ExportJobPayload))]
[JsonSerializable(typeof(WorkerExportSourceResponse))]
[JsonSerializable(typeof(WorkerExportFileHistoryResponse))]
[JsonSerializable(typeof(WorkerExportDestinationResponse))]
[JsonSerializable(typeof(WorkerExportResult))]
[JsonSerializable(typeof(IReadOnlyList<string>))]
internal sealed partial class ExportsJsonContext : JsonSerializerContext;
