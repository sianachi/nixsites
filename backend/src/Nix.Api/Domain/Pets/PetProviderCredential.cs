using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Pets;

/// <summary>
/// One person's API key for one model provider, protected at rest and forwarded to the companion
/// worker on each request. Never returned to a client; only its hint and validation time are.
/// </summary>
public sealed class PetProviderCredential
{
    public required TenantId TenantId { get; init; }

    public required PrincipalId PrincipalId { get; init; }

    /// <summary>The provider: <c>anthropic</c> or <c>openrouter</c>.</summary>
    public required string Provider { get; init; }

    /// <summary>The key, protected with Data Protection.</summary>
    public required ReadOnlyMemory<byte> ProtectedKey { get; init; }

    /// <summary>The key's last four characters, for recognising it in settings.</summary>
    public required string KeyHint { get; init; }

    public required DateTimeOffset SavedAt { get; init; }
}
