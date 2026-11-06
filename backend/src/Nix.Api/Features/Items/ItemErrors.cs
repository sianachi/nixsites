using Nix.Domain.Primitives;

namespace Nix.Features.Items;

/// <summary>
/// The expected failures of the item feature, and the stable codes the API surfaces for them.
/// </summary>
/// <remarks>
/// <para>
/// Declared once here rather than constructed at each call site, because the code is the part
/// clients branch on and a typo in one of them is a bug nobody notices until a frontend stops
/// handling a case it used to. The endpoint layer maps these codes onto status codes; it does not
/// invent codes of its own.
/// </para>
/// <para>
/// <b>An item the caller may not read is reported as not found</b>, never as forbidden. The
/// distinction is deliberate and it is a security property: "you may not see this" confirms the
/// thing exists, which is how an outsider enumerates a workspace one identifier at a time.
/// </para>
/// </remarks>
public static class ItemErrors
{
    /// <summary>No such item, or the caller cannot see it.</summary>
    public static NixError NotFound(string detail) => new("items.not_found", detail);

    /// <summary>The requested parent does not exist or is not visible.</summary>
    public static NixError ParentNotFound(string detail) => new("items.parent_not_found", detail);

    /// <summary>The destination of a move is the item itself or one of its descendants.</summary>
    public static NixError WouldCreateCycle(string detail) =>
        new("items.move_would_create_cycle", detail);

    /// <summary>
    /// A move named a sibling to be placed after that is not a child of the destination.
    /// </summary>
    public static NixError SiblingNotInDestination(string detail) =>
        new("items.sibling_not_in_destination", detail);

    /// <summary>The operation is not valid in the item's current lifecycle state.</summary>
    public static NixError LifecycleConflict(string detail) =>
        new("items.lifecycle_conflict", detail);

    /// <summary>
    /// A lock the caller has not opened covers the item, so its children cannot be listed and it
    /// cannot be moved across the lock's edge.
    /// </summary>
    /// <remarks>
    /// Not a disclosure: the caller can already see the item, and that it is locked is what they
    /// meet when they open it.
    /// </remarks>
    public static NixError Locked(string detail) => new("items.locked", detail);

    /// <summary>
    /// The item, or an item beneath it, is protected from deletion.
    /// </summary>
    /// <remarks>Not a disclosure, for the reason <see cref="Locked"/> is not one.</remarks>
    public static NixError DeleteProtected(string detail) => new("items.delete_protected", detail);

    /// <summary>The item, or a file beneath it, is pinned by a reference and must be unpinned before it is trashed.</summary>
    public static NixError Pinned(string detail) => new("items.pinned", detail);

    /// <summary>The destination refuses new children.</summary>
    public static NixError ChildrenProtected(string detail) => new("items.children_protected", detail);

    /// <summary>The system manages this protection, so it is not the caller's to change.</summary>
    public static NixError ProtectionManaged(string detail) => new("items.protection_managed", detail);

    /// <summary>The item mirrors something the caller may not edit at its source.</summary>
    public static NixError ReadOnly(string detail) => new("items.read_only", detail);

    /// <summary>A workspace transfer cannot preserve the current state safely.</summary>
    public static NixError TransferConflict(string detail) => new("items.transfer_conflict", detail);

    /// <summary>The workspace does not exist or is not visible.</summary>
    public static NixError WorkspaceNotFound(string detail) =>
        new("workspaces.not_found", detail);

    /// <summary>The caller can see the item and may not change its body.</summary>
    public static NixError BodyReadOnly(string detail) => new(ItemEndpoints.BodyReadOnlyCode, detail);

    /// <summary>The Markdown is not a note this build can store.</summary>
    public static NixError MarkdownInvalid(string detail) => new(ItemEndpoints.MarkdownInvalidCode, detail);

    /// <summary>The Markdown is longer than the body route accepts.</summary>
    public static NixError MarkdownTooLarge(string detail) => new(ItemEndpoints.MarkdownTooLargeCode, detail);

    /// <summary>The item's body is a kind Markdown cannot carry.</summary>
    public static NixError BodyNotProse(string detail) => new(ItemEndpoints.BodyNotProseCode, detail);

    /// <summary>The collaboration service could not apply or return the body.</summary>
    public static NixError BodyUnavailable(string detail) => new(ItemEndpoints.BodyUnavailableCode, detail);

    /// <summary>The merged note would exceed a document ceiling.</summary>
    public static NixError BodyTooLarge(string detail) => new(ItemEndpoints.BodyTooLargeCode, detail);

    /// <summary>The document has taken more updates than the collaboration window allows.</summary>
    public static NixError BodyRateLimited(string detail) => new(ItemEndpoints.BodyRateLimitedCode, detail);

    /// <summary>The body could not be written because of the document's schema pin.</summary>
    public static NixError BodyConflict(string detail) => new(ItemEndpoints.BodyConflictCode, detail);
}
