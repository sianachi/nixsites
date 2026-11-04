using System.Text.Json.Serialization;

namespace Nix.Workers.Push;

/// <summary>The VAPID JWT claims, in the order RFC 8292's example writes them.</summary>
internal sealed record VapidClaims(
    [property: JsonPropertyName("aud")] string Audience,
    [property: JsonPropertyName("exp")] long Expiry,
    [property: JsonPropertyName("sub")] string Subject);

[JsonSerializable(typeof(VapidClaims))]
internal sealed partial class WebPushJsonContext : JsonSerializerContext;
