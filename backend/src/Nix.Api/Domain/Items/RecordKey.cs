namespace Nix.Domain.Items;

/// <summary>
/// The claim on one canonical value of a unique field among the direct children of a collection.
/// The primary key is the uniqueness guard.
/// </summary>
public sealed class RecordKey
{
    public required Nix.Domain.Tenancy.TenantId TenantId { get; init; }
    public required ItemId ScopeItemId { get; init; }
    public required string Field { get; init; }
    public required string Value { get; init; }
    public required ItemId ItemId { get; init; }
}
