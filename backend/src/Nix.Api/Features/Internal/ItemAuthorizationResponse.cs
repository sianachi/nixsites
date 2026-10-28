namespace Nix.Features.Internal;

/// <summary>
/// The wire shape of an item authorization, consumed by the collaboration service at session
/// establishment and on every periodic re-check.
/// </summary>
/// <param name="TenantId">The tenant the principal is acting in.</param>
/// <param name="PrincipalId">The acting principal, resolved from the forwarded token.</param>
/// <param name="WorkspaceId">The workspace the item lives in.</param>
/// <param name="CanRead">
/// Always <see langword="true"/> on a 200: an unreadable item is answered 404, never described.
/// Carried anyway so the contract states the fact instead of implying it.
/// </param>
/// <param name="CanWrite">Whether the principal may append updates to the item's body.</param>
/// <param name="BodyKind">The item's <c>type</c>, which validation dispatches on. Open string.</param>
/// <param name="Collaborative">Whether several people may edit at once; false means one editor at a time.</param>
public sealed record ItemAuthorizationResponse(
    Guid TenantId,
    Guid PrincipalId,
    Guid WorkspaceId,
    bool CanRead,
    bool CanWrite,
    string BodyKind,
    bool Collaborative);
