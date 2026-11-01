using System.Text.Json.Serialization;
using Nix.Features.Health;

namespace Nix.Serialization;

/// <summary>
/// The health feature's JSON contract, source-generated.
/// </summary>
/// <remarks>
/// One context per feature rather than one for the API, and <c>Program</c> chains them all onto
/// the serializer's resolver chain. The generated output is equivalent either way; what changes is
/// that adding a response type touches a file inside one feature instead of a file every feature
/// shares. With several goals in flight at once, a single registration point is a merge conflict
/// on every one of them - and they are the boring kind that get resolved carelessly.
/// </remarks>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(LivenessResponse))]
[JsonSerializable(typeof(ServiceStatusResponse))]
[JsonSerializable(typeof(SystemVersionsResponse))]
[JsonSerializable(typeof(HealthCheckResponse))]
internal sealed partial class HealthJsonContext : JsonSerializerContext;
