namespace Nix.Abstractions;

/// <summary>Durable, single-use OAuth authorization codes; only the code's hash is stored.</summary>
public interface IOAuthCodes
{
    /// <summary>Stores a code; false when the bounded table or the principal's live quota is full.</summary>
    public ValueTask<bool> CreateAsync(OAuthCodeRecord record, CancellationToken cancellationToken);

    /// <summary>Atomically removes and returns a code, whether or not it has expired; null when unknown or used.</summary>
    public ValueTask<OAuthCodeRecord?> ConsumeAsync(string codeHash, CancellationToken cancellationToken);
}

/// <summary>A pending authorization code and what the person approved.</summary>
/// <param name="CodeHash">SHA-256 of the code, lowercase hex.</param>
/// <param name="TenantId">The approving person's tenant.</param>
/// <param name="PrincipalId">The approving person.</param>
/// <param name="ClientId">The signed client identifier the code was issued to.</param>
/// <param name="RedirectUri">The redirect the code was sent to.</param>
/// <param name="Challenge">The PKCE S256 challenge.</param>
/// <param name="Scopes">Token scopes, comma separated.</param>
/// <param name="Resource">The resource the client named, if any.</param>
/// <param name="ExpiresAt">When the code stops being redeemable.</param>
[System.Diagnostics.CodeAnalysis.SuppressMessage("Design", "CA1056:URI-like properties should not be strings", Justification = "The wire contract carries the URI as a plain string.")]
[System.Diagnostics.CodeAnalysis.SuppressMessage("Design", "CA1054:URI-like parameters should not be strings", Justification = "The wire contract carries the URI as a plain string.")]
public sealed record OAuthCodeRecord(
    string CodeHash,
    Guid TenantId,
    Guid PrincipalId,
    string ClientId,
    string RedirectUri,
    string Challenge,
    string Scopes,
    string? Resource,
    DateTimeOffset ExpiresAt);
