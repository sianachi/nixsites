using System.Text.Json.Serialization;

namespace Nix.Workers;

/// <summary>Result payloads the in-process handlers store on their jobs.</summary>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(NotifyPushResult))]
internal sealed partial class WorkersJsonContext : JsonSerializerContext;
