using System.Text.RegularExpressions;
using Nix.Domain.Identity;

namespace Nix.Migrator.ZitadelImport;

/// <summary>A Nix principal already tied to a Zitadel user.</summary>
internal sealed record ExistingPrincipal(Guid PrincipalId, Guid TenantId);

/// <summary>What the Nix database already holds that the plan must respect.</summary>
internal sealed record NixState(
    IReadOnlyDictionary<string, ExistingPrincipal> PrincipalsBySubject,
    IReadOnlyDictionary<string, Guid> LocalAccountsByEmail,
    (Guid TenantId, string Issuer)? OnlyProvider);

/// <summary>One person to carry across.</summary>
internal sealed record PlannedAccount(
    ZitadelUser User, string Email, Guid PrincipalId, Guid TenantId, bool NewPrincipal,
    string? PasswordHash, DateTimeOffset? PasswordSetAt, byte[]? TotpSecret, IReadOnlyList<ZitadelWebAuthn> Passkeys);

/// <summary>Two or more people who would share one email.</summary>
internal sealed record EmailClash(string Email, IReadOnlyList<string> Owners);

/// <summary>The decided import: what to write, and what cannot be carried.</summary>
internal sealed class ImportPlan
{
    /// <summary>People to import.</summary>
    public List<PlannedAccount> Accounts { get; } = [];

    /// <summary>Emails that would collide; any entry stops the import.</summary>
    public List<EmailClash> Clashes { get; } = [];

    /// <summary>Things left behind, one line each.</summary>
    public List<string> NotCarried { get; } = [];

    /// <summary>Counts of left-behind items by category.</summary>
    public Dictionary<string, int> NotCarriedCounts { get; } = new(StringComparer.Ordinal);

    /// <summary>Problems that stop the import without being clashes.</summary>
    public List<string> Blockers { get; } = [];

    internal void Skip(string category, string detail)
    {
        NotCarriedCounts[category] = NotCarriedCounts.GetValueOrDefault(category) + 1;
        NotCarried.Add($"{category}: {detail}");
    }
}

/// <summary>Turns Zitadel users and their credentials into an import plan. No I/O.</summary>
internal static partial class ZitadelImportPlanner
{
    /// <summary>Zitadel's user state for a usable account.</summary>
    private const short ActiveState = 1;

    // The hash formats the sign-in verifier understands: bcrypt, argon2 and pbkdf2.
    [GeneratedRegex(@"^\$(2[abxy]|argon2(id|i|d)?|pbkdf2-[a-z0-9]+)\$", RegexOptions.CultureInvariant)]
    private static partial Regex SupportedHash();

    /// <summary>Builds the plan.</summary>
    public static ImportPlan Plan(
        IReadOnlyList<ZitadelUser> users,
        IReadOnlyDictionary<string, ZitadelCredentials> credentials,
        int machineUsers,
        NixState nix,
        Func<string, byte[]?> otpKey,
        Func<Guid, string, Guid> newPrincipalId)
    {
        ArgumentNullException.ThrowIfNull(users);
        ArgumentNullException.ThrowIfNull(credentials);
        ArgumentNullException.ThrowIfNull(nix);
        ArgumentNullException.ThrowIfNull(otpKey);
        ArgumentNullException.ThrowIfNull(newPrincipalId);

        var plan = new ImportPlan();
        for (var i = 0; i < machineUsers; i++)
        {
            plan.Skip("machine user", "replaced by Core access tokens (account service-token)");
        }

        var candidates = new List<(ZitadelUser User, string Email)>();
        foreach (var user in users)
        {
            if (user.State != ActiveState)
            {
                plan.Skip("inactive user", $"{user.Email} is not active in Zitadel (state {user.State})");
            }
            else if (!LocalAccountEmail.TryNormalize(user.Email, out var email))
            {
                plan.Skip("unusable email", $"user {user.Id} has no usable email address");
            }
            else
            {
                candidates.Add((user, email));
            }
        }

        foreach (var group in candidates.GroupBy(static c => c.Email, StringComparer.Ordinal).Where(static g => g.Count() > 1))
        {
            plan.Clashes.Add(new EmailClash(group.Key, [.. group.Select(static c => c.User.Id).Order(StringComparer.Ordinal)]));
        }

        foreach (var (user, email) in candidates)
        {
            var existing = nix.PrincipalsBySubject.GetValueOrDefault(user.Id);
            Guid tenant;
            Guid principal;
            if (existing is not null)
            {
                (principal, tenant) = (existing.PrincipalId, existing.TenantId);
            }
            else if (nix.OnlyProvider is { } provider)
            {
                tenant = provider.TenantId;
                principal = newPrincipalId(tenant, user.Id);
            }
            else
            {
                plan.Blockers.Add($"{user.Email} never signed in to Nix, and the install has no single identity provider to create them under.");
                continue;
            }

            if (nix.LocalAccountsByEmail.TryGetValue(email, out var owner) && owner != principal)
            {
                plan.Clashes.Add(new EmailClash(email, [user.Id, $"existing local account {owner}"]));
                continue;
            }

            plan.Accounts.Add(Build(user, email, principal, tenant, existing is null, credentials.GetValueOrDefault(user.Id), otpKey, plan));
        }

        return plan;
    }

    private static PlannedAccount Build(
        ZitadelUser user, string email, Guid principal, Guid tenant, bool isNew, ZitadelCredentials? c,
        Func<string, byte[]?> otpKey, ImportPlan plan)
    {
        string? hash = null;
        byte[]? totp = null;
        if (c is not null)
        {
            if (c.PasswordHash is { } stored)
            {
                if (SupportedHash().IsMatch(stored))
                {
                    hash = stored;
                }
                else
                {
                    plan.Skip("password hash", $"{email} has a hash format Nix cannot verify; issue a reset link");
                }
            }

            if (c is { OtpVerified: true, Otp: { } otp })
            {
                totp = Decrypt(email, otp, otpKey, plan);
            }
            else if (c.OtpVerified)
            {
                // Carrying the password without its second step would let the password alone sign in.
                plan.Blockers.Add($"{email} has an authenticator app whose secret could not be read from Zitadel's events.");
            }

            if (c.UnreadableWebAuthn.Count > 0)
            {
                plan.Blockers.Add($"{email} has {c.UnreadableWebAuthn.Count} passkey(s) or security key(s) that could not be read from Zitadel's events.");
            }

            if (c.Sms)
            {
                plan.Skip("SMS codes", email);
            }

            if (c.EmailCodes)
            {
                plan.Skip("email codes", email);
            }

            if (c.OutsideLogin)
            {
                plan.Skip("outside login link", email);
            }
        }

        return new PlannedAccount(
            user, email, principal, tenant, isNew, hash, c?.PasswordSetAt, totp,
            c is null ? [] : [.. c.WebAuthn.Values.OrderBy(static w => w.CreatedAt)]);
    }

    private static byte[]? Decrypt(string email, (string KeyId, byte[] Crypted) otp, Func<string, byte[]?> otpKey, ImportPlan plan)
    {
        if (otpKey(otp.KeyId) is not { } key)
        {
            plan.Blockers.Add($"The authenticator secret of {email} is encrypted with key '{otp.KeyId}', which the masterkey cannot unwrap.");
            return null;
        }

        try
        {
            return ZitadelCrypto.OtpSecret(otp.Crypted, key);
        }
        catch (Exception e) when (e is System.Security.Cryptography.CryptographicException or FormatException)
        {
            plan.Blockers.Add($"The authenticator secret of {email} could not be decrypted ({e.GetType().Name}); is the masterkey right?");
            return null;
        }
    }
}
