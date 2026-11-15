using System.Text.Json;

namespace Nix.Migrator.ZitadelImport;

/// <summary>
/// Replays one user's events, in order, into what they can sign in with now. Zitadel keeps no table of password
/// hashes, authenticator secrets or WebAuthn keys: the event payloads are the only place they exist.
/// </summary>
internal static class ZitadelEventFold
{
    private const string Passwordless = "user.human.passwordless.token.";
    private const string SecurityKey = "user.human.u2f.token.";

    /// <summary>Folds events (already ordered by sequence within each user) into credentials by user id.</summary>
    public static Dictionary<string, ZitadelCredentials> Fold(IEnumerable<ZitadelEvent> events)
    {
        ArgumentNullException.ThrowIfNull(events);
        var users = new Dictionary<string, ZitadelCredentials>(StringComparer.Ordinal);
        foreach (var e in events)
        {
            if (!users.TryGetValue(e.AggregateId, out var user))
            {
                users[e.AggregateId] = user = new ZitadelCredentials();
            }

            Apply(user, e);
        }

        return users;
    }

    private static void Apply(ZitadelCredentials user, ZitadelEvent e)
    {
        switch (e.Type)
        {
            case "user.human.added" or "user.human.password.changed":
                var hash = Text(e.Payload, "encodedHash");
                if (!string.IsNullOrEmpty(hash))
                {
                    user.PasswordHash = hash;
                    user.PasswordSetAt = e.CreatedAt;
                }

                break;
            case "user.human.mfa.otp.added":
                user.OtpVerified = false;
                user.Otp = Secret(e.Payload);
                break;
            case "user.human.mfa.otp.verified":
                user.OtpVerified = true;
                break;
            case "user.human.mfa.otp.removed":
                user.Otp = null;
                user.OtpVerified = false;
                break;
            case "user.human.mfa.otp.sms.added":
                user.Sms = true;
                break;
            case "user.human.mfa.otp.sms.removed":
                user.Sms = false;
                break;
            case "user.human.mfa.otp.email.added":
                user.EmailCodes = true;
                break;
            case "user.human.mfa.otp.email.removed":
                user.EmailCodes = false;
                break;
            case "user.human.externalidp.added":
                user.OutsideLogin = true;
                break;
            default:
                if (e.Type.StartsWith(Passwordless, StringComparison.Ordinal))
                {
                    ApplyToken(user, e, securityKey: false, e.Type[Passwordless.Length..]);
                }
                else if (e.Type.StartsWith(SecurityKey, StringComparison.Ordinal))
                {
                    ApplyToken(user, e, securityKey: true, e.Type[SecurityKey.Length..]);
                }

                break;
        }
    }

    private static void ApplyToken(ZitadelCredentials user, ZitadelEvent e, bool securityKey, string action)
    {
        var id = Text(e.Payload, "webAuthNTokenId");
        if (id is null)
        {
            return;
        }

        switch (action)
        {
            case "verified":
                if (Text(e.Payload, "keyId") is { } keyId && Text(e.Payload, "publicKey") is { } publicKey
                    && TryBase64(keyId) is { } credentialId && TryBase64(publicKey) is { } key)
                {
                    user.WebAuthn[id] = new ZitadelWebAuthn(
                        id, securityKey, credentialId, key, Number(e.Payload, "signCount"), Aaguid(Text(e.Payload, "aaguid")),
                        Text(e.Payload, "webAuthNTokenName") ?? string.Empty, e.CreatedAt);
                }
                else
                {
                    _ = user.UnreadableWebAuthn.Add(id);
                }

                break;
            case "removed":
                _ = user.WebAuthn.Remove(id);
                _ = user.UnreadableWebAuthn.Remove(id);
                break;
            case "signcount.changed" when user.WebAuthn.TryGetValue(id, out var token):
                user.WebAuthn[id] = token with { SignCount = Number(e.Payload, "signCount") };
                break;
            default:
                break;
        }
    }

    private static (string, byte[])? Secret(JsonElement payload)
    {
        if (Find(payload, "otpSecret") is not { ValueKind: JsonValueKind.Object } secret
            || Text(secret, "crypted") is not { } crypted || TryBase64(crypted) is not { } bytes)
        {
            return null;
        }

        return (Text(secret, "keyId") ?? string.Empty, bytes);
    }

    // Go writes untagged struct fields under their Go names and decodes them case-insensitively; match the same way.
    private static JsonElement? Find(JsonElement payload, string name)
    {
        if (payload.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        foreach (var property in payload.EnumerateObject())
        {
            if (string.Equals(property.Name, name, StringComparison.OrdinalIgnoreCase))
            {
                return property.Value;
            }
        }

        return null;
    }

    private static string? Text(JsonElement payload, string name) =>
        Find(payload, name) is { ValueKind: JsonValueKind.String } value ? value.GetString() : null;

    private static long Number(JsonElement payload, string name) =>
        Find(payload, name) is { ValueKind: JsonValueKind.Number } value && value.TryGetInt64(out var n) ? n : 0;

    /// <summary>Go encodes byte slices as standard base64; accept the URL-safe alphabet too.</summary>
    internal static byte[]? TryBase64(string value)
    {
        var text = value.Replace('-', '+').Replace('_', '/').TrimEnd('=');
        text = text.PadRight(text.Length + ((4 - (text.Length % 4)) % 4), '=');
        var buffer = new byte[text.Length]; // byte[]: Convert.TryFromBase64String writes into a span over an array
        return Convert.TryFromBase64String(text, buffer, out var written) ? buffer[..written] : null;
    }

    private static Guid? Aaguid(string? value)
    {
        if (value is null || TryBase64(value) is not { Length: 16 } bytes || bytes.All(static b => b == 0))
        {
            return null;
        }

        return new Guid(bytes, bigEndian: true);
    }
}
