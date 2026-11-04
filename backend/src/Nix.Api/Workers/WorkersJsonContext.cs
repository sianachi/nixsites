using System.Text.Json.Serialization;

namespace Nix.Workers;

/// <summary>Result payloads the in-process handlers store on their jobs.</summary>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(NotifyPushResult))]
[JsonSerializable(typeof(ObjectCleanupResult))]
[JsonSerializable(typeof(TemplateFileCopyResult))]
[JsonSerializable(typeof(FilePublishResult))]
[JsonSerializable(typeof(DocumentImportPreviewResult))]
[JsonSerializable(typeof(DocumentImportCommitResult))]
[JsonSerializable(typeof(ImportBodyWrites))]
[JsonSerializable(typeof(TemplateImportPreviewResult))]
[JsonSerializable(typeof(TemplateImportCommitResult))]
[JsonSerializable(typeof(TemplateBodyWrites))]
[JsonSerializable(typeof(TemplateBodyWriteResponse))]
internal sealed partial class WorkersJsonContext : JsonSerializerContext;
