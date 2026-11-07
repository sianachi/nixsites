namespace Nix.Domain.Tenancy;

/// <summary>
/// One customer organisation, and the isolation boundary of the entire system.
/// </summary>
/// <remarks>
/// <para>
/// The rule that decides whether two groups are one tenant or two: if they must never see each
/// other's data even through a bug, they are separate tenants. Everything softer than that -
/// routine collaboration with some separation - is workspaces inside one tenant.
/// </para>
/// <para>
/// A tenant is the unit of row-level security isolation, identity provider registration, contract,
/// compliance authority, and lifecycle. Every tenant-scoped row in the database carries this
/// entity's identifier, and every database session is pinned to exactly one of them.
/// </para>
/// </remarks>
public sealed class Tenant
{
    /// <summary>Gets the tenant's identifier.</summary>
    public required TenantId Id { get; init; }

    /// <summary>Gets the organisation's display name.</summary>
    public required string Name { get; init; }

    /// <summary>
    /// Gets the isolation mode this tenant is deployed under.
    /// </summary>
    /// <remarks>
    /// Text rather than an enumeration for now. The deployment tiers exist (shared schema today,
    /// dedicated database and dedicated deployment later) but nothing in the M0 code reads this
    /// column, and inventing a vocabulary the tiering work would have to migrate away from is
    /// worse than storing what the operator chose.
    /// </remarks>
    public required string IsolationMode { get; init; }

    /// <summary>Gets when the tenant was created.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>Gets whether the organisation's administrators allow remote MCP access (the install must also offer it).</summary>
    public bool McpEnabled { get; set; } = true;

    /// <summary>Gets whether the organisation's administrators allow public links (the install must also enable them).</summary>
    public bool PublicLinksEnabled { get; set; } = true;
}
