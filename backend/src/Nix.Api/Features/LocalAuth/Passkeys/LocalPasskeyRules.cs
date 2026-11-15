using System.Text.Json;
using Nix.Abstractions;
using Nix.Authentication;

namespace Nix.Features.LocalAuth;

/// <summary>The small decisions about passkeys that do not need a request.</summary>
public static class LocalPasskeyRules
{
    /// <summary>The longest name a person can give a credential.</summary>
    public const int MaxName = 60;

    private const string DefaultName = "Passkey";

    /// <summary>
    /// True when taking <paramref name="target"/> away leaves no way in: a security key never signs in alone, so
    /// only a password or another full passkey counts. Removing a security key can never make things worse.
    /// </summary>
    public static bool RemovalLeavesNoSignIn(bool hasPassword, IReadOnlyList<LocalPasskeyRecord> all, LocalPasskeyRecord target)
    {
        ArgumentNullException.ThrowIfNull(all);
        ArgumentNullException.ThrowIfNull(target);
        return target.Kind == LocalPasskeyKind.Passkey
            && !hasPassword
            && !all.Any(p => p.Id != target.Id && p.Kind == LocalPasskeyKind.Passkey);
    }

    /// <summary>The name a person gave a credential: absent becomes "Passkey"; blank, control characters and long names are refused.</summary>
    public static bool TryName(string? raw, out string name)
    {
        name = raw is null ? DefaultName : raw.Trim();
        return name.Length is > 0 and <= MaxName && !name.Any(char.IsControl);
    }

    /// <summary>
    /// The /.well-known/webauthn document, or null when the RP id is the public host and none is needed.
    /// Browsers fetch it from the RP id's host to learn which origins may use that id.
    /// </summary>
    public static string? RelatedOriginsJson(AuthSettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        return settings is { NeedsRelatedOrigins: true, PublicOrigin: { } origin }
            ? $$"""{"origins":["{{JsonEncodedText.Encode(origin.GetLeftPart(UriPartial.Authority))}}"]}"""
            : null;
    }
}
