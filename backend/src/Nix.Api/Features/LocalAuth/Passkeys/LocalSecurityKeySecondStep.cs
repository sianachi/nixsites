using Nix.Abstractions;

namespace Nix.Features.LocalAuth;

/// <summary>
/// A security key imported as a second factor (decision 5): it never signs in alone, but a person who holds one
/// must answer it after a correct password. Enrolling makes the sign-in challenge offer it; the answer routes live
/// in <see cref="LocalPasskeyEndpoints"/>.
/// </summary>
public sealed class LocalSecurityKeySecondStep : ILocalSecondStepMethod
{
    /// <inheritdoc />
    public string Method => LocalSecondStepMethods.SecurityKey;

    /// <inheritdoc />
    public ValueTask<bool> IsEnrolledAsync(LocalAccountRecord account, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(account);
        return ValueTask.FromResult(account.SecurityKeyCount > 0);
    }
}
