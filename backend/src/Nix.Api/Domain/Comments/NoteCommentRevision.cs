using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Comments;

/// <summary>A counter a database trigger bumps on every change to a note's comments, so a watch can tell when to re-read.</summary>
public sealed class NoteCommentRevision
{
    /// <summary>Gets the tenant, carried for row-level security.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the note.</summary>
    public required ItemId ItemId { get; init; }

    /// <summary>Gets the revision. Only ever increases.</summary>
    public long Revision { get; init; }
}
