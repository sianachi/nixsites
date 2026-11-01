using System.Text.Json;
using System.Text.Json.Serialization;
using Nix.Domain.Sync;
using Nix.Domain.Tenancy;
using Nix.Messaging;

namespace Nix.Features.Sync;

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record NativeReplayRequest(Guid OperationId, string Kind, Guid ItemId, string? ExpectedRevision, JsonElement Payload);

public sealed record NativeReplay(WorkspaceId WorkspaceId, NativeReplayRequest Request) : ICommand<NativeReplayResponse>;

public sealed record NativeReplayResponse(
    Guid OperationId, string Status, Guid ItemId, string? Revision, NativeItemSnapshot? Item, string? Code);

[JsonSerializable(typeof(NativeReplayRequest))]
[JsonSerializable(typeof(NativeReplayResponse))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
internal sealed partial class NativeReplayJsonContext : JsonSerializerContext;
