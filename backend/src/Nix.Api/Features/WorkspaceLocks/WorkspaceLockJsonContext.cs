using System.Text.Json.Serialization;
using Nix.Features.WorkspaceLocks;

namespace Nix.Serialization;

/// <summary>Source-generated serialization for the workspace password contracts.</summary>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(SetWorkspacePasswordRequest))]
[JsonSerializable(typeof(WorkspacePasswordRequest))]
[JsonSerializable(typeof(WorkspaceUnlockResponse))]
internal sealed partial class WorkspaceLockJsonContext : JsonSerializerContext;
