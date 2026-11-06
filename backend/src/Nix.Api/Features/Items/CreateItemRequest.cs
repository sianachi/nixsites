namespace Nix.Features.Items;

/// <summary>
/// Creates an item in a workspace.
/// </summary>
/// <param name="Type">
/// The kind to create, which says how the item's own body is drawn. <c>note</c> today. It says
/// nothing about what the item may contain: every item can hold children and offer views.
/// </param>
/// <param name="IdempotencyKey">Optional request identity for safely retrying an offline creation.</param>
/// <param name="Title">The display name.</param>
/// <param name="Properties">
/// Values to give the item on creation, or absent for none. Checked against the schema it is about
/// to fall under, exactly as a later write would be - creating a card already in a column must not
/// be a way to store a value the schema refuses.
/// </param>
/// <param name="ParentId">
/// The parent to create it under, or <see langword="null"/> to create it at the workspace root.
/// </param>
/// <remarks>
/// No client-supplied identifier and no sequence number. The server mints the identifier so it can
/// be time-ordered, and places the item among its siblings itself; a client that could choose
/// either would be able to collide with one it cannot see.
/// </remarks>
internal sealed record CreateItemRequest(
    string Type,
    string Title,
    Guid? ParentId,
    System.Text.Json.Nodes.JsonObject? Properties,
    Guid? IdempotencyKey = null,
    bool? Strict = null);
