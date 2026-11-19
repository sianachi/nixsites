using System.Text.Json;
using System.Text.Json.Serialization;
using Nix.Abstractions.PetPeers;

namespace Nix.Features.PetPeers;

internal sealed record RegisterPetPeerRequest(string? Name, string? Kind, int Days = 30);
internal sealed record RegisteredPetPeer(PetPeerRegistration Peer, string Endpoint, string Credential);
internal sealed record PetPeersResponse(IReadOnlyList<PetPeerRegistration> Peers);
internal sealed record PetPeerWorkResponse(IReadOnlyList<PetPeerWorkView> Work);
internal sealed record PetPeerWorkView(Guid Id, Guid PeerId, Guid RunId, string Direction, string Status,
    string? Result, DateTimeOffset CreatedAt);
internal sealed record PetPeerDispatchRequest(string? Operation, Guid? RequestId = null, Guid? RunId = null,
    Guid? WorkId = null, Guid? LeaseId = null, string? Brief = null, string? Result = null, bool? Succeeded = null);
internal sealed record PetPeerMode(string Kind);
internal sealed record PetPeerRunView(Guid Id, string Status, long Revision);
internal sealed record PetPeerResult(Guid RunId, string? Result);
internal sealed record PetPeerAssignment(Guid WorkId, Guid RunId, string Brief);
internal sealed record ClaimedPetPeerWork(Guid WorkId, Guid LeaseId, string Credential, DateTimeOffset LeaseExpiresAt, string Runtime);
internal sealed record PetPeerClaim(ClaimedPetPeerWork? Work);
internal sealed record PetPeerFinish(bool Recorded);
internal sealed record PetPeerDelegation(Guid? PeerId, string? PeerName, string? Brief);
internal sealed record PetPeerAction(Guid PeerId, string Brief);
internal sealed record PetPeerResultShare(Guid PeerId, string Result);
internal sealed record PetPeerResultRead(Guid PeerId, Guid WorkId);
internal sealed record PetPeerActionReceipt(Guid WorkId, Guid PeerId, string Status,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Result = null);

[JsonSourceGenerationOptions(JsonSerializerDefaults.Web)]
[JsonSerializable(typeof(RegisterPetPeerRequest))]
[JsonSerializable(typeof(RegisteredPetPeer))]
[JsonSerializable(typeof(PetPeersResponse))]
[JsonSerializable(typeof(PetPeerWorkResponse))]
[JsonSerializable(typeof(PetPeerDispatchRequest))]
[JsonSerializable(typeof(PetPeerMode))]
[JsonSerializable(typeof(PetPeerRunView))]
[JsonSerializable(typeof(PetPeerResult))]
[JsonSerializable(typeof(PetPeerAssignment))]
[JsonSerializable(typeof(PetPeerClaim))]
[JsonSerializable(typeof(PetPeerFinish))]
[JsonSerializable(typeof(PetPeerDelegation))]
[JsonSerializable(typeof(PetPeerAction))]
[JsonSerializable(typeof(PetPeerResultShare))]
[JsonSerializable(typeof(PetPeerResultRead))]
[JsonSerializable(typeof(PetPeerActionReceipt))]
[JsonSerializable(typeof(JsonElement))]
internal sealed partial class PetPeerJsonContext : JsonSerializerContext;
