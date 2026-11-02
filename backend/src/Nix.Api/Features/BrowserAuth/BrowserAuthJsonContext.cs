using System.Text.Json.Serialization;

namespace Nix.Features.BrowserAuth;

/// <summary>Source-generated JSON metadata for browser authentication.</summary>
[JsonSerializable(typeof(BrowserSessionResponse))]
[JsonSerializable(typeof(BrowserProfileResponse))]
[JsonSerializable(typeof(BrowserTokenResponse))]
[JsonSerializable(typeof(NativeRedeemRequest))]
[JsonSerializable(typeof(CliLoginStartRequest))]
[JsonSerializable(typeof(CliLoginStartResponse))]
[JsonSerializable(typeof(CliLoginPollRequest))]
[JsonSerializable(typeof(CliLoginPollResponse))]
[JsonSerializable(typeof(CliLoginTokenRequest))]
[JsonSerializable(typeof(CliLoginTokenResponse))]
internal sealed partial class BrowserAuthJsonContext : JsonSerializerContext;
