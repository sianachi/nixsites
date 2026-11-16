using System.Text.Json.Serialization;

namespace Nix.Features.LocalAuth;

/// <summary>First-run setup: the operator's code plus the first account.</summary>
internal sealed record LocalSetupRequest(string? SetupCode, string? Email, string? Name, string? Password, string? ReturnTo = null, string? Native = null);

/// <summary>Password sign-in.</summary>
internal sealed record LocalSignInRequest(string? Email, string? Password, string? ReturnTo, string? Native);

/// <summary>A finished sign-in; the session cookie has been set (or the native handoff prepared).</summary>
internal sealed record LocalSignedInResponse(string Status, string RedirectTo)
{
    internal static LocalSignedInResponse At(string redirectTo) => new("signed_in", redirectTo);
}

/// <summary>A correct password that still needs a second step.</summary>
internal sealed record LocalSecondStepResponse(string Status, Guid ChallengeId, IReadOnlyList<string> Methods);

/// <summary>What a live link is for, so the page can greet the person.</summary>
internal sealed record LocalLinkInfoResponse(string Purpose, string Email, string Name);

/// <summary>Choosing a password through a link.</summary>
internal sealed record LocalLinkPasswordRequest(string? Password);

/// <summary>Changing or adding a password. The current one is required whenever a password exists.</summary>
internal sealed record LocalChangePasswordRequest(string? CurrentPassword, string? NewPassword);

/// <summary>A body that only proves the current password.</summary>
internal sealed record LocalCurrentPasswordRequest(string? CurrentPassword);

/// <summary>One credential in the security summary.</summary>
internal sealed record LocalPasskeySummary(Guid Id, string Name, string Kind, DateTimeOffset CreatedAt, DateTimeOffset? LastUsedAt);

/// <summary>The caller's own sign-in methods.</summary>
internal sealed record LocalSecuritySummary(
    bool HasPassword,
    bool TotpEnabled,
    IReadOnlyList<LocalPasskeySummary> Passkeys,
    string? PasskeyRpId);

/// <summary>Source-generated JSON metadata for local sign-in.</summary>
[JsonSerializable(typeof(LocalSetupRequest))]
[JsonSerializable(typeof(LocalSignInRequest))]
[JsonSerializable(typeof(LocalSignedInResponse))]
[JsonSerializable(typeof(LocalSecondStepResponse))]
[JsonSerializable(typeof(LocalLinkInfoResponse))]
[JsonSerializable(typeof(LocalLinkPasswordRequest))]
[JsonSerializable(typeof(LocalChangePasswordRequest))]
[JsonSerializable(typeof(LocalCurrentPasswordRequest))]
[JsonSerializable(typeof(LocalSecuritySummary))]
internal sealed partial class LocalAuthJsonContext : JsonSerializerContext;
