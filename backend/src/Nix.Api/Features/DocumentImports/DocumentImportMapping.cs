using System.Text.Json;
using Nix.Abstractions.Importing;
using Nix.Domain.Tenancy;

namespace Nix.Features.DocumentImports;

/// <summary>Maps durable import records and staged worker items onto their response and plan shapes.</summary>
internal static class DocumentImportMapping
{
    internal static ImportEnvelopePlan ToPlan(StageDocumentImportItemRequest value) => new(
        value.SourceId,
        value.ParentSourceId,
        value.Order,
        value.Title,
        value.ItemType,
        Json(value.Properties),
        Json(value.Schema),
        Json(value.Views),
        value.FinalLifecycleState,
        value.BodyRequired,
        value.File is null
            ? null
            : new ImportFilePlan(
                value.File.SourceKind,
                value.File.AssetPath,
                value.File.FileName,
                value.File.MediaType,
                value.File.ByteLength,
                value.File.Sha256,
                value.File.Previewable,
                value.File.PixelWidth,
                value.File.PixelHeight),
        value.Comments);

    private static string? Json(JsonElement? value) => value is { ValueKind: JsonValueKind.Object }
        ? value.Value.GetRawText()
        : null;

    internal static DocumentImportResponse ToResponse(DocumentImportRecord value) => new(
        value.Id,
        value.WorkspaceId,
        value.UploadId,
        value.ParentId,
        value.Format,
        value.Title,
        value.Status,
        value.PreviewJobId,
        value.CommitJobId,
        value.ItemCount,
        value.AssetCount,
        ParseJson(value.Loss),
        ParseJson(value.Omissions),
        value.RootItemId,
        value.FailureCode,
        value.ExpiresAt,
        value.CompletedAt);

    private static JsonElement? ParseJson(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }
        using var document = JsonDocument.Parse(value, new JsonDocumentOptions { MaxDepth = 8 });
        return document.RootElement.Clone();
    }
}
