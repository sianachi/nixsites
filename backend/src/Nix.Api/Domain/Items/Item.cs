using Nix.Domain.Identity;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Items;

/// <summary>
/// The universal object. One parent, exactly one workspace, properties validated against an
/// inherited schema, and children of its own if anything has been put inside it.
/// </summary>
/// <remarks>
/// <para>
/// One table for every kind of thing is the decision the rest of the product rests on. It is why
/// anything can hold anything, why a task can be given a document body, and why permissions,
/// search, and the tree have one implementation each rather than one per type. <see cref="Type"/>
/// discriminates behaviour; it does not discriminate storage.
/// </para>
/// <para>
/// Content bodies (<c>content_doc</c>) and file bodies (<c>file_version</c>) live in their own
/// tables. Property schemas and views are columns here, per ADR-0006. Saved cross-folder queries
/// (<c>query</c>) arrive with the phase that builds them, in that phase's own migration.
/// </para>
/// </remarks>
public sealed class Item
{
    /// <summary>Gets the item's identifier.</summary>
    public required ItemId Id { get; init; }

    /// <summary>Gets the owning tenant.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the workspace the item lives in.</summary>
    public required WorkspaceId WorkspaceId { get; init; }

    /// <summary>
    /// Gets the item's kind, which says how its own body is drawn - a note's prose, a canvas's
    /// scene.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Text rather than an enumeration because the set is open by design: adding a kind should be a
    /// feature, not a migration.
    /// </para>
    /// <para>
    /// <b>It says nothing about what an item may contain.</b> Every item can hold children, declare
    /// a property schema and offer views, whatever its kind. "Folder" used to be a kind here and
    /// was never a body at all - only a claim about containment that the schema never made.
    /// </para>
    /// </remarks>
    public required string Type { get; init; }

    /// <summary>
    /// Gets the parent item, or <see langword="null"/> for a workspace root.
    /// </summary>
    /// <remarks>
    /// Single-parent by construction. The closure table derives ancestry from this column and is
    /// rebuildable from it, so this is the durable fact and the closure is the index.
    /// </remarks>
    public ItemId? ParentId { get; init; }

    /// <summary>
    /// Gets the item's position among its siblings.
    /// </summary>
    /// <remarks>
    /// Sparse rather than dense: gaps are left between neighbours so an insertion writes one row
    /// instead of renumbering the whole sibling set.
    /// </remarks>
    public required long Seq { get; init; }

    /// <summary>
    /// Gets the item's properties as a JSON object, or <see langword="null"/> when it has none.
    /// </summary>
    /// <remarks>
    /// Held as a JSON string rather than a parsed document: nothing in this phase reads it, and
    /// keeping it opaque avoids paying for a parse on every item read. The goal that introduces
    /// property schemas owns the typed representation and the validation on write.
    /// </remarks>
    public string? Properties { get; init; }

    /// <summary>
    /// Gets the property schema this item declares for itself and its descendants, as a JSON
    /// object, or <see langword="null"/> when it declares none.
    /// </summary>
    /// <remarks>
    /// Held as a JSON string for the same reason <see cref="Properties"/> is: most reads of an
    /// item do not want it, and parsing on every one would be paid by every listing.
    /// <c>Nix.Domain.Properties.PropertySchemaJson</c> owns the typed representation, and is the
    /// only thing that should read this.
    /// </remarks>
    public string? Schema { get; init; }

    /// <summary>
    /// Gets the views this container offers, as a JSON object, or <see langword="null"/> when it
    /// offers none.
    /// </summary>
    /// <remarks>
    /// A view is a way of rendering this item's children, stored on the container because that is
    /// what it belongs to - "board" is something a folder can be shown as, not a place in the
    /// application. <c>Nix.Domain.Views.ViewDefinitionsJson</c> owns the typed representation.
    /// </remarks>
    public string? Views { get; init; }

    /// <summary>
    /// The item's repeating rule, when it has one, as JSON.
    /// </summary>
    /// <remarks>
    /// Held as a JSON string for the same reason <see cref="Properties"/> is. Goal 3.2 will add
    /// the typed representation and the one write path; until then nothing writes this column and
    /// the database CHECK is its only bound. Null for the overwhelming majority of items, which
    /// is what makes the partial index over it cheap.
    /// </remarks>
    public string? Recurrence { get; init; }

    /// <summary>
    /// The first ten characters of the reserved <c>due_date</c> property, maintained by Postgres.
    /// </summary>
    /// <remarks>
    /// A stored generated column, never written by this application - it exists because a
    /// predicate over <c>properties -&gt;&gt; key</c> can never be an index condition under row
    /// security (<c>-&gt;&gt;</c> is not leakproof), while a plain column reference is. Read-only by
    /// contract; the write paths never name it.
    /// </remarks>
    public string? DueDay { get; init; }

    /// <summary>
    /// Gets the catalog template this hidden item belongs to, or <see langword="null"/> for an
    /// ordinary workspace item.
    /// </summary>
    public TemplateId? TemplateId { get; init; }

    /// <summary>
    /// Gets this node's stable identity inside a template, preserved when a managed revision is
    /// replaced so applications never match children by title.
    /// </summary>
    public Guid? TemplateSourceId { get; init; }

    /// <summary>
    /// Gets whether the item is protected from deletion: it cannot be trashed, and neither can an
    /// ancestor while it sits beneath it.
    /// </summary>
    /// <remarks>
    /// Set by anybody who may edit the item, or by the system for an item it manages (see
    /// <see cref="ManagedBy"/>), in which case only the system clears it.
    /// </remarks>
    public bool NoDelete { get; init; }

    /// <summary>
    /// Gets whether the item refuses new children: nothing can be created under it or moved into it.
    /// </summary>
    public bool NoChildren { get; init; }

    /// <summary>
    /// Gets whether several people may edit this item's body at once. When off (here or on its
    /// workspace), one person edits and everyone else reads until they leave.
    /// </summary>
    public bool Collaboration { get; init; } = true;

    /// <summary>
    /// Gets the system feature that manages this item, or <see langword="null"/> for an ordinary
    /// item. One of <see cref="ItemManagers"/>.
    /// </summary>
    /// <remarks>
    /// A managed item's deletion protection is the system's, not the user's: it is removed by the
    /// feature that set it (unlinking a calendar in settings), never by the protection toggle.
    /// </remarks>
    public string? ManagedBy { get; init; }

    /// <summary>Gets where the item sits in the deletion lifecycle.</summary>
    public required ItemLifecycleState LifecycleState { get; init; }

    /// <summary>
    /// Gets when a soft-deleted item becomes eligible for purge, or <see langword="null"/> if it
    /// is not scheduled. Legal hold blocks the transition regardless of this value.
    /// </summary>
    public DateTimeOffset? PurgeAfter { get; init; }

    /// <summary>Gets who created the item.</summary>
    public required PrincipalId CreatedBy { get; init; }

    /// <summary>Gets who last modified it.</summary>
    public required PrincipalId LastModifiedBy { get; init; }

    /// <summary>Gets when the item was created.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>Gets when the item was last modified.</summary>
    public required DateTimeOffset LastModifiedAt { get; init; }
}
