using System.Text.Json.Nodes;

namespace Nix.Features.Items;

/// <summary>
/// An item as the API presents it.
/// </summary>
/// <param name="Id">The item's identifier.</param>
/// <param name="WorkspaceId">The workspace it belongs to.</param>
/// <param name="ParentId">Its parent, or <see langword="null"/> for a workspace root.</param>
/// <param name="Type">
/// Its kind, which says how its own body is drawn rather than what it may contain.
/// </param>
/// <param name="Title">Its display name.</param>
/// <param name="HasChildren">
/// Whether this item has at least one child that is not deleted.
/// </param>
/// <param name="Seq">Its position among its siblings.</param>
/// <param name="LifecycleState">Where it sits in the deletion lifecycle.</param>
/// <param name="Properties">
/// Its property values, keyed by the schema's property keys. Empty when it has none.
/// </param>
/// <param name="Computed">
/// The values this item has without storing one: every rollup the schema in force declares, folded
/// across this item's own children. Null when the read did not compute them.
/// </param>
/// <param name="NoDelete">
/// Whether it is protected from deletion. It, and any ancestor holding it, cannot be trashed.
/// </param>
/// <param name="NoChildren">Whether it refuses new children.</param>
/// <param name="Collaboration">
/// Whether several people may edit it at once. Its workspace's own switch can still turn it off.
/// </param>
/// <param name="ManagedBy">
/// The system feature managing it ('calendar' for a linked calendar's container, 'calendar_event'
/// for a mirrored event), or null. A managed item's deletion protection cannot be switched off here.
/// </param>
/// <param name="CreatedAt">When it was created.</param>
/// <param name="UpdatedAt">When it was last modified.</param>
/// <remarks>
/// <para>
/// <b><see cref="Title"/> is a property, promoted.</b> The item table has no title column - a
/// name is one of the schema-driven properties an item carries, like any other. It is lifted to a
/// first-class field here because every client needs it to render a row and none of them should
/// have to reach into a property bag to find out what a thing is called. The goal that implements
/// items owns that mapping.
/// </para>
/// <para>
/// <b><see cref="Type"/> is an open string, not an enumeration.</b> Adding a kind of item should
/// be a feature rather than a breaking change to every generated client, so clients are expected
/// to render an unknown type generically instead of failing to parse it.
/// </para>
/// <para>
/// <b><see cref="Properties"/> carries the whole bag, title included.</b> The promotion of
/// <see cref="Title"/> to a first-class field is a convenience for the rows every client renders,
/// not a claim that the title is stored separately - it is one property among the others, and a
/// list view showing a "Title" column alongside the rest would find nothing there if the bag hid
/// it. What a client should not do is write through both: renames go through the item's own
/// operation, which is why the property write refuses to redeclare that key.
/// </para>
/// </remarks>
internal sealed record ItemResponse(
    Guid Id,
    Guid WorkspaceId,
    Guid? ParentId,
    string Type,
    string Title,
    bool HasChildren,
    long Seq,
    string LifecycleState,
    JsonObject Properties,
    JsonObject? Computed,
    bool NoDelete,
    bool NoChildren,
    bool Collaboration,
    string? ManagedBy,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt);
