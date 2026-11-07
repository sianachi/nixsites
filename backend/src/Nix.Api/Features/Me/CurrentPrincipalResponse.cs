namespace Nix.Features.CurrentUser;

/// <summary>
/// The signed-in caller, as the API presents them to themselves.
/// </summary>
/// <param name="Id">Their principal identifier.</param>
/// <param name="TenantId">The tenant they are acting in.</param>
/// <param name="DisplayName">Their name, for the shell.</param>
/// <param name="Email">Their email address, or <see langword="null"/> when the provider supplies none.</param>
/// <param name="IsTenantAdministrator">Whether tenant-wide administrative surfaces apply to them.</param>
/// <remarks>
/// <para>
/// <b><see cref="IsTenantAdministrator"/> is a display hint and nothing more.</b> It tells the shell
/// whether to offer administrative entries; it does not grant access to anything. Every endpoint
/// behind those entries answers the same question for itself against the database, so a client that
/// set this flag locally would gain a menu item and no capability whatsoever.
/// </para>
/// <para>
/// A boolean rather than a list of roles, because one is what the interface needs and the other
/// invites clients to compute permissions - which they must never do. When the interface needs
/// finer answers they will arrive as named capabilities the server has already decided, not as
/// role names for a client to interpret.
/// </para>
/// </remarks>
internal sealed record CurrentPrincipalResponse(
    Guid Id,
    Guid TenantId,
    string DisplayName,
    string? Email,
    bool IsTenantAdministrator,
    CurrentPrincipalFeatures Features);

/// <summary>
/// Which optional features this deployment has switched on, as display hints with the same standing
/// as <see cref="CurrentPrincipalResponse.IsTenantAdministrator"/>: they decide what the shell
/// offers, and every route behind an entry refuses for itself when the feature is off.
/// </summary>
/// <param name="Sites">Whether publishing items as sites is configured and enabled here.</param>
/// <param name="McpUrl">The remote MCP endpoint this deployment serves (<c>Nix:Mcp:PublicUrl</c>), or null when absent or turned off for the organization.</param>
/// <param name="Operator">Whether the caller is listed in <c>Nix:Sites:Operators</c> and so may read instance-wide data such as backup status.</param>
/// <param name="SiteApprover">Whether the caller may decide first publishes: configured, granted in Settings, or an administrator when none is configured.</param>
/// <param name="PublicLinks">Whether public links work for the caller's organization: the install flag and the tenant switch are both on.</param>
/// <param name="McpEnabled">The organization's own MCP switch, whatever the deployment advertises; the remote MCP server reads it, because a null <c>McpUrl</c> also means an install with no URL.</param>
internal sealed record CurrentPrincipalFeatures(bool Sites, string? McpUrl, bool Operator, bool SiteApprover, bool PublicLinks, bool McpEnabled);
