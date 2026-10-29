namespace Nix.Domain.Authorization;

/// <summary>
/// What a subject may do in a workspace they are a member of.
/// </summary>
/// <remarks>
/// <para>
/// <b>The numeric order is load-bearing.</b> Roles are totally ordered by capability, so "the
/// strongest of several grants" is a comparison rather than a table of pairs: a principal who is
/// both a viewer directly and an editor through a group is an editor. Anything inserted later must
/// be given a value that keeps the order true.
/// </para>
/// <para>
/// The stored representation is text, not this ordinal — see <see cref="WorkspaceRoles"/>. A
/// migration that renumbered the enum must not silently repermission every row in the database.
/// </para>
/// </remarks>
public enum WorkspaceRole
{
    /// <summary>May read items and their content, and nothing else.</summary>
    Viewer = 0,

    /// <summary>May read, and may comment without changing what is being commented on.</summary>
    /// <remarks>
    /// Comments on notes are the one thing this role adds: see <see cref="WorkspaceRoles.GrantsComment"/>.
    /// </remarks>
    Commenter = 1,

    /// <summary>May read and change items and their content.</summary>
    Editor = 2,

    /// <summary>May read, change, and administer the workspace's own membership.</summary>
    Owner = 3,
}

/// <summary>
/// Translates between <see cref="WorkspaceRole"/> and the text stored in <c>workspace_member.role</c>.
/// </summary>
/// <remarks>
/// <b>Parsing fails closed.</b> Role text this build does not recognise grants nothing rather than
/// throwing or defaulting to something usable. A database holding a role a newer version
/// introduced is the case that matters: an older instance still serving traffic must refuse the
/// grant it cannot understand, not guess at it. That is a denial, which is recoverable; the other
/// direction is not.
/// </remarks>
public static class WorkspaceRoles
{
    /// <summary>Reads a stored role.</summary>
    /// <param name="text">The stored text.</param>
    /// <param name="role">The role, when recognised.</param>
    /// <returns><see langword="true"/> when the text names a role this build knows.</returns>
    public static bool TryParse(string? text, out WorkspaceRole role)
    {
        switch (text)
        {
            case "owner":
                role = WorkspaceRole.Owner;
                return true;
            case "editor":
                role = WorkspaceRole.Editor;
                return true;
            case "commenter":
                role = WorkspaceRole.Commenter;
                return true;
            case "viewer":
                role = WorkspaceRole.Viewer;
                return true;
            default:
                role = default;
                return false;
        }
    }

    /// <summary>Writes a role for storage.</summary>
    /// <param name="role">The role.</param>
    /// <returns>The stored text.</returns>
    /// <exception cref="ArgumentOutOfRangeException">The role is not one this build defines.</exception>
    public static string ToText(WorkspaceRole role) => role switch
    {
        WorkspaceRole.Owner => "owner",
        WorkspaceRole.Editor => "editor",
        WorkspaceRole.Commenter => "commenter",
        WorkspaceRole.Viewer => "viewer",
        _ => throw new ArgumentOutOfRangeException(nameof(role), role, "Unknown workspace role."),
    };

    /// <summary>Whether a role permits changing items and their content.</summary>
    /// <param name="role">The role.</param>
    /// <returns><see langword="true"/> for an editor or an owner.</returns>
    /// <remarks>
    /// A commenter is deliberately not a writer. Commenting changes a conversation about a
    /// document; it does not change the document.
    /// </remarks>
    public static bool GrantsWrite(this WorkspaceRole role) => role >= WorkspaceRole.Editor;

    /// <summary>Whether a role permits commenting on notes.</summary>
    /// <param name="role">The role.</param>
    /// <returns><see langword="true"/> for a commenter, an editor or an owner.</returns>
    public static bool GrantsComment(this WorkspaceRole role) => role >= WorkspaceRole.Commenter;
}
