using System.Globalization;
using Microsoft.Extensions.Options;

namespace Nix.Authentication;

/// <summary>Which way an install proves who a person is. One per install, never both.</summary>
public enum AuthMode
{
    /// <summary>Core checks passwords, passkeys and authenticator codes itself.</summary>
    Local,

    /// <summary>One external OIDC authority (Nix:Bff) proves identity.</summary>
    Oidc,
}

/// <summary>Deployment-owned local sign-in settings.</summary>
public sealed class LocalAuthOptions
{
    /// <summary>Configuration section.</summary>
    public const string SectionName = "Nix:Auth";

    /// <summary>The shortest setup code accepted; it is the only guard on the first admin account.</summary>
    public const int MinimumSetupCodeLength = 12;

    /// <summary>"local" or "oidc". Empty means oidc when Nix:Bff:Authority is set, otherwise local.</summary>
    public string Mode { get; init; } = string.Empty;

    /// <summary>The code the first-run page asks for before it creates the first account.</summary>
    public string SetupCode { get; init; } = string.Empty;

    /// <summary>Passkey (WebAuthn) settings.</summary>
    public LocalPasskeyOptions Passkeys { get; init; } = new();
}

/// <summary>Passkey settings under Nix:Auth:Passkeys.</summary>
public sealed class LocalPasskeyOptions
{
    /// <summary>
    /// The WebAuthn relying-party id. Empty means the host of Nix:Bff:PublicOrigin. Migrated passkeys keep
    /// their old hostname here, which makes the install serve /.well-known/webauthn for the public origin.
    /// </summary>
    public string RpId { get; init; } = string.Empty;
}

/// <summary>The resolved sign-in mode and the values every local endpoint reads.</summary>
public sealed class AuthSettings(IOptions<LocalAuthOptions> auth, IOptions<BrowserAuthOptions> bff)
{
    private readonly LocalAuthOptions _auth = auth.Value;
    private readonly BrowserAuthOptions _bff = bff.Value;

    /// <summary>The mode in force.</summary>
    public AuthMode Mode => Resolve(_auth, _bff);

    /// <summary>Whether Core itself checks credentials.</summary>
    public bool IsLocal => Mode == AuthMode.Local;

    /// <summary>The first-run code, or empty when none is configured (setup is then impossible).</summary>
    public string SetupCode => _auth.SetupCode;

    /// <summary>The configured public origin, when valid.</summary>
    public Uri? PublicOrigin => _bff.TryPublicOrigin(out var origin) ? origin : null;

    /// <summary>The WebAuthn RP id: the configured one, else the public host, else null.</summary>
    public string? PasskeyRpId =>
        !string.IsNullOrWhiteSpace(_auth.Passkeys.RpId) ? _auth.Passkeys.RpId.Trim()
        : PublicOrigin?.IdnHost;

    /// <summary>True when the RP id is not the public host, so /.well-known/webauthn must list the public origin.</summary>
    public bool NeedsRelatedOrigins =>
        PasskeyRpId is { } rp && PublicOrigin is { } origin
        && !string.Equals(rp, origin.IdnHost, StringComparison.OrdinalIgnoreCase);

    /// <summary>Applies decision 1: an explicit mode wins, else the presence of an OIDC authority decides.</summary>
    public static AuthMode Resolve(LocalAuthOptions auth, BrowserAuthOptions bff)
    {
        ArgumentNullException.ThrowIfNull(auth);
        ArgumentNullException.ThrowIfNull(bff);
        if (TryParse(auth.Mode, out var mode))
        {
            return mode;
        }

        return string.IsNullOrWhiteSpace(bff.Authority) ? AuthMode.Local : AuthMode.Oidc;
    }

    /// <summary>Parses "local" or "oidc", ignoring case.</summary>
    public static bool TryParse(string? value, out AuthMode mode)
    {
        mode = AuthMode.Local;
        if (string.Equals(value?.Trim(), "local", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        if (string.Equals(value?.Trim(), "oidc", StringComparison.OrdinalIgnoreCase))
        {
            mode = AuthMode.Oidc;
            return true;
        }

        return false;
    }
}

/// <summary>Fails startup on a mode or setting that could never work.</summary>
public sealed class LocalAuthOptionsValidator(IOptions<BrowserAuthOptions> bff) : IValidateOptions<LocalAuthOptions>
{
    /// <inheritdoc />
    public ValidateOptionsResult Validate(string? name, LocalAuthOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        var failures = new List<string>();
        if (!string.IsNullOrWhiteSpace(options.Mode))
        {
            if (!AuthSettings.TryParse(options.Mode, out var mode))
            {
                failures.Add("Nix:Auth:Mode must be 'local' or 'oidc'.");
            }
            else if (mode == AuthMode.Oidc && string.IsNullOrWhiteSpace(bff.Value.Authority))
            {
                failures.Add("Nix:Auth:Mode is 'oidc' but Nix:Bff:Authority is not set.");
            }
        }

        // A value copied from an example file is published, so it is not a secret.
        if (options.SetupCode.Contains("replace-with", StringComparison.OrdinalIgnoreCase))
        {
            failures.Add("Nix:Auth:SetupCode is still a placeholder; generate one, for example with `openssl rand -hex 16`.");
        }

        if (options.SetupCode.Length is > 0 and < LocalAuthOptions.MinimumSetupCodeLength)
        {
            failures.Add(string.Create(
                CultureInfo.InvariantCulture,
                $"Nix:Auth:SetupCode must be at least {LocalAuthOptions.MinimumSetupCodeLength} characters."));
        }

        var rpId = options.Passkeys.RpId.Trim();
        if (rpId.Length > 0 && (rpId.Contains("://", StringComparison.Ordinal) || rpId.AsSpan().IndexOfAny('/', ':', ' ') >= 0))
        {
            failures.Add("Nix:Auth:Passkeys:RpId must be a bare host name.");
        }

        return failures.Count == 0 ? ValidateOptionsResult.Success : ValidateOptionsResult.Fail(failures);
    }
}
