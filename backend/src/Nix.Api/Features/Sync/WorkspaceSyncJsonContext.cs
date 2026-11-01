using System.Text.Json.Serialization;
using Nix.Domain.Sync;
using Nix.Features.Sync;

namespace Nix.Serialization;

/// <summary>Source-generated native mirror contracts.</summary>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(WorkspaceSyncSnapshot))]
[JsonSerializable(typeof(WorkspaceSyncChanges))]
[JsonSerializable(typeof(WorkspaceSyncReconciliation))]
[JsonSerializable(typeof(ReconcileWorkspaceSyncRequest))]
internal sealed partial class WorkspaceSyncJsonContext : JsonSerializerContext;
